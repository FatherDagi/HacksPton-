"""Phone audio helpers. Twilio sends 8 kHz mu-law frames."""

import struct
import warnings

# The C audio module is ~50x faster than the pure-Python fallbacks below, which matters on a small
# hosted CPU (Render's free plan gets a tenth of a core) handling ~100 audio chunks a second per call.
# It exists through Python 3.12 (removed in 3.13); without it the Python versions are used.
with warnings.catch_warnings():
    warnings.simplefilter("ignore", DeprecationWarning)
    try:
        import audioop
    except ImportError:  # Python 3.13+
        audioop = None

RATE = 8000
_RESAMPLE_STATE = {}  # stream key -> audioop.ratecv state, so chunk edges join without gaps
FRAME = 160


def _decode_mulaw(value):
    # ITU-T G.711 mu-law.
    value = (~value) & 0xFF
    sign = value & 0x80
    exponent = (value >> 4) & 0x07
    mantissa = value & 0x0F
    sample = ((mantissa << 3) + 0x84) << exponent
    sample -= 0x84
    if sign:
        sample = -sample
    if sample > 32767:
        return 32767
    if sample < -32768:
        return -32768
    return sample


MULAW_TABLE = tuple(_decode_mulaw(i) for i in range(256))


def pcm16_to_mulaw(pcm):
    """Encode mono PCM16 as G.711 mu-law for a Twilio call."""
    count = len(pcm) // 2
    if count == 0:
        return b""
    samples = struct.unpack("<{}h".format(count), pcm[: count * 2])
    return bytes(_encode_mulaw(sample) for sample in samples)


def _encode_mulaw(sample):
    sign = 0x80 if sample < 0 else 0
    if sample < 0:
        sample = -sample
    if sample > 32635:
        sample = 32635
    sample += 0x84
    exponent = 7
    mask = 0x4000
    while exponent > 0 and not (sample & mask):
        exponent -= 1
        mask >>= 1
    mantissa = (sample >> (exponent + 3)) & 0x0F
    return (~(sign | (exponent << 4) | mantissa)) & 0xFF


def mulaw_to_pcm16(data):
    if not data:
        return b""
    if audioop is not None:
        return audioop.ulaw2lin(data, 2)
    samples = [MULAW_TABLE[byte] for byte in data]
    return struct.pack("<{}h".format(len(samples)), *samples)


def rms_pcm16(pcm):
    count = len(pcm) // 2
    if count == 0:
        return 0.0
    if audioop is not None:
        return float(audioop.rms(pcm[: count * 2], 2))
    samples = struct.unpack("<{}h".format(count), pcm[: count * 2])
    total = 0
    for sample in samples:
        total += sample * sample
    return (total / float(count)) ** 0.5


def resample_pcm16(pcm, in_rate, out_rate, stream=None):
    """Resample mono 16-bit PCM. Live transcription wants 16 kHz. Pass `stream` (any hashable, e.g.
    (call_id, track)) for a continuous stream cut into chunks, so the chunk edges join seamlessly."""
    if not pcm or in_rate == out_rate:
        return pcm or b""
    count = len(pcm) // 2
    if count == 0 or in_rate <= 0 or out_rate <= 0:
        return b""
    if audioop is not None and stream is not None:
        # Live call audio: fast C resampler, carrying its state across chunks of the same stream.
        out, state = audioop.ratecv(pcm[: count * 2], 2, 1, in_rate, out_rate, _RESAMPLE_STATE.get(stream))
        if len(_RESAMPLE_STATE) > 64:
            _RESAMPLE_STATE.clear()  # old calls; a stream just restarts its state
        _RESAMPLE_STATE[stream] = state
        return out
    # One-off clips: exact-length linear resample.
    samples = struct.unpack("<{}h".format(count), pcm[: count * 2])
    out_count = int(round(count * float(out_rate) / float(in_rate)))
    if out_count <= 0:
        return b""
    step = float(in_rate) / float(out_rate)
    out = []
    last = count - 1
    for index in range(out_count):
        position = index * step
        left = int(position)
        if left >= last:
            out.append(samples[last])
            continue
        mix = position - left
        value = samples[left] * (1.0 - mix) + samples[left + 1] * mix
        if value > 32767:
            value = 32767
        elif value < -32768:
            value = -32768
        out.append(int(round(value)))
    return struct.pack("<{}h".format(len(out)), *out)


def wav_to_pcm16(wav):
    """Return (pcm16, sample_rate) from a WAV file, or (None, 0)."""
    if not wav or len(wav) < 44 or not wav.startswith(b"RIFF"):
        return None, 0
    channels = 1
    rate = 16000
    bits = 16
    pcm = b""
    pos = 12
    while pos + 8 <= len(wav):
        chunk = wav[pos : pos + 4]
        size = int.from_bytes(wav[pos + 4 : pos + 8], "little")
        body = wav[pos + 8 : pos + 8 + size]
        if chunk == b"fmt " and len(body) >= 16:
            channels = int.from_bytes(body[2:4], "little") or 1
            rate = int.from_bytes(body[4:8], "little") or 16000
            bits = int.from_bytes(body[14:16], "little")
        elif chunk == b"data":
            pcm = body
            break
        pos += 8 + size + (size % 2)
    if bits != 16 or not pcm:
        return None, 0
    if channels > 1:
        count = len(pcm) // 2
        samples = struct.unpack("<{}h".format(count), pcm[: count * 2])
        mono = samples[0::channels]
        pcm = struct.pack("<{}h".format(len(mono)), *mono)
    return pcm, rate


def pcm16_to_wav(pcm, sample_rate):
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        36 + len(pcm),
        b"WAVE",
        b"fmt ",
        16,
        1,
        1,
        sample_rate,
        sample_rate * 2,
        2,
        16,
        b"data",
        len(pcm),
    )
    return header + pcm


class MulawSegmenter(object):
    """Group mu-law frames into short utterances split on a pause."""

    # Short slices so the transcript can start while the caller is still talking.
    SILENCE_RMS = 500
    MIN_VOICED = int(0.45 * RATE)
    MAX_BYTES = int(2.0 * RATE)
    SILENCE_FLUSH = int(0.28 * RATE)
    TAIL = int(0.08 * RATE)
    FLUSH_MIN = int(0.3 * RATE)

    def __init__(self):
        self.partial = bytearray()
        self.buf = bytearray()
        self.silence = 0
        self.voiced = False

    def push(self, payload):
        self.partial.extend(payload)
        ready = []
        while len(self.partial) >= FRAME:
            frame = bytes(self.partial[:FRAME])
            del self.partial[:FRAME]
            chunk = self._frame(frame)
            if chunk:
                ready.append(chunk)
        return ready

    def flush(self):
        self.partial.clear()
        voiced_bytes = len(self.buf) - self.silence
        if self.voiced and voiced_bytes >= self.FLUSH_MIN:
            return self._take()
        self._reset()
        return None

    def _frame(self, frame):
        energy = rms_pcm16(mulaw_to_pcm16(frame))
        if energy >= self.SILENCE_RMS:
            self.buf.extend(frame)
            self.silence = 0
            self.voiced = True
        elif self.voiced:
            self.buf.extend(frame)
            self.silence += len(frame)
        if not self.voiced:
            return None
        if self.silence < self.SILENCE_FLUSH and len(self.buf) < self.MAX_BYTES:
            return None
        voiced_bytes = len(self.buf) - self.silence
        if self.silence >= self.SILENCE_FLUSH and voiced_bytes < self.MIN_VOICED:
            self._reset()
            return None
        return self._take()

    def _take(self):
        if self.silence > self.TAIL:
            audio = bytes(self.buf[: len(self.buf) - self.silence + self.TAIL])
        else:
            audio = bytes(self.buf)
        self._reset()
        return audio

    def _reset(self):
        self.buf = bytearray()
        self.silence = 0
        self.voiced = False
