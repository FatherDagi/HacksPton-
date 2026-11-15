"""Incident cards. Later audio can add facts; it cannot quietly erase them."""

import json
import re

PRIORITY_RANK = {"unknown": 0, "routine": 1, "urgent": 2, "emergency": 3}
PRIORITY_ALIASES = {
    "high": "emergency",
    "critical": "emergency",
    "1": "emergency",
    "priority 1": "emergency",
    "medium": "urgent",
    "2": "urgent",
    "low": "routine",
    "3": "routine",
    "non-emergency": "routine",
    "nonemergency": "routine",
}
EMPTY_WORDS = {"", "null", "none", "unknown", "n/a", "na", "not stated", "not given"}
SILENCE_WORDS = {"", "null", "silence", "[silence]", "(silence)", "no speech", "[no speech]", "none"}


def empty_card():
    return {
        "priority": "unknown",
        "call_type": "",
        "location": None,
        "summary": "",
        "weapons": False,
        "injuries": False,
        "suspect_on_scene": False,
        "units_suggested": [],
        "callback_number": None,
    }


def parse_model_json(text):
    raw = (text or "").strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
    start = raw.find("{")
    end = raw.rfind("}")
    if start == -1 or end == -1 or end < start:
        raise ValueError("Gemini did not return an incident card")
    data = json.loads(raw[start : end + 1])
    if not isinstance(data, dict):
        raise ValueError("Gemini returned a list, not an incident card")
    return data


def utterance_text(data, limit=8000):
    text = " ".join(str(data.get("utterance") or "").split())
    if text.lower() in SILENCE_WORDS:
        return ""
    return text[:limit]


def _clip(value, limit):
    text = " ".join(str(value).split())
    return text[:limit]


def _clean(value, limit):
    if value is None:
        return None
    text = _clip(value, limit)
    if text.lower() in EMPTY_WORDS:
        return None
    return text


def _as_bool(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in {"true", "yes", "1"}
    return False


def _priority(value):
    text = " ".join(str(value or "").lower().split())
    text = PRIORITY_ALIASES.get(text, text)
    if text not in PRIORITY_RANK:
        return "unknown"
    return text


def merge_card(previous, update):
    prev = previous or {}
    update = update or {}
    old = _priority(prev.get("priority"))
    new = _priority(update.get("priority"))
    if PRIORITY_RANK[new] < PRIORITY_RANK[old]:
        new = old

    units = update.get("units_suggested") or []
    if isinstance(units, str):
        units = [units]
    if not isinstance(units, list):
        units = []
    cleaned_units = []
    for unit in units:
        text = _clip(unit, 40)
        if text and text.lower() not in EMPTY_WORDS:
            cleaned_units.append(text)
        if len(cleaned_units) == 4:
            break
    if not cleaned_units:
        cleaned_units = list(prev.get("units_suggested") or [])

    summary = _clip(update.get("summary") or "", 800)
    if not summary:
        summary = prev.get("summary") or ""
    call_type = _clip(update.get("call_type") or "", 80)
    if not call_type or call_type.lower() in EMPTY_WORDS:
        call_type = prev.get("call_type") or ""

    return {
        "priority": new,
        "call_type": call_type,
        "location": _clean(update.get("location"), 200) or _clean(prev.get("location"), 200),
        "summary": summary,
        "weapons": _as_bool(prev.get("weapons")) or _as_bool(update.get("weapons")),
        "injuries": _as_bool(prev.get("injuries")) or _as_bool(update.get("injuries")),
        "suspect_on_scene": _as_bool(prev.get("suspect_on_scene")) or _as_bool(update.get("suspect_on_scene")),
        "units_suggested": cleaned_units,
        "callback_number": _clean(update.get("callback_number"), 40) or _clean(prev.get("callback_number"), 40),
    }
