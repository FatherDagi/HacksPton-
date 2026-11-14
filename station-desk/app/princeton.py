"""Princeton campus places, matched against a spoken transcript."""

import os
import re

SKIP = {
    "athletics",
    "transportation",
    "upperclass housing",
    "graduate housing",
    "student residences",
    "campus directory",
    "destinations",
    "auditoriums:",
    "princeton",
    "university",
}
BLOCKED_WORD = {
    "admission",
    "affairs",
    "airport",
    "alumni",
    "association",
    "athletic",
    "athletics",
    "avenue",
    "bridge",
    "building",
    "center",
    "centre",
    "chapel",
    "club",
    "college",
    "communications",
    "community",
    "court",
    "development",
    "drive",
    "employment",
    "field",
    "fields",
    "fine",
    "little",
    "financial",
    "friend",
    "garden",
    "graduate",
    "green",
    "gymnasium",
    "hall",
    "health",
    "house",
    "housing",
    "information",
    "lane",
    "library",
    "museum",
    "nassau",
    "office",
    "parking",
    "place",
    "pool",
    "princeton",
    "prospect",
    "public",
    "regional",
    "research",
    "rink",
    "road",
    "safety",
    "school",
    "services",
    "stadium",
    "station",
    "street",
    "student",
    "students",
    "taxi",
    "theatre",
    "theater",
    "tower",
    "track",
    "train",
    "university",
    "visitor",
}
PLACE_WORD = (
    "hall",
    "library",
    "center",
    "centre",
    "house",
    "college",
    "laboratory",
    "lab",
    "school",
    "chapel",
    "theatre",
    "theater",
    "gymnasium",
    "stadium",
    "rink",
    "pool",
    "field",
    "tower",
    "pavilion",
    "apartments",
    "garage",
    "station",
    "museum",
    "building",
    "club",
    "green",
    "bridge",
    "observatory",
    "boathouse",
    "plant",
    "quadrangle",
    "inn",
    "books",
    "hub",
    "brasserie",
    "kitchen",
)
_GRID = re.compile(r"(?:[A-Z]\d{1,2}|\(not shown\))\s*$")
_CATALOG = os.path.join(os.path.dirname(__file__), "princeton_places.txt")


def _norm(text):
    text = text.lower().replace("&", " and ")
    text = text.replace("'", "")
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return " ".join(text.split())


def _tidy(text):
    text = re.sub(r"\s*\([^)]*\)", "", text)
    text = re.sub(r"\s+", " ", text).strip(" ,")
    return text


def _complete(text):
    if text.rstrip().endswith(";"):
        return False
    return bool(_GRID.search(text.strip()))


def _strip_grid(text):
    text = re.sub(r"\s*\(not shown\)\s*$", "", text.strip())
    text = re.sub(r",?\s*[A-Z]\d{1,2}\s*$", "", text)
    return text.strip(" ,")


def _place_like(text):
    if re.match(r"\d", text):
        return True
    lowered = text.lower()
    for word in PLACE_WORD:
        if re.search(r"\b" + word + r"\b", lowered):
            return True
    return False


def _choose_display(parts):
    for part in parts:
        if re.match(r"\d", part):
            return _tidy(part)
    ranked = [part for part in parts if _place_like(part)]
    if ranked:
        ranked.sort(key=len, reverse=True)
        return _tidy(ranked[0])
    if parts:
        return _tidy(parts[-1])
    return ""


def _entries(raw):
    entries = []
    buf = ""
    for raw_line in raw.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if len(line) == 1 and line.isalpha():
            if buf:
                entries.append(buf)
                buf = ""
            continue
        if line.lower() in SKIP:
            if buf:
                entries.append(buf)
                buf = ""
            continue
        letters = re.sub(r"[^A-Za-z]", "", line)
        if letters.isupper() and letters.endswith("COLLEGE"):
            if buf:
                entries.append(buf)
                buf = ""
            entries.append(line.title())
            continue
        if letters.isupper() and " " in line:
            if buf:
                entries.append(buf)
                buf = ""
            continue
        buf = (buf + " " + line).strip() if buf else line
        if _complete(buf):
            entries.append(buf)
            buf = ""
    if buf:
        entries.append(buf)
    return entries


def _aliases(entry):
    found = []
    for chunk in entry.split(";"):
        cleaned = _strip_grid(chunk)
        if not cleaned:
            continue
        raw_parts = [part.strip() for part in cleaned.split(",") if part.strip()]
        parts = [_tidy(part) for part in raw_parts if _tidy(part)]
        display = _choose_display(parts)
        if not display:
            continue
        phrases = []
        phrases.append((_norm(display), display))
        for part in raw_parts:
            label = _tidy(part)
            key = _norm(label)
            if key:
                target = label if _place_like(label) else display
                phrases.append((key, target))
            for note in re.findall(r"\(([^)]+)\)", part):
                note_key = _norm(note)
                if note_key:
                    phrases.append((note_key, display))
        whole = _norm(_tidy(cleaned))
        if whole:
            phrases.append((whole, display))
        found.extend(phrases)
    return found


def load_places(path=None):
    with open(path or _CATALOG) as handle:
        raw = handle.read()
    pairs = []
    for entry in _entries(raw):
        pairs.extend(_aliases(entry))
    note_words = set()
    for key, display in pairs:
        if " " not in key and _norm(display) != key:
            note_words.add(key)
    first_words = {}
    for key, display in pairs:
        word = key.split()[0]
        if " " not in key or len(word) < 5 or word in BLOCKED_WORD or word in note_words:
            continue
        first_words.setdefault(word, set()).add(display)
    for word, displays in first_words.items():
        if len(displays) == 1:
            pairs.append((word, list(displays)[0]))
    owners = {}
    for key, display in pairs:
        if " " in key:
            continue
        if key in BLOCKED_WORD or len(key) < 5:
            continue
        owners.setdefault(key, set()).add(display)
    places = []
    seen = set()
    for key, display in pairs:
        single = " " not in key
        if single and len(key) < 5 and _norm(display) != key:
            continue
        if single and len(owners.get(key, ())) > 1:
            continue
        if single and key in BLOCKED_WORD and _norm(display) != key:
            continue
        if single and key not in BLOCKED_WORD and _norm(display) != key and len(owners.get(key, ())) != 1:
            continue
        marker = (key, display)
        if marker in seen:
            continue
        seen.add(marker)
        places.append((key, display))
    places.sort(key=lambda item: len(item[0]), reverse=True)
    return places


PLACES = load_places()


def match_princeton(text):
    if not text:
        return None
    hits = []
    for key, display in PLACES:
        pattern = r"\b" + re.escape(key).replace(r"\ ", r"\s+") + r"\b"
        for match in re.finditer(pattern, text, re.IGNORECASE):
            if " " not in key and not match.group(0)[:1].isupper():
                continue
            hits.append((match.start(), match.end(), display, len(key)))
    hits.sort(key=lambda item: (-item[3], item[0]))
    chosen = []
    spans = []
    for start, end, display, _length in hits:
        if any(start < span_end and end > span_start for span_start, span_end in spans):
            continue
        spans.append((start, end))
        chosen.append((start, display))
    if not chosen:
        return None
    chosen.sort()
    return chosen[0][1]
