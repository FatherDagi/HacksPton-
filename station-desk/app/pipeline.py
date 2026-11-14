"""Turn phone frames and microphone audio into a live transcript."""

import array
import asyncio
import logging
import os
import time

from app.audio_util import RATE, mulaw_to_pcm16, resample_pcm16, wav_to_pcm16
from app.gemini_client import redact
from app.live import LiveSession
from app.languages import detect_language, gemini_language
from app.transcripts import find_keywords, keep_spoken, stitch_text, strip_overlap

log = logging.getLogger("desk.pipeline")

LIVE_RATE = 16000
LINE_PAUSE_S = 1.0  # start a new transcript line only after this much silence (or a speaker change)
TEXT_LAG_S = 0.7  # transcribed text arrives about this long after the words were spoken
VOICE_LEVEL = 400  # mean |sample| (16-bit) above which a chunk counts as speech rather than line noise


def _norm(text):
    return " ".join("".join(c.lower() if c.isalnum() else " " for c in str(text or "")).split())


def interpreter_on():
    """DESK_INTERPRETER=1: each side hears an AI spoken translation (the phones are not directly
    connected). Default off: the phones talk directly and the desk only listens and transcribes."""
    return os.environ.get("DESK_INTERPRETER", "").strip().lower() in ("1", "true", "yes", "on")


class Pipeline(object):
    def __init__(self, store, gemini, publish, play_for_desk=None, play_for_caller=None):
        self.store = store
        self.gemini = gemini
        self.publish = publish
        self.play_for_desk = play_for_desk
        self.play_for_caller = play_for_caller
        self.sessions = {}
        self.failed = set()
        self.queues = {}
        self.workers = {}
        self.caller_language = {}
        self.reply_buffer = {}
        # Line breaks come from the audio: a speaker's "utterance" ends after LINE_PAUSE_S of silence.
        self.voice = {}  # (call_id, speaker) -> {"last": t of last voiced audio, "uid": n, "starts": [(t, uid)]}
        # Each speaker keeps their own open line, so the other person talking over them (or phone bleed)
        # does not chop it up: (call_id, speaker) -> {"uid": utterance id, "index": transcript line index}
        self.open_line = {}

    async def add_phone_audio(self, call_id, track, payload):
        speaker = "Call-taker" if track == "outbound" else "Caller"
        pcm = resample_pcm16(mulaw_to_pcm16(payload), RATE, LIVE_RATE)
        await self.feed_pcm(call_id, speaker, pcm)

    async def feed_pcm(self, call_id, speaker, pcm):
        if not pcm:
            return
        self._note_audio(call_id, speaker, pcm)
        if not os.environ.get("GEMINI_API_KEY", "").strip():
            self._missing_key(call_id)
            return
        if not interpreter_on():
            # Listen-only: both people already hear each other. Transcribe both sides as English text
            # (translated if needed) right away; never hold back the call-taker's words.
            await self._send_session(call_id, speaker, pcm, "en", "english")
            return
        if speaker != "Caller" and call_id not in self.caller_language:
            buf = self.reply_buffer.setdefault(call_id, bytearray())
            if len(buf) < 16000 * 2 * 12:
                buf.extend(pcm)
            return
        if speaker != "Caller":
            await self._flush_reply(call_id)
        target = "en" if speaker == "Caller" else gemini_language(self.caller_language.get(call_id) or "en")
        text_from = "english" if speaker == "Caller" else "source"
        await self._send_session(call_id, speaker, pcm, target, text_from)

    async def enqueue(self, call_id, audio, mime, speaker):
        pcm = _pcm_from_clip(audio, mime)
        if pcm is None:
            await self.enqueue_file(call_id, audio, mime, speaker)
            return
        await self.feed_pcm(call_id, speaker, pcm)

    async def enqueue_file(self, call_id, audio, mime, speaker):
        if not audio:
            return
        pcm = _pcm_from_clip(audio, mime)
        if pcm is not None:
            await self.feed_pcm(call_id, speaker, pcm)
            return
        self._ensure_worker(call_id)
        self.store.add_pending(call_id, 1)
        await self.queues[call_id].put((audio, mime, speaker, True))
        await self._publish()

    async def close_audio(self, call_id):
        keys = [key for key in list(self.sessions) if key[0] == call_id]
        for key in keys:
            session = self.sessions.pop(key)
            try:
                await session.finish()
            except Exception:
                log.exception("live session failed while closing %s", call_id)
        self._keep_partial(call_id)
        task = self.workers.get(call_id)
        queue = self.queues.get(call_id)
        if queue is not None:
            await queue.put(None)
        if task is not None:
            try:
                await task
            except Exception:
                log.exception("transcription worker failed for %s", call_id)
        self.workers.pop(call_id, None)
        self.queues.pop(call_id, None)
        self.failed = set(key for key in self.failed if key[0] != call_id)
        self.reply_buffer.pop(call_id, None)
        self.caller_language.pop(call_id, None)
        for book in (self.voice, self.open_line):
            for key in [k for k in book if k[0] == call_id]:
                book.pop(key, None)

    async def _send_session(self, call_id, speaker, pcm, target, text_from):
        key = (call_id, speaker, target, text_from)
        if key in self.failed:
            return
        session = self.sessions.get(key)
        if session is None:
            session = self._open(call_id, speaker, target, text_from)
        elif not session.running():
            self.failed.add(key)
            self.store.set_error(call_id, "Live translation stopped. End the call and start another.")
            return
        accepted = await session.send(pcm)
        if not accepted:
            self.failed.add(key)
            self.store.set_error(call_id, "Live translation stopped. End the call and start another.")

    async def _flush_reply(self, call_id):
        pcm = bytes(self.reply_buffer.pop(call_id, b""))
        if not pcm:
            return
        language = gemini_language(self.caller_language.get(call_id) or "en")
        await self._send_session(call_id, "Call-taker", pcm, language, "source")

    async def _note_language(self, call_id, text):
        if call_id in self.caller_language:
            return
        code = detect_language(text)
        if not code:
            return
        self.caller_language[call_id] = code
        log.info("caller language for %s is %s", call_id, code)
        await self._flush_reply(call_id)
        await self._publish()

    def _open(self, call_id, speaker, target, text_from):
        key = (call_id, speaker, target, text_from)

        async def on_interim(text, call_id=call_id, speaker=speaker):
            await self._show(call_id, speaker, text, commit=False)

        async def on_final(text, call_id=call_id, speaker=speaker):
            await self._show(call_id, speaker, text, commit=True)

        async def on_error(message, call_id=call_id):
            self.failed.add(key)
            self.store.set_error(call_id, message)
            await self._publish()

        async def on_audio(pcm, rate, call_id=call_id, speaker=speaker):
            if not interpreter_on():
                return  # listen-only: never play AI audio into a direct call
            player = self.play_for_desk if speaker == "Caller" else self.play_for_caller
            if player and pcm:
                await player(call_id, pcm, rate)

        async def on_source(text, call_id=call_id, speaker=speaker):
            if speaker == "Caller":
                await self._note_language(call_id, text)

        session = LiveSession(
            on_interim,
            on_final,
            on_error,
            on_audio=on_audio,
            on_source=on_source,
            target_language=target,
            text_from=text_from,
        )
        self.sessions[key] = session
        return session

    def _note_audio(self, call_id, speaker, pcm):
        """Track voiced audio per speaker; speech after LINE_PAUSE_S of silence starts a new utterance."""
        samples = array.array("h", pcm[: len(pcm) - len(pcm) % 2])
        if not samples:
            return
        level = sum(abs(s) for s in samples[::4]) / len(samples[::4])
        v = self.voice.setdefault((call_id, speaker), {"last": None, "uid": 0, "starts": [], "floor": None})
        # Adapt to each line's background noise: speech must be well above the quietest recent level.
        v["floor"] = level if v["floor"] is None else min(level, v["floor"] + 3)
        if level < max(VOICE_LEVEL, v["floor"] * 3):
            return
        now = time.monotonic()
        if v["last"] is None or now - v["last"] >= LINE_PAUSE_S:
            v["uid"] += 1
            v["starts"].append((now, v["uid"]))
            del v["starts"][:-20]
        v["last"] = now

    def _utterance_for_text(self, call_id, speaker):
        """Which utterance a phrase arriving now belongs to (text lags the audio by about TEXT_LAG_S)."""
        v = self.voice.get((call_id, speaker))
        if not v or not v["starts"]:
            return 0
        at = time.monotonic() - TEXT_LAG_S
        uid = v["starts"][0][1]
        for t, n in v["starts"]:
            if t <= at:
                uid = n
        return uid

    async def _show(self, call_id, speaker, text, commit):
        call = self.store.get_call(call_id)
        last = ""
        if call and call["transcript"]:
            last = call["transcript"][-1]["text"]
        fresh = strip_overlap(last, text)
        if not fresh:
            if commit:
                self.store.clear_partial(call_id)
                await self._publish()
            return
        if commit:
            uid = self._utterance_for_text(call_id, speaker)
            lines = (call or {}).get("transcript") or []
            ol = self.open_line.get((call_id, speaker))
            # Keep adding to this speaker's line while they haven't paused for LINE_PAUSE_S, even if the
            # other person said something in between (only a few lines back, so order stays readable).
            same = (
                ol is not None and ol["uid"] == uid and ol["index"] < len(lines)
                and lines[ol["index"]]["speaker"] == speaker and len(lines) - 1 - ol["index"] <= 3
            )
            if same:
                current = lines[ol["index"]]["text"]
                if _norm(text).startswith(_norm(current)):
                    # The model re-sent the whole line with more words: replace it instead of repeating it.
                    self.store.update_line(call_id, ol["index"], speaker, " ".join(text.split()))
                else:
                    extra = strip_overlap(current, text)
                    if extra:
                        self.store.update_line(call_id, ol["index"], speaker, current + " " + extra)
                index = ol["index"]
            else:
                written = self.store.append_line(call_id, speaker, text)
                index = len((written or {}).get("transcript") or lines) - 1
            self.open_line[(call_id, speaker)] = {"uid": uid, "index": index}
            asyncio.create_task(self._refine_keywords(call_id))
        else:
            self.store.set_partial(call_id, speaker, fresh)
        await self._publish()

    def _keep_partial(self, call_id):
        call = self.store.get_call(call_id)
        partial = call.get("partial") if call else None
        if not partial or not partial.get("text"):
            return
        self.store.append_line(call_id, partial.get("speaker") or "Caller", partial["text"])

    def _missing_key(self, call_id):
        call = self.store.get_call(call_id)
        if call and call.get("last_error"):
            return
        self.store.set_error(call_id, "Add GEMINI_API_KEY to the .env file and restart the desk.")

    def _ensure_worker(self, call_id):
        if call_id not in self.queues:
            self.queues[call_id] = asyncio.Queue()
        task = self.workers.get(call_id)
        if task is None or task.done():
            self.workers[call_id] = asyncio.create_task(self._worker(call_id))

    async def _worker(self, call_id):
        """Whole recordings still go through a file transcription."""
        queue = self.queues[call_id]
        while True:
            item = await queue.get()
            if item is None:
                return
            audio, mime, speaker, full = item
            try:
                context = self.store.context(call_id)
                text = await asyncio.to_thread(
                    self.gemini.stream_words, audio, mime, context, full, None
                )
                if text and text.strip():
                    self.store.append_line(call_id, speaker, text)
                    asyncio.create_task(self._refine_keywords(call_id))
                log.info("transcribed file for call %s (%s bytes)", call_id, len(audio))
            except Exception as exc:
                message = redact(exc)
                log.warning("call %s: %s", call_id, message)
                self.store.set_error(call_id, message)
            finally:
                self.store.add_pending(call_id, -1)
                await self._publish()

    async def _refine_keywords(self, call_id):
        call = self.store.get_call(call_id)
        if not call or not call["transcript"]:
            return
        spoken = stitch_text([line["text"] for line in call["transcript"]])
        try:
            extra = await asyncio.to_thread(self.gemini.extract_keywords, spoken)
        except Exception as exc:
            log.info("keyword pass skipped: %s", redact(exc))
            extra = []
        fresh = self.store.get_call(call_id)
        if not fresh:
            return
        chunks = [line["text"] for line in fresh["transcript"]]
        if fresh.get("partial") and fresh["partial"].get("text"):
            chunks.append(fresh["partial"]["text"])
        spoken = stitch_text(chunks)
        keywords = keep_spoken(spoken, find_keywords(chunks) + (fresh.get("keywords") or []) + extra)
        self.store.set_keywords(call_id, keywords)
        await self._publish()

    async def _publish(self):
        try:
            await self.publish()
        except Exception:
            log.exception("could not update the console")


def _pcm_from_clip(audio, mime):
    if not audio:
        return None
    if audio.startswith(b"RIFF"):
        pcm, rate = wav_to_pcm16(audio)
        if not pcm:
            return None
        return resample_pcm16(pcm, rate, LIVE_RATE)
    if mime and "pcm" in mime:
        return audio
    return None
