# Emergency Dispatch Copilot

HackPrinceton Fall 2026. An AI copilot that listens to an emergency call alongside the human dispatcher, fills in a critical info sheet, lists questions still to ask, suggests a priority, and recommends the nearest available officer. The dispatcher always makes the final call.

## Dispatcher console (design prototype)

`dispatcher-console/index.html` is a single, dependency-free page. Open it in any browser.

- Left: call transcript and questions still to ask
- Center: suggested officer with a Send? prompt, a pan/zoom Princeton campus map, and an officer table
- Right: incident details (priority, urgency, caller, location, what happened, injured person, suspect)

Officer statuses: **Available**, **Sent to this call**, **On scene** (at this call), **Busy** (on another call).
Distances follow roads (by car) or walkways (on foot).

All data in the page is a scripted demo call with fake names. The campus map is a hand-drawn placeholder for Leaflet + OpenStreetMap.

## Rules

- Demo uses scripted fake calls only.
- Never commit API keys. Put them in `.env` (ignored by git).
