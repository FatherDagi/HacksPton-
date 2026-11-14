"""Gemini Live transcription.

The desk keeps one session open per speaker and streams 16 kHz PCM.
Interim text is the phrase in progress. The final text is the cleaned line.
"""

import base64
import json
import logging
import os
import re

from app.gemini_client import GeminiError, GeminiNotConfigured, redact

log = logging.getLogger("desk.live")

LIVE_MODEL = "gemini-3.5-transcribe-live"
TRANSLATE_MODEL = "gemini-3.5-live-translate-preview"
FRAME_BYTES = 3200
WS_URL = (
    "wss://generativelanguage.googleapis.com/ws/"
    "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key={}"
)


def translation_setups(target_language):
    """Prefer live translation into the requested language, then plain transcription."""
    chosen = os.environ.get("GEMINI_LIVE_MODEL", "").strip()
    target = target_language or "en"
    if chosen:
        if "transcribe" in chosen and "translate" not in chosen:
            return [transcribe_setup(chosen)]
        return [translate_setup(chosen, target)]
    return [translate_setup(TRANSLATE_MODEL, target), transcribe_setup(LIVE_MODEL)]


def transcribe_setup(model):
    return {
        "setup": {
            "model": "models/" + model,
            "generationConfig": {"responseModalities": ["TEXT"]},
            "inputAudioTranscription": {
                "languageCodes": ["en-US"],
                "mode": "SMART",
            },
            "realtimeInputConfig": {
                "automaticActivityDetection": {
                    "startOfSpeechSensitivity": "START_SENSITIVITY_HIGH",
                    "endOfSpeechSensitivity": "END_SENSITIVITY_HIGH",
                    "prefixPaddingMs": 80,
                    "silenceDurationMs": 400,
                }
            },
        }
    }


def translate_setup(model, target_language="en"):
    # Echo when the speaker is already using the target language, so an English
    # caller still produces English audio and an English transcript.
    return {
        "setup": {
            "model": "models/" + model,
            "generationConfig": {
                "responseModalities": ["AUDIO"],
                "translationConfig": {
                    "targetLanguageCode": target_language or "en",
                    "echoTargetLanguage": True,
                },
            },
            "inputAudioTranscription": {},
            "outputAudioTranscription": {},
        }
    }


def parse_live_message(raw):
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", "replace")
    try:
        message = json.loads(raw)
    except ValueError:
        return {}
    error = message.get("error")
    if error:
        text = error.get("message") if isinstance(error, dict) else str(error)
        return {"error": text or "Gemini live session failed."}
    if "setupComplete" in message:
        return {"setup": True}
    content = message.get("serverContent") or message.get("server_content") or {}
    interim = _text(content, "interimInputTranscription", "interim_input_transcription")
    final = _text(content, "inputTranscription", "input_transcription")
    english = _text(content, "outputTranscription", "output_transcription")
    interim_english = _text(content, "interimOutputTranscription", "interim_output_transcription")
    parsed = {}
    if interim:
        parsed["interim"] = interim
    if final:
        parsed["final"] = final
    if english:
        parsed["english"] = english
    if interim_english:
        parsed["interim_english"] = interim_english
    audio = _audio_parts(content)
    if audio:
        parsed["audio"] = audio
    return parsed


def audio_message(pcm):
    return json.dumps({
        "realtimeInput": {
            "audio": {
                "mimeType": "audio/pcm;rate=16000",
                "data": base64.b64encode(pcm).decode("ascii"),
            }
        }
    })


def stream_end_message():
    return json.dumps({"realtimeInput": {"audioStreamEnd": True}})


def _audio_parts(content):
    turn = content.get("modelTurn") or content.get("model_turn") or {}
    parts = turn.get("parts") or []
    chunks = []
    for part in parts:
        inline = part.get("inlineData") or part.get("inline_data") or {}
        data = inline.get("data")
        if not data:
            continue
        try:
            pcm = base64.b64decode(data)
        except Exception:
            continue
        if not pcm:
            continue
        rate = 24000
        mime = str(inline.get("mimeType") or inline.get("mime_type") or "")
        found = re.search(r"rate=(\d+)", mime)
        if found:
            rate = int(found.group(1))
        chunks.append({"pcm": pcm, "rate": rate})
    return chunks


def _text(content, *names):
    for name in names:
        block = content.get(name) or {}
        if isinstance(block, dict):
            text = " ".join(str(block.get("text") or "").split())
            if text:
                return text
    return ""


class LiveSession(object):
    """One open Gemini Live socket. Created on a running event loop."""

    def __init__(self, on_interim, on_final, on_error, on_audio=None, on_source=None, target_language="en", text_from="english"):
        import asyncio

        self._asyncio = asyncio
        self.on_interim = on_interim
        self.on_final = on_final
        self.on_error = on_error
        self.on_audio = on_audio
        self.on_source = on_source
        self.text_from = text_from or "english"
        self._setups = translation_setups(target_language)
        self._queue = asyncio.Queue()
        self._task = asyncio.create_task(self._run())
        self._last_interim = ""
        self._closed = False

    def running(self):
        return self._task is not None and not self._task.done()

    async def send(self, pcm):
        if not pcm or not self.running():
            return False
        await self._queue.put(pcm)
        return True

    async def finish(self):
        if self._task is None:
            return
        if not self._task.done():
            await self._queue.put(None)
            try:
                await self._asyncio.wait_for(self._task, 8)
            except self._asyncio.TimeoutError:
                self._task.cancel()
        self._closed = True

    async def _run(self):
        last_error = None
        for setup in self._setups:
            try:
                await self._speak(setup)
                return
            except _TryNext as exc:
                last_error = exc
                log.info("live model unavailable, trying the next one")
                continue
            except Exception as exc:
                await self._fail(exc)
                return
        await self._fail(last_error or GeminiError("Gemini live transcription did not start."))

    async def _speak(self, setup):
        import websockets

        key = os.environ.get("GEMINI_API_KEY", "").strip()
        if not key:
            raise GeminiNotConfigured("Add GEMINI_API_KEY to the .env file and restart the desk.")
        url = WS_URL.format(key)
        try:
            connection = await websockets.connect(
                url, open_timeout=12, close_timeout=2, max_size=8 * 1024 * 1024
            )
        except Exception as exc:
            message = redact(exc)
            if _missing_model(message):
                raise _TryNext(message)
            raise GeminiError(message)
        try:
            await connection.send(json.dumps(setup))
            raw = await self._asyncio.wait_for(connection.recv(), 12)
            parsed = parse_live_message(raw)
            if parsed.get("error"):
                if _missing_model(parsed["error"]):
                    raise _TryNext(parsed["error"])
                raise GeminiError(redact(parsed["error"]))
            if not parsed.get("setup"):
                raise GeminiError("Gemini live session did not start.")
            sender = self._asyncio.create_task(self._pump(connection))
            try:
                while True:
                    if sender.done():
                        try:
                            raw = await self._asyncio.wait_for(connection.recv(), 3)
                        except (self._asyncio.TimeoutError, websockets.ConnectionClosed):
                            break
                    else:
                        try:
                            raw = await connection.recv()
                        except websockets.ConnectionClosed:
                            raise GeminiError("Gemini live session closed before the transcript finished.")
                    parsed = parse_live_message(raw)
                    await self._apply(parsed)
                    if sender.done() and (parsed.get("final") or parsed.get("english")):
                        break
            finally:
                if not sender.done():
                    sender.cancel()
                elif not sender.cancelled():
                    problem = sender.exception()
                    if problem:
                        raise problem
        except _TryNext:
            raise
        except GeminiError:
            raise
        except Exception as exc:
            message = redact(exc)
            if _missing_model(message):
                raise _TryNext(message)
            raise GeminiError(message)
        finally:
            await connection.close()

    async def _pump(self, connection):
        pending = bytearray()
        while True:
            item = await self._queue.get()
            if item is None:
                if pending:
                    await connection.send(audio_message(bytes(pending)))
                await connection.send(stream_end_message())
                return
            pending.extend(item)
            while len(pending) >= FRAME_BYTES:
                await connection.send(audio_message(bytes(pending[:FRAME_BYTES])))
                del pending[:FRAME_BYTES]

    async def _apply(self, parsed):
        if not parsed:
            return
        if parsed.get("error"):
            await self.on_error(redact(parsed["error"]))
            return
        for chunk in parsed.get("audio") or []:
            if self.on_audio:
                await self.on_audio(chunk.get("pcm") or b"", chunk.get("rate") or 24000)
        source = parsed.get("final") or parsed.get("interim")
        if source and self.on_source:
            await self.on_source(source)
        if self.text_from == "source":
            final = parsed.get("final")
            interim = parsed.get("interim")
        else:
            final = parsed.get("english") or _english_source(parsed.get("final"))
            interim = parsed.get("interim_english") or _english_source(parsed.get("interim"))
        if final:
            self._last_interim = ""
            await self.on_final(final)
            return
        if interim and interim != self._last_interim:
            self._last_interim = interim
            await self.on_interim(interim)

    async def _fail(self, exc):
        message = redact(exc)
        log.warning("live transcription: %s", message)
        try:
            await self.on_error(message)
        except Exception:
            log.exception("could not record the live transcription error")


def _english_source(text):
    """Use the original words only when they are already English."""
    from app.languages import detect_language

    if not text:
        return ""
    if detect_language(text) == "en":
        return text
    return ""


class _TryNext(GeminiError):
    pass


def _missing_model(message):
    text = str(message).lower()
    return (
        "not found" in text
        or "not supported" in text
        or "no longer available" in text
        or "unknown model" in text
    )
