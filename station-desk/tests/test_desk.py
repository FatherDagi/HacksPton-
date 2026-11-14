import base64
import os
import tempfile
import time
import unittest
import xml.etree.ElementTree as ET

fd, PATH = tempfile.mkstemp(prefix="desk-test-", suffix=".db")
os.close(fd)
os.remove(PATH)
os.environ["DESK_DB"] = PATH
os.environ["GEMINI_API_KEY"] = ""
os.environ["PUBLIC_BASE_URL"] = ""
os.environ["STATION_DESK_NUMBER"] = ""
os.environ["TWILIO_AUTH_TOKEN"] = ""

from fastapi.testclient import TestClient

from app.audio_util import MulawSegmenter, mulaw_to_pcm16, pcm16_to_wav, resample_pcm16, rms_pcm16, wav_to_pcm16
from app.live import parse_live_message
from app.cards import empty_card, merge_card, parse_model_json, utterance_text
from app.transcripts import (
    derive_location,
    derive_report_type,
    find_keywords,
    render_transcript,
    stitch_text,
    strip_overlap,
    transcript_filename,
)
from app.main import app
from app.twiml import twilio_signature, voice_twiml


def tearDownModule():
    for suffix in ("", "-wal", "-shm"):
        try:
            os.remove(PATH + suffix)
        except OSError:
            pass


class AudioTests(unittest.TestCase):
    def test_mulaw_silence_and_loud(self):
        silence = mulaw_to_pcm16(b"\xff\xff")
        self.assertEqual(silence, b"\x00\x00\x00\x00")
        loud = struct_sample(mulaw_to_pcm16(b"\x00"))
        self.assertLess(loud, -30000)
        self.assertEqual(rms_pcm16(mulaw_to_pcm16(b"\xff" * 160)), 0)

    def test_wav_header(self):
        pcm = mulaw_to_pcm16(b"\xff" * 160)
        wav = pcm16_to_wav(pcm, 8000)
        self.assertTrue(wav.startswith(b"RIFF"))
        self.assertEqual(int.from_bytes(wav[24:28], "little"), 8000)
        self.assertEqual(int.from_bytes(wav[40:44], "little"), len(pcm))

    def test_segmenter_splits_on_pause_and_ignores_a_blip(self):
        segmenter = MulawSegmenter()
        chunks = segmenter.push(b"\x00" * 8000 + b"\xff" * 5600)
        self.assertEqual(len(chunks), 1)
        self.assertEqual(len(chunks[0]), 8640)

        short = MulawSegmenter()
        self.assertEqual(short.push(b"\x00" * 1600 + b"\xff" * 8000), [])
        self.assertIsNone(short.flush())

        long_speech = MulawSegmenter()
        pieces = long_speech.push(b"\x00" * 40000)
        self.assertEqual([len(piece) for piece in pieces], [16000, 16000])
        self.assertEqual(len(long_speech.flush()), 8000)

    def test_resample_and_wav_roundtrip(self):
        pcm = mulaw_to_pcm16(b"\x00" * 160)
        doubled = resample_pcm16(pcm, 8000, 16000)
        self.assertEqual(len(doubled), len(pcm) * 2)
        wav = pcm16_to_wav(pcm, 8000)
        decoded, rate = wav_to_pcm16(wav)
        self.assertEqual(rate, 8000)
        self.assertEqual(decoded, pcm)

    def test_live_messages_split_interim_and_final(self):
        interim = parse_live_message(
            '{"serverContent": {"interimInputTranscription": {"text": "I need police"}}}'
        )
        self.assertEqual(interim["interim"], "I need police")
        final = parse_live_message(
            '{"serverContent": {"inputTranscription": {"text": "I need police at Frith."}}}'
        )
        self.assertEqual(final["final"], "I need police at Frith.")
        setup = parse_live_message('{"setupComplete": {}}')
        self.assertTrue(setup["setup"])


class TranscriptTests(unittest.TestCase):
    def test_stitch_keywords_and_overlap(self):
        text = stitch_text([
            "I'm currently at uh Frith and my friend is pass...",
            "ed out and we need police now.",
        ])
        self.assertIn("passed out", text)
        keywords = find_keywords([
            "I'm currently at uh Frith and my friend is pass...",
            "ed out and we need police now.",
        ])
        self.assertIn("passed out", keywords)
        self.assertIn("police", keywords)
        self.assertIn("Frith", keywords)
        self.assertEqual(strip_overlap("we need police now", "police now please"), "please")
        self.assertEqual(derive_location(text), "Frith")
        self.assertEqual(derive_report_type(text), "Medical")
        address = "There is a break-in at 14 Oak Street and a crash at Main Street and Fifth Avenue."
        self.assertEqual(derive_location(address), "14 Oak Street")
        self.assertEqual(derive_report_type(address), "Burglary")
        self.assertEqual(derive_location("I'm at the same time but you can tell. near the street"), "Unknown")
        self.assertEqual(derive_location("Hello. Monkey King Hall"), "Monkey King Hall")
        self.assertEqual(derive_location("I'm at the Friend Center and my friend passed out"), "Friend Center")
        self.assertEqual(derive_location("Meet me at Frist"), "Frist Campus Center")
        self.assertEqual(derive_location("We are outside Nassau Hall"), "Nassau Hall")
        self.assertNotEqual(derive_location("911 Communications Center"), "22 Chambers Street")
        named = transcript_filename({"id": "abc123", "started_at": "2026-11-14T18:51:00+00:00"})
        self.assertTrue(named.startswith("2026-11-14_"))
        self.assertTrue(named.endswith("_abc123.txt"))


class CardTests(unittest.TestCase):
    def test_later_audio_cannot_erase_a_fact(self):
        previous = empty_card()
        previous["location"] = "14 Oak Street"
        previous["priority"] = "emergency"
        previous["weapons"] = True
        previous["summary"] = "A weapon was mentioned."
        card = merge_card(previous, {
            "location": None,
            "priority": "routine",
            "weapons": False,
            "summary": "Caller is outside now.",
            "injuries": "false",
        })
        self.assertEqual(card["location"], "14 Oak Street")
        self.assertEqual(card["priority"], "emergency")
        self.assertTrue(card["weapons"])
        self.assertFalse(card["injuries"])
        self.assertEqual(card["summary"], "Caller is outside now.")

    def test_parse_fenced_json_and_skip_silence(self):
        data = parse_model_json('```json\n{"utterance": "Help", "priority": "Emergency"}\n```')
        self.assertEqual(data["utterance"], "Help")
        self.assertEqual(utterance_text({"utterance": "[silence]"}), "")


class DeskApiTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        os.environ["PUBLIC_BASE_URL"] = ""
        os.environ["STATION_DESK_NUMBER"] = ""
        os.environ["TWILIO_AUTH_TOKEN"] = ""

    def test_roster_assign_and_clear(self):
        created = self.client.post("/api/officers", json={"unit": "9Z99", "name": "Test Officer"})
        self.assertEqual(created.status_code, 200, created.text)
        officer = created.json()
        duplicate = self.client.post("/api/officers", json={"unit": "9z99", "name": "Other"})
        self.assertEqual(duplicate.status_code, 409)

        call = self.client.post("/api/calls", json={"source": "mic"}).json()
        assigned = self.client.post(
            "/api/calls/{}/assign".format(call["id"]),
            json={"officer_id": officer["id"]},
        )
        self.assertEqual(assigned.status_code, 200)
        other = self.client.post("/api/calls", json={"source": "mic"}).json()
        blocked = self.client.post(
            "/api/calls/{}/assign".format(other["id"]),
            json={"officer_id": officer["id"]},
        )
        self.assertEqual(blocked.status_code, 409)

        snapshot = self.client.get("/api/snapshot").json()
        found = next(item for item in snapshot["officers"] if item["id"] == officer["id"])
        self.assertEqual(found["status"], "dispatched")
        self.assertEqual(found["call_id"], call["id"])

        scene = self.client.post(
            "/api/officers/{}/status".format(officer["id"]),
            json={"status": "on_scene"},
        )
        self.assertEqual(scene.status_code, 200)
        cleared = self.client.post(
            "/api/officers/{}/status".format(officer["id"]),
            json={"status": "available"},
        )
        self.assertEqual(cleared.status_code, 200)
        removed = self.client.delete("/api/officers/{}".format(officer["id"]))
        self.assertEqual(removed.status_code, 200)

    def test_console_snapshot_and_phone_stream(self):
        with self.client.websocket_connect("/ws/console") as socket:
            message = socket.receive_json()
        self.assertEqual(message["type"], "snapshot")
        self.assertGreaterEqual(len(message["officers"]), 6)
        self.assertFalse(message["config"]["gemini_configured"])

        silence = base64.b64encode(b"\xff" * 160).decode("ascii")
        with self.client.websocket_connect("/twilio/media") as socket:
            socket.send_json({"event": "connected", "protocol": "Call", "version": "1.0.0"})
            socket.send_json({
                "event": "start",
                "start": {
                    "callSid": "CA-test-silence",
                    "customParameters": {"from": "+15550001"},
                },
            })
            socket.send_json({
                "event": "media",
                "media": {"track": "inbound", "payload": silence},
            })
            socket.send_json({"event": "stop"})

        found = None
        for _ in range(40):
            snapshot = self.client.get("/api/snapshot").json()
            found = next((call for call in snapshot["calls"] if call["from_number"] == "+15550001"), None)
            if found and found["status"] == "ended":
                break
            time.sleep(0.05)
        self.assertIsNotNone(found)
        self.assertEqual(found["status"], "ended")
        self.assertEqual(found["source"], "phone")
        self.assertEqual(found["transcript"], [])

    def test_voice_webhook_bridges_the_desk_phone(self):
        os.environ["PUBLIC_BASE_URL"] = "https://desk.example.com"
        os.environ["STATION_DESK_NUMBER"] = "+15551212"
        response = self.client.post("/twilio/voice", data={"From": "AT&T", "CallSid": "CA1"})
        self.assertEqual(response.status_code, 200)
        self.assertIn("xml", response.headers["content-type"])
        ET.fromstring(response.text)
        self.assertIn("wss://desk.example.com/twilio/media", response.text)
        self.assertIn("both_tracks", response.text)
        self.assertIn("AT&amp;T", response.text)
        self.assertIn("+15551212", response.text)
        self.assertIn("recorded and transcribed", response.text)

        os.environ["STATION_DESK_NUMBER"] = ""
        caller_only = self.client.post("/twilio/voice", data={"From": "+15557654", "CallSid": "CA2"})
        ET.fromstring(caller_only.text)
        self.assertIn("inbound_track", caller_only.text)
        self.assertIn("<Connect>", caller_only.text)

        params = {"From": "+15557654", "CallSid": "CA3"}
        url = "https://desk.example.com/twilio/voice"
        os.environ["TWILIO_AUTH_TOKEN"] = "secret"
        signed = self.client.post(
            "/twilio/voice",
            data=params,
            headers={"X-Twilio-Signature": twilio_signature(url, params, "secret")},
        )
        self.assertEqual(signed.status_code, 200)
        rejected = self.client.post(
            "/twilio/voice",
            data=params,
            headers={"X-Twilio-Signature": "nope"},
        )
        self.assertEqual(rejected.status_code, 403)

    def test_transcript_downloads_as_text(self):
        from app.main import store

        call = self.client.post("/api/calls", json={"source": "mic"}).json()
        store.append_line(call["id"], "Caller", "My friend passed out at Frith")
        response = self.client.get("/api/calls/{}/transcript.txt".format(call["id"]))
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.text.startswith("Location: Frith | Type of report: Medical"))
        self.assertIn("passed out", response.text)
        self.assertIn("Frith", response.text)
        self.assertIn("Keywords:", response.text)
        self.assertIn(call["id"], response.headers["content-disposition"])
        from app.transcripts import transcript_filename as saved_name

        saved = os.path.join(os.path.dirname(__file__), "..", "transcripts", saved_name(call))
        self.assertTrue(os.path.isfile(saved))
        os.remove(saved)

    def test_upload_rejects_a_text_file(self):
        response = self.client.post(
            "/api/calls/upload",
            files={"file": ("notes.txt", b"hello", "text/plain")},
        )
        self.assertEqual(response.status_code, 400)

    def test_twiml_without_a_public_address(self):
        xml = voice_twiml("+1555", "", "")
        self.assertIn("does not have a public address", xml)
        ET.fromstring(xml)


def struct_sample(pcm):
    import struct
    return struct.unpack("<h", pcm)[0]


if __name__ == "__main__":
    unittest.main()
