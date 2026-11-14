"""Princeton place names: fix how speech-to-text spells them in the transcript.

Reads data/princeton-places.json (built by scripts/build_places.py from OpenStreetMap plus curated
campus aliases). Any phrase that is a known way of saying a place ("first campus center", "e quad",
"fire stone") is replaced with the place's proper name. Close misspellings of multi-word names
("Jadwen Gymnasium") are fixed too. One-word everyday names are never matched on their own.
"""
import difflib
import json
import os
import re

PLACES_PATH = os.environ.get(
    "DESK_PLACES",
    os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "data", "princeton-places.json"),
)
MAX_WORDS = 6
FUZZY_MIN_CHARS = 10
FUZZY_RATIO = 0.88


def _norm(s):
    return " ".join(re.sub(r"[^a-z0-9]+", " ", str(s).lower()).split())


def _load():
    try:
        with open(PLACES_PATH, encoding="utf-8") as f:
            places = json.load(f)["places"]
    except (OSError, ValueError, KeyError):
        return {}, {}
    phrases = {}  # normalized phrase -> proper name as written in a transcript
    for p in places:
        spoken = re.sub(r"\s*\([^)]*\)", "", p["name"]).strip()  # "Princeton Station (Dinky)" -> "Princeton Station"
        for phrase in p.get("match", []):
            if phrase.startswith("the "):
                phrase = phrase[4:]  # "the" stays in the sentence; match what follows it
            phrases.setdefault(phrase, spoken)
    by_len = {}
    for phrase in phrases:
        by_len.setdefault(len(phrase.split()), []).append(phrase)
    return phrases, by_len


PHRASES, BY_LEN = _load()
_WORD = re.compile(r"[A-Za-z0-9]+(?:['’\-][A-Za-z0-9]+)*")


def correct_places(text):
    """Return text with place names spelled the way the campus spells them."""
    if not text or not PHRASES:
        return text
    words = list(_WORD.finditer(text))
    out, cursor, i = [], 0, 0
    while i < len(words):
        hit = None
        for n in range(min(MAX_WORDS, len(words) - i), 0, -1):
            span = words[i : i + n]
            key = _norm(" ".join(w.group(0) for w in span))
            name = PHRASES.get(key)
            if name is None and n >= 2 and len(key) >= FUZZY_MIN_CHARS:
                close = difflib.get_close_matches(key, BY_LEN.get(len(key.split()), []), n=1, cutoff=FUZZY_RATIO)
                name = PHRASES[close[0]] if close else None
            if name:
                hit = (span[0].start(), span[-1].end(), name, n)
                break
        if hit:
            start, end, name, n = hit
            out.append(text[cursor:start])
            out.append(name)
            cursor = end
            i += n
        else:
            i += 1
    out.append(text[cursor:])
    return "".join(out)
