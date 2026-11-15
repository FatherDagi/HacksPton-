"""Gemini audio transcription. Uses the REST API so a station Python 3.9 install can run it."""

import base64
import json
import logging
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from string import Template

from app.cards import parse_model_json

log = logging.getLogger("desk.gemini")

DEFAULT_MODELS = ("gemini-3.5-flash", "gemini-3.8-flash")
WORDS = (
    "Transcribe the words spoken in this phone audio. "
    "Write only those words. No labels, no quotes, and no commentary. "
    "If nobody is speaking, write nothing."
)
SYSTEM = (
    "You write incident cards for a police dispatcher. "
    "You never invent a fact that was not spoken. You reply with JSON only."
)
PROMPT = Template(
    """$intro

Return a JSON object with exactly these keys:
- utterance: $utterance_rule
- priority: one of emergency, urgent, routine, unknown
- call_type: a short label such as "burglary in progress", "traffic crash", "disturbance", "suspicious person", "medical", "information". Empty if unknown.
- location: the place they stated, or null
- summary: one or two sentences of the facts stated on the whole call so far
- weapons: true only if a weapon was mentioned
- injuries: true only if an injury or a person down was mentioned
- suspect_on_scene: true only if a suspect or other involved person is reported still there
- units_suggested: a short list of unit types to send, such as "patrol", "supervisor", "traffic". Empty if you cannot tell yet.
- callback_number: a phone number they gave, or null

Priority rules:
- emergency: someone is being hurt, a crime is in progress, a weapon is involved, or a person is down
- urgent: it just happened, someone is still there, or a unit should go soon
- routine: a report after the fact, or a non-emergency request

This audio is the $speaker.

Call so far:
$transcript

Incident card so far:
$card
"""
)


class GeminiNotConfigured(RuntimeError):
    pass


class GeminiError(RuntimeError):
    def __init__(self, message, status=0):
        super(GeminiError, self).__init__(message)
        self.status = status


def redact(message):
    text = str(message)
    key = os.environ.get("GEMINI_API_KEY", "")
    if key:
        text = text.replace(key, "GEMINI_API_KEY")
    return re.sub(r"key=[A-Za-z0-9_\-]+", "key=REDACTED", text)


def build_prompt(speaker, context, full):
    context = context or {}
    if full:
        intro = "Transcribe this whole recording and fill the incident card."
        utterance_rule = (
            "the full transcript. Label speakers as Caller and Call-taker when you can tell them apart."
        )
    else:
        intro = "Transcribe this short clip from a live phone call and update the incident card."
        utterance_rule = "verbatim words in this clip only. Use an empty string if there is no speech."
    return PROMPT.substitute(
        intro=intro,
        utterance_rule=utterance_rule,
        speaker=speaker or "Caller",
        transcript=context.get("transcript") or "(nothing yet)",
        card=json.dumps(context.get("card") or {}),
    )


class GeminiClient(object):
    def __init__(self):
        self._chosen = os.environ.get("GEMINI_MODEL", "").strip() or None
        self._pinned = None
        self._lock = threading.Lock()
        self._thinking = True

    def stream_words(self, audio, mime, context, full=False, on_partial=None):
        if not os.environ.get("GEMINI_API_KEY", "").strip():
            raise GeminiNotConfigured(
                "Add GEMINI_API_KEY to the .env file and restart the desk."
            )
        prompt = _words_prompt(context, full)
        return self._generate_stream(audio, mime or "audio/wav", prompt, 120 if full else 40, on_partial)

    def extract_keywords(self, transcript):
        prompt = (
            "List the keywords a call-taker would mark in this transcript: "
            "places, injuries, weapons, vehicles, and what is happening. "
            "Use only words that were spoken. Return a JSON array of short strings.\n\n"
            + transcript[-4000:]
        )
        text = self._generate_text(prompt)
        return _keyword_list(text)

    def transcribe(self, audio, mime, speaker, context, full=False):
        if not os.environ.get("GEMINI_API_KEY", "").strip():
            raise GeminiNotConfigured(
                "Add GEMINI_API_KEY to the .env file and restart the desk."
            )
        prompt = build_prompt(speaker, context, full)
        text = self._generate(audio, mime or "audio/wav", prompt, 180 if full else 90)
        try:
            return parse_model_json(text)
        except ValueError:
            log.warning("Unreadable Gemini response: %s", text[:300])
            raise GeminiError("Gemini returned an unreadable incident card.")

    def _models(self):
        with self._lock:
            if self._pinned:
                return (self._pinned,)
        if self._chosen:
            return (self._chosen,)
        return DEFAULT_MODELS

    def _pin(self, model):
        if self._chosen:
            return
        with self._lock:
            self._pinned = model

    def _generate(self, audio, mime, prompt, timeout):
        last_error = None
        for model in self._models():
            try:
                text = self._call_model(model, audio, mime, prompt, timeout)
            except GeminiError as exc:
                last_error = exc
                if _missing_model(exc):
                    log.info("Gemini model %s is not available on this key", model)
                    continue
                raise
            self._pin(model)
            return text
        if last_error:
            raise last_error
        raise GeminiError("No Gemini model is configured.")

    def _generate_text(self, prompt):
        last_error = None
        body = _text_body(prompt, self._thinking)
        for model in self._models():
            try:
                text = self._post(model, body, 30)
            except GeminiError as exc:
                last_error = exc
                if self._thinking and _thinking_rejected(exc):
                    self._thinking = False
                    body = _text_body(prompt, False)
                    text = self._post(model, body, 30)
                    self._pin(model)
                    return text
                if _missing_model(exc):
                    log.info("Gemini model %s is not available on this key", model)
                    continue
                raise
            self._pin(model)
            return text
        if last_error:
            raise last_error
        raise GeminiError("No Gemini model is configured.")

    def _generate_stream(self, audio, mime, prompt, timeout, on_partial):
        last_error = None
        for model in self._models():
            try:
                text = self._stream_model(model, audio, mime, prompt, timeout, on_partial)
            except GeminiError as exc:
                last_error = exc
                if _missing_model(exc):
                    log.info("Gemini model %s is not available on this key", model)
                    continue
                raise
            self._pin(model)
            return text
        if last_error:
            raise last_error
        raise GeminiError("No Gemini model is configured.")

    def _stream_model(self, model, audio, mime, prompt, timeout, on_partial):
        try:
            return self._stream(model, _body(prompt, audio, mime, False, self._thinking, 512), timeout, on_partial)
        except GeminiError as exc:
            if self._thinking and _thinking_rejected(exc):
                self._thinking = False
                return self._stream(model, _body(prompt, audio, mime, False, False, 512), timeout, on_partial)
            if exc.status == 404:
                text = self._post(model, _body(prompt, audio, mime, False, False, 512), timeout)
                if on_partial and text:
                    on_partial(text)
                return text
            raise

    def _stream(self, model, body, timeout, on_partial):
        key = os.environ.get("GEMINI_API_KEY", "").strip()
        url = (
            "https://generativelanguage.googleapis.com/v1beta/models/{}:streamGenerateContent?alt=sse&key={}"
        ).format(urllib.parse.quote(model, safe=""), urllib.parse.quote(key, safe=""))
        request = urllib.request.Request(
            url,
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return _read_stream(response, on_partial)
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", "replace")
            raise GeminiError(redact(_friendly(exc.code, raw)), status=exc.code)
        except urllib.error.URLError as exc:
            raise GeminiError(redact("Could not reach Gemini: {}".format(exc.reason)))

    def _call_model(self, model, audio, mime, prompt, timeout):
        try:
            return self._post(model, _body(prompt, audio, mime, True), timeout)
        except GeminiError as exc:
            if exc.status == 400 and _json_mode_rejected(str(exc)):
                return self._post(model, _body(prompt, audio, mime, False), timeout)
            raise

    def _post(self, model, body, timeout):
        for attempt in (1, 2):
            try:
                return self._post_once(model, body, timeout)
            except GeminiError as exc:
                if attempt == 1 and exc.status in (429, 500, 503):
                    time.sleep(1.5)
                    continue
                raise

    def _post_once(self, model, body, timeout):
        key = os.environ.get("GEMINI_API_KEY", "").strip()
        url = (
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}"
        ).format(urllib.parse.quote(model, safe=""), urllib.parse.quote(key, safe=""))
        request = urllib.request.Request(
            url,
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", "replace")
            raise GeminiError(redact(_friendly(exc.code, raw)), status=exc.code)
        except urllib.error.URLError as exc:
            raise GeminiError(redact("Could not reach Gemini: {}".format(exc.reason)))
        return _text_from(payload)


def _words_prompt(context, full):
    context = context or {}
    previous = context.get("transcript") or ""
    if full:
        return WORDS + "\nTranscribe the whole recording."
    if previous and previous != "(nothing yet)":
        tail = " ".join(previous.split()[-12:])
        return WORDS + "\nAlready transcribed: " + tail + "\nWrite only the new words."
    return WORDS


def _text_body(prompt, thinking):
    return {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": _generation(False, thinking, 256),
    }


def _generation(json_mode, thinking, tokens):
    generation = {"temperature": 0, "maxOutputTokens": tokens}
    if json_mode:
        generation["responseMimeType"] = "application/json"
    if thinking:
        generation["thinkingConfig"] = {"thinkingBudget": 0}
    return generation


def _body(prompt, audio, mime, json_mode, thinking=True, tokens=512):
    return {
        "systemInstruction": {"parts": [{"text": SYSTEM}]},
        "contents": [
            {
                "role": "user",
                "parts": [
                    {"text": prompt},
                    {
                        "inlineData": {
                            "mimeType": mime,
                            "data": base64.b64encode(audio).decode("ascii"),
                        }
                    },
                ],
            }
        ],
        "generationConfig": _generation(json_mode, thinking, tokens),
    }


def _text_from(payload):
    candidates = payload.get("candidates") or []
    if not candidates:
        feedback = payload.get("promptFeedback") or {}
        reason = feedback.get("blockReason") or "no candidates"
        raise GeminiError("Gemini returned no transcript ({})".format(reason))
    parts = ((candidates[0].get("content") or {}).get("parts") or [])
    text = "\n".join(part.get("text", "") for part in parts if part.get("text")).strip()
    if not text:
        reason = candidates[0].get("finishReason") or "empty"
        raise GeminiError("Gemini returned no transcript ({})".format(reason))
    return text


def _friendly(status, raw):
    try:
        message = json.loads(raw).get("error", {}).get("message")
    except ValueError:
        message = None
    if not message:
        message = raw.strip().replace("\n", " ")[:300] or "Gemini request failed"
    return "Gemini error {}: {}".format(status, message)


def _missing_model(exc):
    if exc.status == 404:
        return True
    text = str(exc).lower()
    return "not found" in text or "not supported" in text or "no longer available" in text


def _json_mode_rejected(message):
    text = message.lower()
    return "response" in text and ("mime" in text or "json" in text)


def _thinking_rejected(exc):
    return exc.status == 400 and "thinking" in str(exc).lower()


def _visible_delta(payload):
    candidates = payload.get("candidates") or []
    if not candidates:
        return ""
    parts = ((candidates[0].get("content") or {}).get("parts") or [])
    bits = []
    for part in parts:
        if part.get("thought"):
            continue
        if part.get("text"):
            bits.append(part["text"])
    return "".join(bits)


def _read_stream(response, on_partial):
    collected = []
    for raw in response:
        line = raw.decode("utf-8", "replace").strip()
        if not line or line.startswith(":"):
            continue
        if line.startswith("data:"):
            line = line[5:].strip()
        if line in ("[DONE]", "null"):
            break
        if not line.startswith("{"):
            continue
        try:
            payload = json.loads(line)
        except ValueError:
            continue
        piece = _visible_delta(payload)
        if not piece:
            continue
        so_far = "".join(collected)
        if so_far and piece.startswith(so_far):
            collected = [piece]
        else:
            collected.append(piece)
        if on_partial:
            on_partial("".join(collected).strip())
    return "".join(collected).strip()


def _keyword_list(text):
    start = text.find("[")
    end = text.rfind("]")
    if start == -1 or end <= start:
        return []
    try:
        data = json.loads(text[start : end + 1])
    except ValueError:
        return []
    if not isinstance(data, list):
        return []
    words = []
    for item in data:
        cleaned = " ".join(str(item).split())
        if cleaned:
            words.append(cleaned)
        if len(words) == 16:
            break
    return words
