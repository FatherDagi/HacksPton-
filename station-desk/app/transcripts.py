"""Transcript text, keyword marking, and the saved text file."""

import os
import re
from datetime import datetime, timezone

TERMS = (
    "gun",
    "knife",
    "weapon",
    "shot",
    "shooting",
    "stab",
    "stabbed",
    "blood",
    "bleeding",
    "unconscious",
    "passed out",
    "pass out",
    "overdose",
    "fire",
    "dying",
    "dead",
    "injured",
    "injury",
    "accident",
    "crash",
    "robbery",
    "burglary",
    "break-in",
    "breaking in",
    "assault",
    "fight",
    "ambulance",
    "hospital",
    "police",
)
SKIP_PLACES = {
    "uh",
    "um",
    "the",
    "a",
    "an",
    "my",
    "our",
    "his",
    "her",
    "their",
    "this",
    "that",
    "home",
    "work",
}


def stitch_text(chunks):
    """Join slices that were cut in the middle of a word."""
    parts = []
    for chunk in chunks:
        text = " ".join(str(chunk or "").split())
        if not text:
            continue
        if parts and parts[-1].endswith("...") and text[:1].islower():
            parts[-1] = parts[-1][:-3] + text
        elif parts and parts[-1].endswith("-") and text[:1].islower():
            parts[-1] = parts[-1][:-1] + text
        else:
            parts.append(text)
    return " ".join(parts)


def strip_overlap(previous, new):
    previous_words = str(previous or "").split()
    new_words = str(new or "").split()
    if not new_words:
        return ""
    limit = min(8, len(previous_words), len(new_words))
    for size in range(limit, 0, -1):
        left = [word.lower().strip(".,") for word in previous_words[-size:]]
        right = [word.lower().strip(".,") for word in new_words[:size]]
        if left == right:
            return " ".join(new_words[size:]).strip()
    return " ".join(new_words).strip()


def find_keywords(text):
    spoken = stitch_text([text]) if isinstance(text, str) else stitch_text(text)
    lowered = spoken.lower()
    found = []
    for term in TERMS:
        if term in lowered and term not in found:
            found.append(term)
    for match in re.finditer(r"\bat\s+(?:(?:uh|um)\s+)?([A-Za-z][A-Za-z0-9'\-]{2,})", spoken):
        word = match.group(1)
        if word.lower() in SKIP_PLACES:
            continue
        if word.lower() not in [item.lower() for item in found]:
            found.append(word)
    return found[:16]


REPORT_TYPES = (
    (("shooting", "shot"), "Shooting"),
    (("stabbed", "stab", "knife"), "Stabbing"),
    (("gun", "weapon"), "Weapon"),
    (("robbery",), "Robbery"),
    (("burglary", "break-in", "breaking in"), "Burglary"),
    (("crash", "accident"), "Traffic crash"),
    (("assault", "fight"), "Assault"),
    (("fire",), "Fire"),
    (
        ("passed out", "pass out", "knocked out", "unconscious", "overdose", "injured", "injury", "bleeding", "ambulance", "dying", "dead"),
        "Medical",
    ),
)
PLACE_INTRO = re.compile(
    r"\b(?:at|on|near|outside|by|around|up|inside|corner of|intersection of)\s+(?:(?:uh|um|the)\s+)?",
    re.IGNORECASE,
)
PLACE_NAME = re.compile(
    r"\b([A-Z][A-Za-z0-9'-]*(?:\s+[A-Z][A-Za-z0-9'-]*){0,3}\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Court|Ct|Place|Pl|Highway|Hwy|Hall|Park|Plaza|Center|Centre|School|Hospital|Station))\b"
)
GENERIC_PLACE = {
    "street",
    "road",
    "time",
    "same",
    "here",
    "there",
    "now",
    "right",
    "way",
    "place",
    "side",
    "area",
    "one",
    "today",
    "tonight",
    "tomorrow",
    "later",
    "back",
    "over",
    "down",
    "out",
    "in",
}
PLACE_STOP = {
    "a",
    "an",
    "my",
    "our",
    "his",
    "her",
    "their",
    "we",
    "i",
    "me",
    "he",
    "she",
    "they",
    "it",
    "is",
    "was",
    "are",
    "were",
    "friend",
    "someone",
    "somebody",
    "with",
    "for",
    "to",
    "from",
    "because",
    "who",
    "that",
    "this",
    "uh",
    "um",
}


def _has_phrase(text, phrase):
    if " " in phrase or "-" in phrase:
        return phrase in text
    return re.search(r"\b" + re.escape(phrase) + r"\b", text) is not None


def derive_report_type(text):
    spoken = stitch_text([text]) if isinstance(text, str) else stitch_text(text)
    lowered = spoken.lower()
    for phrases, label in REPORT_TYPES:
        for phrase in phrases:
            if _has_phrase(lowered, phrase):
                return label
    return "Unknown"


def _clean_token(word):
    return word.strip(".,!?;:\"'")


def _place_phrase(words):
    kept = []
    index = 0
    while index < len(words) and len(kept) < 8:
        token = _clean_token(words[index])
        if not token:
            break
        lower = token.lower()
        if lower == "and":
            nxt = _clean_token(words[index + 1]) if index + 1 < len(words) else ""
            if not kept or not nxt or nxt.lower() in PLACE_STOP or nxt.lower() in SKIP_PLACES:
                break
            kept.append("and")
            index += 1
            continue
        if lower in PLACE_STOP or lower in SKIP_PLACES:
            break
        kept.append(token)
        index += 1
    while kept and kept[-1].lower() == "and":
        kept.pop()
    return " ".join(kept)


def _useful_place(phrase):
    words = phrase.split()
    if not words:
        return False
    if all(word.lower().strip(".,") in GENERIC_PLACE or word.lower().strip(".,") in PLACE_STOP for word in words):
        return False
    if re.search(r"\d", phrase):
        return True
    if PLACE_NAME.search(phrase):
        return True
    named = [word for word in words if word[:1].isupper() and word.lower() not in GENERIC_PLACE]
    return len(named) > 0


def derive_location(text):
    spoken = stitch_text([text]) if isinstance(text, str) else stitch_text(text)
    from app.princeton import match_princeton

    named = match_princeton(spoken)
    if named:
        return named
    found = []
    for match in PLACE_INTRO.finditer(spoken):
        phrase = _place_phrase(spoken[match.end() :].split())
        if phrase and _useful_place(phrase):
            found.append(phrase)
    for match in PLACE_NAME.finditer(spoken):
        phrase = match.group(1)
        if phrase not in found:
            found.append(phrase)
    if not found:
        return "Unknown"
    numbered = [phrase for phrase in found if re.search(r"\d", phrase)]
    pool = numbered or found
    pool.sort(key=len, reverse=True)
    return pool[0]


def report_header(text):
    return "Location: {} | Type of report: {}".format(derive_location(text), derive_report_type(text))


def transcript_filename(call):
    stamp = call.get("started_at") or ""
    try:
        when = datetime.fromisoformat(stamp)
    except ValueError:
        when = None
    if when is None:
        label = "undated"
    else:
        if when.tzinfo is None:
            when = when.replace(tzinfo=timezone.utc)
        label = when.astimezone().strftime("%Y-%m-%d_%H-%M-%S")
    return "{}_{}.txt".format(label, call["id"])


def keep_spoken(transcript, keywords):
    spoken = transcript.lower()
    kept = []
    for keyword in keywords or []:
        text = " ".join(str(keyword).split())
        if not text or text.lower() in [item.lower() for item in kept]:
            continue
        if text.lower() in spoken:
            kept.append(text)
        if len(kept) == 16:
            break
    return kept


def render_transcript(call):
    lines = []
    chunks = [line.get("text") or "" for line in call.get("transcript") or []]
    partial = call.get("partial")
    if partial and partial.get("text"):
        chunks.append(partial["text"])
    lines.append(report_header(chunks))
    lines.append("")
    title = call.get("from_number") or "Call"
    lines.append(title)
    lines.append(call.get("started_at") or "")
    lines.append("")
    chunks = []
    for line in call.get("transcript") or []:
        stamp = (line.get("t") or "")[11:19]
        speaker = line.get("speaker") or "Caller"
        text = line.get("text") or ""
        chunks.append(text)
        lines.append("[{}] {}".format(stamp, speaker))
        lines.append(text)
        lines.append("")
    partial = call.get("partial")
    if partial and partial.get("text"):
        lines.append("[live] {}".format(partial.get("speaker") or "Caller"))
        lines.append(partial["text"])
        lines.append("")
        chunks.append(partial["text"])
    paragraph = stitch_text(chunks)
    if paragraph:
        lines.append("---")
        lines.append(paragraph)
        lines.append("")
    keywords = call.get("keywords") or []
    if keywords:
        lines.append("Keywords: " + ", ".join(keywords))
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def write_transcript(directory, call):
    os.makedirs(directory, exist_ok=True)
    name = transcript_filename(call)
    path = os.path.join(directory, name)
    marker = "_" + call["id"] + ".txt"
    for existing in os.listdir(directory):
        if existing == name:
            continue
        if existing == call["id"] + ".txt" or existing.endswith(marker):
            try:
                os.remove(os.path.join(directory, existing))
            except OSError:
                pass
    with open(path, "w") as handle:
        handle.write(render_transcript(call))
    return path
