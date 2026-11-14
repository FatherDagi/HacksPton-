"""Guess the caller's language from the words they actually said."""

import re
import unicodedata

NAMES = {
    "en": "English",
    "es": "Spanish",
    "fr": "French",
    "cmn": "Mandarin",
    "yue": "Cantonese",
    "de": "German",
    "pt": "Portuguese",
    "it": "Italian",
    "ko": "Korean",
    "ja": "Japanese",
    "ar": "Arabic",
    "ru": "Russian",
    "hi": "Hindi",
    "th": "Thai",
    "el": "Greek",
    "he": "Hebrew",
}

CUES = (
    ("es", ("necesito", "ayuda", "estoy", "donde", "por", "favor", "amigo", "calle", "hay", "hola", "gracias", "policia", "tengo", "ahora", "aqui")),
    ("fr", ("je", "suis", "vous", "bonjour", "merci", "besoin", "aide", "ou", "est", "dans", "avec", "une", "des", "chapelle")),
    ("de", ("ich", "nicht", "bitte", "hilfe", "und", "der", "die", "das", "ein", "ist")),
    ("pt", ("nao", "voce", "obrigado", "esta", "preciso", "ajuda", "uma")),
    ("it", ("sono", "grazie", "bisogno", "aiuto", "dove", "non", "per")),
    ("en", ("the", "and", "need", "please", "help", "there", "what", "where", "friend", "my", "police", "now")),
)


def language_name(code):
    return NAMES.get(code or "", code or "")


def gemini_language(code):
    """BCP-47 tag the live translator accepts. Display codes stay as detected."""
    return {"cmn": "zh-Hans", "pt": "pt-BR"}.get(code or "en", code or "en")


def detect_language(text):
    raw = str(text or "")
    if not raw.strip():
        return None
    counts = _scripts(raw)
    for code, minimum in (
        ("cmn", 2),
        ("ko", 2),
        ("ja", 2),
        ("ar", 2),
        ("ru", 2),
        ("hi", 2),
        ("th", 2),
        ("el", 2),
        ("he", 2),
    ):
        if counts.get(code, 0) >= minimum:
            return code
    folded = _fold(raw)
    words = re.findall(r"[a-z']+", folded)
    if len(words) < 2 and counts.get("cmn", 0) < 2:
        if len(words) == 1 and words[0] in ("hola", "bonjour", "gracias", "merci"):
            return "es" if words[0] in ("hola", "gracias") else "fr"
        return None
    scores = {}
    for code, cues in CUES:
        scores[code] = sum(1 for word in words if word in cues)
    best = max(scores, key=lambda code: scores[code])
    if scores[best] < 2:
        return None
    rivals = [code for code, score in scores.items() if code != best and score == scores[best]]
    if rivals:
        return None
    return best


def _fold(text):
    text = unicodedata.normalize("NFKD", text)
    text = "".join(char for char in text if not unicodedata.combining(char))
    return text.lower().replace("'", "")


def _scripts(text):
    counts = {}
    for char in text:
        code = ord(char)
        if 0x4E00 <= code <= 0x9FFF:
            counts["cmn"] = counts.get("cmn", 0) + 1
        elif 0xAC00 <= code <= 0xD7AF:
            counts["ko"] = counts.get("ko", 0) + 1
        elif 0x3040 <= code <= 0x30FF:
            counts["ja"] = counts.get("ja", 0) + 1
        elif 0x0600 <= code <= 0x06FF:
            counts["ar"] = counts.get("ar", 0) + 1
        elif 0x0400 <= code <= 0x04FF:
            counts["ru"] = counts.get("ru", 0) + 1
        elif 0x0900 <= code <= 0x097F:
            counts["hi"] = counts.get("hi", 0) + 1
        elif 0x0E00 <= code <= 0x0E7F:
            counts["th"] = counts.get("th", 0) + 1
        elif 0x0370 <= code <= 0x03FF:
            counts["el"] = counts.get("el", 0) + 1
        elif 0x0590 <= code <= 0x05FF:
            counts["he"] = counts.get("he", 0) + 1
    return counts
