"""TwiML that answers the station number and forks the audio to this desk."""

import base64
import hashlib
import hmac
import os
from xml.sax.saxutils import escape


def xml_escape(value):
    return escape(str(value or ""), {'"': "&quot;"})


def stream_ws_url(public_base_url):
    base = (public_base_url or "").strip().rstrip("/")
    if base.startswith("https://"):
        base = "wss://" + base[len("https://") :]
    elif base.startswith("http://"):
        base = "ws://" + base[len("http://") :]
    return base + "/twilio/media"


def bridge_twiml(public_base_url, room, role, from_number, intro):
    """Bidirectional stream so each person can hear a translation."""
    if not public_base_url:
        body = "<Say>The dispatch transcriber does not have a public address yet.</Say>"
        return '<?xml version="1.0" encoding="UTF-8"?><Response>{}</Response>'.format(body)
    stream = (
        "<Connect><Stream url=\"{url}\">"
        '<Parameter name="from" value="{caller}"/>'
        '<Parameter name="role" value="{role}"/>'
        '<Parameter name="room" value="{room}"/>'
        "</Stream></Connect>"
    ).format(
        url=xml_escape(stream_ws_url(public_base_url)),
        caller=xml_escape(from_number or "unknown"),
        role=xml_escape(role or "caller"),
        room=xml_escape(room or "room"),
    )
    body = "<Say>{}</Say>{}".format(xml_escape(intro), stream)
    return '<?xml version="1.0" encoding="UTF-8"?><Response>{}</Response>'.format(body)


CALLER_INTRO = (
    "This call is recorded and translated for dispatch. "
    "Speak in any language. The station hears English."
)
DESK_INTRO = (
    "You are connected to a caller. You hear English. "
    "Speak English. The caller hears their own language."
)


def voice_twiml(from_number, public_base_url, desk_number):
    """Say the recording notice before the stream starts, so the notice itself is not transcribed."""
    if not public_base_url:
        body = "<Say>The dispatch transcriber does not have a public address yet.</Say>"
        return '<?xml version="1.0" encoding="UTF-8"?><Response>{}</Response>'.format(body)

    desk = (desk_number or "").strip()
    track = "both_tracks" if desk else "inbound_track"
    stream = (
        '<Stream url="{url}" track="{track}">'
        '<Parameter name="from" value="{caller}"/>'
        "</Stream>"
    ).format(
        url=xml_escape(stream_ws_url(public_base_url)),
        track=track,
        caller=xml_escape(from_number or "unknown"),
    )

    if desk:
        # Twilio calls /twilio/answered the moment the station phone picks up, so the console can
        # open the call immediately instead of waiting for the dispatcher's first words.
        answered = public_base_url.strip().rstrip("/") + "/twilio/answered"
        body = (
            "<Say>This call is recorded and transcribed for dispatch. Connecting you to the station.</Say>"
            "<Start>{stream}</Start>"
            '<Dial answerOnBridge="true" timeout="25">'
            '<Number statusCallbackEvent="answered" statusCallback="{answered}" statusCallbackMethod="POST">{desk}</Number>'
            "</Dial>"
            "<Say>The station did not answer. Please call back.</Say>"
        ).format(stream=stream, desk=xml_escape(desk), answered=xml_escape(answered))
    else:
        body = (
            "<Say>You have reached station dispatch. This call is recorded and transcribed. "
            "Say what is happening and where you are.</Say>"
            "<Connect>{stream}</Connect>"
        ).format(stream=stream)
    return '<?xml version="1.0" encoding="UTF-8"?><Response>{}</Response>'.format(body)


def twilio_signature(url, params, token):
    payload = url + "".join(key + params[key] for key in sorted(params))
    digest = hmac.new(token.encode("utf-8"), payload.encode("utf-8"), hashlib.sha1).digest()
    return base64.b64encode(digest).decode("ascii")


def valid_twilio_request(url, params, signature, token):
    if not token:
        return True
    expected = twilio_signature(url, params, token)
    return hmac.compare_digest(expected, signature or "")


def public_voice_url(request_path, request_query):
    base = os.environ.get("PUBLIC_BASE_URL", "").strip().rstrip("/")
    if not base:
        return ""
    url = base + request_path
    if request_query:
        url += "?" + request_query
    return url
