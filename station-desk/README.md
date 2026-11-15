# Station Desk

The station number receives the call. This program streams a transcript with Gemini, marks keywords, and saves a text file for each call.

## Run it

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Put your Gemini API key in `.env` as `GEMINI_API_KEY`, then:

```bash
python -m uvicorn app.main:app --host 127.0.0.1 --port 8787
```

Open http://127.0.0.1:8787 and use **Take a practice call**. The words fill in while you are still speaking. **Save text file** downloads the transcript. A copy is also written under `transcripts/`.

You can also upload a wav, mp3, m4a, ogg, flac, or webm recording of a call.

## Connect the real number

A phone app cannot record the cellular Phone app on an iPhone, and Android is similarly locked down. The desk sits on the phone line instead.

1. Create a [Twilio](https://www.twilio.com/) phone number.
2. Expose this program with a tunnel, for example `ngrok http 8787`.
3. Set `PUBLIC_BASE_URL` to that https address, with no path on the end.
4. In Twilio, set the number's voice webhook to `POST https://YOUR-ADDRESS/twilio/voice`.
5. Set `TWILIO_AUTH_TOKEN` so the desk can reject anything that is not Twilio.
6. Set `STATION_DESK_NUMBER` to the station phone, in the form `+15551234567`.

On a call, the caller hears a recording notice, the station phone rings, and both sides are transcribed on this screen. Leave `STATION_DESK_NUMBER` blank and the caller is asked to state the problem while the desk only listens. In that mode the dispatcher cannot talk back through the browser.

Restart the program after changing `.env`.

## Notes

The desk keeps a Gemini Live session open for the whole call and streams the audio as it arrives. Words appear on the live line while someone is still talking. When they pause, that line is replaced by a cleaned English sentence. Keywords are marked from the words on the screen.

The live model is `gemini-3.5-transcribe-live`. Set `GEMINI_LIVE_MODEL` only if you need a different one. `GEMINI_MODEL` is used for keyword cleanup on saved text, and for recordings the live session cannot read (such as mp3).

A live session covers about 10 minutes of audio. Start a new practice call if one runs longer than that.

Keep the transcripts under your department's recording and retention rules. The greeting tells the caller the call is transcribed.
