"""Local roster and call records. Audio is not stored."""

import json
import os
import sqlite3
import threading
import uuid
from datetime import datetime, timezone

from app.cards import empty_card, merge_card, utterance_text
from app.transcripts import find_keywords, render_transcript, strip_overlap, write_transcript

SAMPLE_UNITS = (
    ("1A12", "A. Reyes"),
    ("1A14", "M. Cole"),
    ("1A21", "S. Nguyen"),
    ("1B02", "L. Brooks"),
    ("1T05", "J. Patel"),
    ("1S01", "K. Ortiz"),
)


class DeskError(Exception):
    def __init__(self, status, message):
        super(DeskError, self).__init__(message)
        self.status = status
        self.message = message


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class DeskStore(object):
    def __init__(self, path, transcripts_dir=None):
        folder = os.path.dirname(path)
        if folder:
            os.makedirs(folder, exist_ok=True)
        self.transcripts_dir = transcripts_dir or os.path.join(folder or ".", "transcripts")
        self.partials = {}
        self.conn = sqlite3.connect(path, check_same_thread=False, timeout=5)
        self.conn.row_factory = sqlite3.Row
        self.lock = threading.Lock()
        self._init()

    def _init(self):
        with self.lock:
            self.conn.execute("PRAGMA journal_mode=WAL")
            self.conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS officers (
                    id TEXT PRIMARY KEY,
                    unit TEXT NOT NULL,
                    name TEXT NOT NULL,
                    status TEXT NOT NULL,
                    call_id TEXT
                );
                CREATE TABLE IF NOT EXISTS calls (
                    id TEXT PRIMARY KEY,
                    source TEXT NOT NULL,
                    from_number TEXT,
                    call_sid TEXT,
                    started_at TEXT NOT NULL,
                    ended_at TEXT,
                    status TEXT NOT NULL,
                    transcript_json TEXT NOT NULL,
                    card_json TEXT NOT NULL,
                    officer_id TEXT,
                    pending INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT
                );
                """
            )
            count = self.conn.execute("SELECT COUNT(*) AS n FROM officers").fetchone()["n"]
            if count == 0:
                for unit, name in SAMPLE_UNITS:
                    self.conn.execute(
                        "INSERT INTO officers (id, unit, name, status, call_id) VALUES (?, ?, ?, 'available', NULL)",
                        (uuid.uuid4().hex[:12], unit, name),
                    )
            columns = [row[1] for row in self.conn.execute("PRAGMA table_info(calls)")]
            if "keywords_json" not in columns:
                self.conn.execute(
                    "ALTER TABLE calls ADD COLUMN keywords_json TEXT NOT NULL DEFAULT '[]'"
                )
            self.conn.commit()

    def snapshot(self):
        with self.lock:
            officers = [self._officer(row) for row in self.conn.execute("SELECT * FROM officers ORDER BY unit")]
            rows = self.conn.execute("SELECT * FROM calls").fetchall()
            partials = dict(self.partials)
        calls = []
        for row in rows:
            call = self._call(row)
            call["partial"] = partials.get(call["id"])
            partial = call["partial"] or {}
            if partial.get("text"):
                spoken = [line["text"] for line in call["transcript"]] + [partial["text"]]
                merged = list(call["keywords"])
                for word in find_keywords(spoken):
                    if word.lower() not in [item.lower() for item in merged]:
                        merged.append(word)
                call["keywords"] = merged[:16]
            calls.append(call)
        live = [call for call in calls if call["status"] == "live"]
        done = [call for call in calls if call["status"] != "live"]
        live.sort(key=lambda call: call["started_at"], reverse=True)
        done.sort(key=lambda call: call["started_at"], reverse=True)
        return {
            "officers": officers,
            "calls": (live + done)[:40],
            "config": desk_config(),
        }

    def open_call(self, source, from_number, call_sid=None):
        call_id = uuid.uuid4().hex[:12]
        with self.lock:
            if call_sid:
                existing = self.conn.execute("SELECT * FROM calls WHERE call_sid = ?", (call_sid,)).fetchone()
                if existing:
                    return self._call(existing)
            self.conn.execute(
                """
                INSERT INTO calls (
                    id, source, from_number, call_sid, started_at, ended_at, status,
                    transcript_json, card_json, officer_id, pending, last_error, keywords_json
                ) VALUES (?, ?, ?, ?, ?, NULL, 'live', '[]', ?, NULL, 0, NULL, '[]')
                """,
                (call_id, source, from_number, call_sid, _now(), json.dumps(empty_card())),
            )
            self.conn.commit()
            row = self.conn.execute("SELECT * FROM calls WHERE id = ?", (call_id,)).fetchone()
        return self._call(row)

    def get_call(self, call_id):
        with self.lock:
            row = self.conn.execute("SELECT * FROM calls WHERE id = ?", (call_id,)).fetchone()
            partial = self.partials.get(call_id)
        if row is None:
            return None
        call = self._call(row)
        call["partial"] = partial
        return call

    def context(self, call_id):
        call = self.get_call(call_id)
        if not call:
            return {"transcript": "", "card": empty_card()}
        lines = ["{}: {}".format(line["speaker"], line["text"]) for line in call["transcript"][-30:]]
        return {"transcript": "\n".join(lines)[-6000:], "card": call["card"]}

    def set_partial(self, call_id, speaker, text):
        with self.lock:
            self.partials[call_id] = {"speaker": speaker, "text": text}
        call = self.get_call(call_id)
        if call and (call["transcript"] or (call.get("partial") or {}).get("text")):
            write_transcript(self.transcripts_dir, call)

    def clear_partial(self, call_id):
        with self.lock:
            self.partials.pop(call_id, None)

    def append_line(self, call_id, speaker, text, continue_line=False):
        """Add a transcript line. continue_line=True appends to the last line instead (same speaker,
        no pause), so a line only ends after a pause or when the other person talks."""
        text = " ".join(str(text or "").split())
        if not text:
            self.clear_partial(call_id)
            return None
        with self.lock:
            row = self.conn.execute("SELECT * FROM calls WHERE id = ?", (call_id,)).fetchone()
            if row is None:
                return None
            transcript = json.loads(row["transcript_json"])
            if transcript:
                text = strip_overlap(transcript[-1]["text"], text)
            self.partials.pop(call_id, None)
            if not text:
                call = self._call(row)
                call["partial"] = None
                written = call
            else:
                if continue_line and transcript and transcript[-1]["speaker"] == speaker:
                    transcript[-1]["text"] = transcript[-1]["text"] + " " + text
                else:
                    transcript.append({"t": _now(), "speaker": speaker, "text": text})
                keywords = find_keywords([line["text"] for line in transcript])
                self.conn.execute(
                    "UPDATE calls SET transcript_json = ?, keywords_json = ?, last_error = NULL WHERE id = ?",
                    (json.dumps(transcript), json.dumps(keywords), call_id),
                )
                self.conn.commit()
                row = self.conn.execute("SELECT * FROM calls WHERE id = ?", (call_id,)).fetchone()
                written = self._call(row)
                written["partial"] = None
        if written and written["transcript"]:
            write_transcript(self.transcripts_dir, written)
        return written

    def replace_last_line(self, call_id, speaker, text):
        """Replace the last line's words (the model re-sent the same line with more words)."""
        call = self.get_call(call_id)
        if not call or not call["transcript"]:
            return None
        return self.update_line(call_id, len(call["transcript"]) - 1, speaker, text)

    def update_line(self, call_id, index, speaker, text):
        """Set the words of one transcript line (a speaker's line that is still open)."""
        text = " ".join(str(text or "").split())
        with self.lock:
            row = self.conn.execute("SELECT * FROM calls WHERE id = ?", (call_id,)).fetchone()
            if row is None:
                return None
            transcript = json.loads(row["transcript_json"])
            if not text or not (0 <= index < len(transcript)) or transcript[index]["speaker"] != speaker:
                return None
            transcript[index]["text"] = text
            self.partials.pop(call_id, None)
            keywords = find_keywords([line["text"] for line in transcript])
            self.conn.execute(
                "UPDATE calls SET transcript_json = ?, keywords_json = ?, last_error = NULL WHERE id = ?",
                (json.dumps(transcript), json.dumps(keywords), call_id),
            )
            self.conn.commit()
            row = self.conn.execute("SELECT * FROM calls WHERE id = ?", (call_id,)).fetchone()
            written = self._call(row)
            written["partial"] = None
        write_transcript(self.transcripts_dir, written)
        return written

    def add_line_source(self, call_id, index, original, language):
        """Attach the caller's original (untranslated) words and their language to a translated line."""
        original = " ".join(str(original or "").split())
        if not original:
            return None
        with self.lock:
            row = self.conn.execute("SELECT * FROM calls WHERE id = ?", (call_id,)).fetchone()
            if row is None:
                return None
            transcript = json.loads(row["transcript_json"])
            if not (0 <= index < len(transcript)):
                return None
            line = transcript[index]
            line["original"] = (line.get("original", "") + " " + original).strip()
            line["language"] = language
            self.conn.execute("UPDATE calls SET transcript_json = ? WHERE id = ?", (json.dumps(transcript), call_id))
            self.conn.commit()
        return True

    def set_keywords(self, call_id, keywords):
        with self.lock:
            row = self.conn.execute("SELECT * FROM calls WHERE id = ?", (call_id,)).fetchone()
            if row is None:
                return None
            self.conn.execute(
                "UPDATE calls SET keywords_json = ? WHERE id = ?",
                (json.dumps(keywords), call_id),
            )
            self.conn.commit()
            row = self.conn.execute("SELECT * FROM calls WHERE id = ?", (call_id,)).fetchone()
            call = self._call(row)
            call["partial"] = self.partials.get(call_id)
        if call["transcript"]:
            write_transcript(self.transcripts_dir, call)
        return call

    def export_all(self):
        paths = []
        for call in self.snapshot()["calls"]:
            if call["transcript"] or call.get("partial"):
                paths.append(write_transcript(self.transcripts_dir, call))
        return paths

    def transcript_text(self, call_id):
        call = self.get_call(call_id)
        if call is None:
            return None
        with self.lock:
            call["partial"] = self.partials.get(call_id)
        return render_transcript(call)

    def apply_update(self, call_id, speaker, data):
        text = utterance_text(data)
        with self.lock:
            row = self.conn.execute("SELECT * FROM calls WHERE id = ?", (call_id,)).fetchone()
            if row is None:
                return None
            transcript = json.loads(row["transcript_json"])
            card = merge_card(json.loads(row["card_json"]), data)
            if text:
                transcript.append({"t": _now(), "speaker": speaker, "text": text})
            self.conn.execute(
                "UPDATE calls SET transcript_json = ?, card_json = ?, last_error = NULL WHERE id = ?",
                (json.dumps(transcript), json.dumps(card), call_id),
            )
            self.conn.commit()
            row = self.conn.execute("SELECT * FROM calls WHERE id = ?", (call_id,)).fetchone()
        return self._call(row)

    def set_error(self, call_id, message):
        with self.lock:
            self.conn.execute("UPDATE calls SET last_error = ? WHERE id = ?", (message, call_id))
            self.conn.commit()

    def add_pending(self, call_id, delta):
        with self.lock:
            self.conn.execute(
                "UPDATE calls SET pending = MAX(0, pending + ?) WHERE id = ?",
                (delta, call_id),
            )
            self.conn.commit()

    def end_call(self, call_id):
        with self.lock:
            row = self.conn.execute("SELECT id FROM calls WHERE id = ?", (call_id,)).fetchone()
            if row is None:
                raise DeskError(404, "No call with that id.")
            self.conn.execute(
                "UPDATE calls SET status = 'ended', ended_at = COALESCE(ended_at, ?) WHERE id = ? AND status != 'ended'",
                (_now(), call_id),
            )
            self.conn.commit()
            row = self.conn.execute("SELECT * FROM calls WHERE id = ?", (call_id,)).fetchone()
        return self._call(row)

    def assign(self, call_id, officer_id):
        with self.lock:
            call = self.conn.execute("SELECT * FROM calls WHERE id = ?", (call_id,)).fetchone()
            officer = self.conn.execute("SELECT * FROM officers WHERE id = ?", (officer_id,)).fetchone()
            if call is None:
                raise DeskError(404, "No call with that id.")
            if officer is None:
                raise DeskError(404, "No unit with that id.")
            if officer["status"] != "available" and officer["call_id"] != call_id:
                raise DeskError(409, "{} is already out.".format(officer["unit"]))
            previous = call["officer_id"]
            if previous and previous != officer_id:
                self.conn.execute(
                    "UPDATE officers SET status = 'available', call_id = NULL WHERE id = ? AND call_id = ?",
                    (previous, call_id),
                )
            if officer["call_id"] != call_id:
                self.conn.execute(
                    "UPDATE officers SET status = 'dispatched', call_id = ? WHERE id = ?",
                    (call_id, officer_id),
                )
            self.conn.execute("UPDATE calls SET officer_id = ? WHERE id = ?", (officer_id, call_id))
            self.conn.commit()

    def set_officer_status(self, officer_id, status):
        if status not in {"available", "on_scene"}:
            raise DeskError(400, "Status must be available or on_scene.")
        with self.lock:
            officer = self.conn.execute("SELECT * FROM officers WHERE id = ?", (officer_id,)).fetchone()
            if officer is None:
                raise DeskError(404, "No unit with that id.")
            if status == "on_scene" and not officer["call_id"]:
                raise DeskError(409, "{} is not assigned to a call.".format(officer["unit"]))
            if status == "available":
                self.conn.execute(
                    "UPDATE officers SET status = 'available', call_id = NULL WHERE id = ?",
                    (officer_id,),
                )
            else:
                self.conn.execute("UPDATE officers SET status = 'on_scene' WHERE id = ?", (officer_id,))
            self.conn.commit()

    def add_officer(self, unit, name):
        unit = " ".join((unit or "").split())
        name = " ".join((name or "").split())
        if not unit or not name:
            raise DeskError(400, "Enter a unit and a name.")
        with self.lock:
            taken = self.conn.execute(
                "SELECT id FROM officers WHERE lower(unit) = lower(?)",
                (unit,),
            ).fetchone()
            if taken:
                raise DeskError(409, "{} is already on the roster.".format(unit))
            officer_id = uuid.uuid4().hex[:12]
            self.conn.execute(
                "INSERT INTO officers (id, unit, name, status, call_id) VALUES (?, ?, ?, 'available', NULL)",
                (officer_id, unit, name),
            )
            self.conn.commit()
            row = self.conn.execute("SELECT * FROM officers WHERE id = ?", (officer_id,)).fetchone()
        return self._officer(row)

    def remove_officer(self, officer_id):
        with self.lock:
            officer = self.conn.execute("SELECT * FROM officers WHERE id = ?", (officer_id,)).fetchone()
            if officer is None:
                raise DeskError(404, "No unit with that id.")
            if officer["status"] != "available":
                raise DeskError(409, "Clear {} before removing them.".format(officer["unit"]))
            self.conn.execute("DELETE FROM officers WHERE id = ?", (officer_id,))
            self.conn.commit()

    def _officer(self, row):
        return {
            "id": row["id"],
            "unit": row["unit"],
            "name": row["name"],
            "status": row["status"],
            "call_id": row["call_id"],
        }

    def _call(self, row):
        return {
            "id": row["id"],
            "source": row["source"],
            "from_number": row["from_number"],
            "call_sid": row["call_sid"],
            "started_at": row["started_at"],
            "ended_at": row["ended_at"],
            "status": row["status"],
            "transcript": json.loads(row["transcript_json"]),
            "card": json.loads(row["card_json"]),
            "officer_id": row["officer_id"],
            "pending": row["pending"],
            "last_error": row["last_error"],
            "keywords": self._keywords(row, json.loads(row["transcript_json"])),
            "partial": None,
        }

    def _keywords(self, row, transcript):
        raw = "[]"
        try:
            raw = row["keywords_json"] or "[]"
        except (KeyError, IndexError):
            raw = "[]"
        keywords = json.loads(raw)
        if keywords:
            return keywords
        return find_keywords([line["text"] for line in transcript])


def desk_config():
    return {
        "gemini_configured": bool(os.environ.get("GEMINI_API_KEY", "").strip()),
        "public_base_url": bool(os.environ.get("PUBLIC_BASE_URL", "").strip()),
        "desk_number": os.environ.get("STATION_DESK_NUMBER", "").strip(),
        "twilio_checks_signature": bool(os.environ.get("TWILIO_AUTH_TOKEN", "").strip()),
    }
