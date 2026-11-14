"""Station desk server.

The phone line and the practice microphone feed the same live transcript.
Gemini writes the words while the caller is still speaking, keywords are marked,
and each call is saved as text.
"""

import asyncio
import base64
import json
import logging
import os
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

load_dotenv()

from app.audio_util import FRAME, mulaw_to_pcm16, pcm16_to_mulaw, resample_pcm16
from app.gemini_client import GeminiClient, redact
from app.languages import language_name
from app.transcripts import transcript_filename
from app.twiml import CALLER_INTRO, DESK_INTRO, bridge_twiml
from app.pipeline import Pipeline
from app.store import DeskError, DeskStore
from app.twiml import public_voice_url, valid_twilio_request, voice_twiml

log = logging.getLogger("desk")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"
TRANSCRIPTS = Path(os.environ.get("DESK_TRANSCRIPTS", str(ROOT / "transcripts")))
DB_PATH = os.environ.get("DESK_DB", str(ROOT / "data" / "desk.db"))

AUDIO_TYPES = {
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".mp4": "audio/mp4",
    ".ogg": "audio/ogg",
    ".webm": "audio/webm",
    ".flac": "audio/flac",
    ".aac": "audio/aac",
}

app = FastAPI(title="Station Desk")
store = DeskStore(DB_PATH, str(TRANSCRIPTS))
store.export_all()


class Hub(object):
    def __init__(self):
        self.clients = set()
        self.lock = asyncio.Lock()

    async def add(self, websocket):
        async with self.lock:
            self.clients.add(websocket)

    async def discard(self, websocket):
        async with self.lock:
            self.clients.discard(websocket)

    async def broadcast(self, payload):
        data = json.dumps(payload)
        async with self.lock:
            clients = list(self.clients)
        dead = []
        for websocket in clients:
            try:
                await websocket.send_text(data)
            except Exception:
                dead.append(websocket)
        if dead:
            async with self.lock:
                for websocket in dead:
                    self.clients.discard(websocket)


hub = Hub()


phone_legs = {}
rooms = {}


def annotated_snapshot():
    snap = store.snapshot()
    for call in snap["calls"]:
        code = pipeline.caller_language.get(call["id"])
        if code:
            call["caller_language"] = language_name(code)
    return snap


async def publish():
    await hub.broadcast({"type": "snapshot", **annotated_snapshot()})


def _b64_pcm(pcm):
    return base64.b64encode(pcm).decode("ascii")


async def _send_leg(call_id, role, pcm, rate):
    sender = phone_legs.get((call_id, role))
    if not sender or not pcm:
        return
    try:
        await sender(pcm, rate)
    except Exception:
        log.exception("could not play translation on the %s leg", role)
        phone_legs.pop((call_id, role), None)


async def play_for_desk(call_id, pcm, rate):
    await hub.broadcast({
        "type": "play",
        "call_id": call_id,
        "rate": rate,
        "pcm": _b64_pcm(pcm),
    })
    await _send_leg(call_id, "desk", pcm, rate)


async def play_for_caller(call_id, pcm, rate):
    await _send_leg(call_id, "caller", pcm, rate)


async def _twilio_media(websocket, stream_sid, pcm, rate):
    audio = pcm16_to_mulaw(resample_pcm16(pcm, rate or 24000, 8000))
    for index in range(0, len(audio), FRAME):
        piece = audio[index : index + FRAME]
        if len(piece) < FRAME:
            piece = piece + (b"\xff" * (FRAME - len(piece)))
        await websocket.send_text(json.dumps({
            "event": "media",
            "streamSid": stream_sid,
            "media": {"payload": base64.b64encode(piece).decode("ascii")},
        }))


def register_leg(call_id, role, websocket, stream_sid):
    async def send(pcm, rate, websocket=websocket, stream_sid=stream_sid):
        await _twilio_media(websocket, stream_sid, pcm, rate)

    phone_legs[(call_id, role)] = send


async def dial_desk(account_sid, token, from_number, desk_number, twiml):
    url = "https://api.twilio.com/2010-04-01/Accounts/{}/Calls.json".format(account_sid)
    body = urllib.parse.urlencode({
        "To": desk_number,
        "From": from_number,
        "Twiml": twiml,
    }).encode("utf-8")
    request = urllib.request.Request(url, data=body, method="POST")
    auth = base64.b64encode("{}:{}".format(account_sid, token).encode("utf-8")).decode("ascii")
    request.add_header("Authorization", "Basic " + auth)
    def _post():
        with urllib.request.urlopen(request, timeout=8) as response:
            response.read()

    try:
        await asyncio.to_thread(_post)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:240]
        raise RuntimeError(redact("Twilio could not ring the station: {}".format(detail)))


pipeline = Pipeline(store, GeminiClient(), publish, play_for_desk, play_for_caller)


class OfficerIn(BaseModel):
    unit: str
    name: str


class AssignIn(BaseModel):
    officer_id: str


class CallIn(BaseModel):
    source: str = "mic"


class StatusIn(BaseModel):
    status: str


def _http(exc):
    if isinstance(exc, DeskError):
        raise HTTPException(exc.status, exc.message)
    raise exc


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/api/snapshot")
def snapshot():
    return store.snapshot()


@app.post("/api/officers")
async def create_officer(body: OfficerIn):
    try:
        officer = store.add_officer(body.unit, body.name)
    except DeskError as exc:
        _http(exc)
    await publish()
    return officer


@app.delete("/api/officers/{officer_id}")
async def delete_officer(officer_id: str):
    try:
        store.remove_officer(officer_id)
    except DeskError as exc:
        _http(exc)
    await publish()
    return {"ok": True}


@app.post("/api/officers/{officer_id}/status")
async def officer_status(officer_id: str, body: StatusIn):
    try:
        store.set_officer_status(officer_id, body.status)
    except DeskError as exc:
        _http(exc)
    await publish()
    return {"ok": True}


@app.post("/api/calls")
async def create_call(body: CallIn):
    if body.source != "mic":
        raise HTTPException(400, "This endpoint starts a practice call.")
    call = store.open_call("mic", "Practice")
    await publish()
    return call


@app.post("/api/calls/{call_id}/end")
async def end_call(call_id: str):
    try:
        call = store.end_call(call_id)
    except DeskError as exc:
        _http(exc)
    await publish()
    return call


@app.get("/api/calls/{call_id}/transcript.txt")
def download_transcript(call_id: str):
    call = store.get_call(call_id)
    text = store.transcript_text(call_id)
    if call is None or text is None:
        raise HTTPException(404, "No call with that id.")
    filename = transcript_filename(call)
    return Response(
        content=text,
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="{}"'.format(filename)},
    )


@app.post("/api/calls/{call_id}/assign")
async def assign_call(call_id: str, body: AssignIn):
    try:
        store.assign(call_id, body.officer_id)
    except DeskError as exc:
        _http(exc)
    await publish()
    return {"ok": True}


@app.post("/api/calls/upload")
async def upload_call(file: UploadFile = File(...)):
    name = file.filename or "recording"
    mime = _audio_mime(name, file.content_type)
    if not mime:
        raise HTTPException(400, "Use a wav, mp3, m4a, ogg, flac, or webm recording.")
    data = await file.read()
    if not data:
        raise HTTPException(400, "That file is empty.")
    if len(data) > 15 * 1024 * 1024:
        raise HTTPException(413, "Keep recordings under 15 MB.")
    call = store.open_call("upload", name)
    await publish()
    asyncio.create_task(_transcribe_upload(call["id"], data, mime))
    return call


async def _transcribe_upload(call_id, data, mime):
    try:
        await pipeline.enqueue_file(call_id, data, mime, "Recording")
        await pipeline.close_audio(call_id)
    except Exception as exc:
        store.set_error(call_id, redact(exc))
        log.warning("upload %s: %s", call_id, redact(exc))
    finally:
        try:
            store.end_call(call_id)
        except DeskError:
            pass
        await publish()


@app.post("/twilio/voice")
async def twilio_voice(request: Request):
    form = await request.form()
    params = {key: str(form.get(key)) for key in form.keys()}
    token = os.environ.get("TWILIO_AUTH_TOKEN", "").strip()
    signed_url = public_voice_url(request.url.path, request.url.query)
    signature = request.headers.get("X-Twilio-Signature", "")
    if token and not valid_twilio_request(signed_url, params, signature, token):
        raise HTTPException(403, "Twilio signature did not match.")
    base = os.environ.get("PUBLIC_BASE_URL", "")
    desk = os.environ.get("STATION_DESK_NUMBER", "").strip()
    account = params.get("AccountSid", "").strip()
    twilio_to = params.get("To", "").strip()
    room = params.get("CallSid") or "room"
    caller = params.get("From", "unknown")
    if desk and token and account and twilio_to and base:
        try:
            await dial_desk(
                account,
                token,
                twilio_to,
                desk,
                bridge_twiml(base, room, "desk", caller, DESK_INTRO),
            )
        except Exception as exc:
            log.warning("station phone was not dialed: %s", redact(exc))
        else:
            xml = bridge_twiml(base, room, "caller", caller, CALLER_INTRO)
            return Response(content=xml, media_type="application/xml")
    xml = voice_twiml(caller, base, desk)
    return Response(content=xml, media_type="application/xml")


@app.websocket("/ws/console")
async def console_socket(websocket: WebSocket):
    await websocket.accept()
    await hub.add(websocket)
    try:
        await websocket.send_text(json.dumps({"type": "snapshot", **annotated_snapshot()}))
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await hub.discard(websocket)


@app.websocket("/ws/audio/{call_id}")
async def audio_socket(websocket: WebSocket, call_id: str):
    await websocket.accept()
    if store.get_call(call_id) is None:
        await websocket.close(code=4404)
        return
    try:
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break
            data = message.get("bytes")
            if data and data.startswith(b"RIFF"):
                await pipeline.enqueue(call_id, data, "audio/wav", "Caller")
            elif data:
                await pipeline.feed_pcm(call_id, "Caller", data)
    except WebSocketDisconnect:
        pass
    finally:
        await pipeline.close_audio(call_id)
        try:
            store.end_call(call_id)
        except DeskError:
            pass
        await publish()


@app.websocket("/ws/reply/{call_id}")
async def reply_socket(websocket: WebSocket, call_id: str):
    """The desk microphone. Closing it does not hang up the phone call."""
    await websocket.accept()
    if store.get_call(call_id) is None:
        await websocket.close(code=4404)
        return
    try:
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break
            data = message.get("bytes")
            if data:
                await pipeline.feed_pcm(call_id, "Call-taker", data)
    except WebSocketDisconnect:
        pass


@app.websocket("/twilio/media")
async def twilio_media(websocket: WebSocket):
    await websocket.accept()
    call_id = None
    role = "caller"
    try:
        while True:
            raw = await websocket.receive_text()
            message = json.loads(raw)
            event = message.get("event")
            if event == "start":
                start = message.get("start") or {}
                params = start.get("customParameters") or {}
                role = params.get("role") or "caller"
                room = params.get("room") or start.get("callSid") or ""
                if room and room in rooms:
                    call_id = rooms[room]
                else:
                    who = params.get("from") or ("Station" if role == "desk" else "unknown")
                    call = store.open_call("phone", who, start.get("callSid"))
                    call_id = call["id"]
                    if room:
                        rooms[room] = call_id
                register_leg(call_id, "desk" if role == "desk" else "caller", websocket, start.get("streamSid") or "")
                log.info("phone call %s %s leg opened", call_id, role)
                await publish()
            elif event == "media" and call_id:
                media = message.get("media") or {}
                payload = base64.b64decode(media.get("payload") or "")
                track = media.get("track") or "inbound"
                if role == "desk":
                    speaker = "Call-taker"
                elif track == "outbound":
                    speaker = "Call-taker"
                else:
                    speaker = "Caller"
                pcm = resample_pcm16(mulaw_to_pcm16(payload), 8000, 16000)
                await pipeline.feed_pcm(call_id, speaker, pcm)
            elif event == "stop":
                break
    except WebSocketDisconnect:
        pass
    finally:
        if call_id:
            phone_legs.pop((call_id, "desk" if role == "desk" else "caller"), None)
            if role != "desk" or (call_id, "caller") not in phone_legs:
                await pipeline.close_audio(call_id)
                try:
                    store.end_call(call_id)
                except DeskError:
                    pass
                rooms_to_drop = [room for room, owned in rooms.items() if owned == call_id]
                for room in rooms_to_drop:
                    rooms.pop(room, None)
            await publish()


def _audio_mime(name, content_type):
    suffix = Path(name).suffix.lower()
    if suffix in AUDIO_TYPES:
        return AUDIO_TYPES[suffix]
    if content_type and content_type.startswith("audio/"):
        return content_type.split(";")[0]
    return None


app.mount("/static", StaticFiles(directory=STATIC), name="static")
