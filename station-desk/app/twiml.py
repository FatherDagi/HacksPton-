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
        body = (
            "<Say>This call is recorded and transcribed for dispatch. Connecting you to the station.</Say>"
            "<Start>{stream}</Start>"
            '<Dial answerOnBridge="true" timeout="25">{desk}</Dial>'
            "<Say>The station did not answer. Please call back.</Say>"
        ).format(stream=stream, desk=xml_escape(desk))
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
