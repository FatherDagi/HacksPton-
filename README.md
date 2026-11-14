# Emergency Dispatch Copilot

HackPrinceton Fall 2026. An AI copilot that listens to an emergency call alongside the human dispatcher, fills in a critical info sheet, lists questions still to ask, suggests a priority, and recommends the nearest available officer. The dispatcher always makes the final call.

## Dispatcher console

`dispatcher-console/index.html` is a single page. Serve the folder (for example `python3 -m http.server`) and open it in a browser.

- **Four demo calls by danger level:** P1 knife fight, P2 bike crash, P3 bike theft, P4 locked out.
- **The AI suggests how many officers to send** (2 for a weapon, 1 for a lockout) and explains why. Officers are ranked by arrival time over real roads and footpaths.
- **Live re-plan:** in the P2 call, press **E**. The caller mentions a tire iron and the AI upgrades P2 to P1 with 3 officers.
- **AI and dispatcher log:** every AI step quotes the caller's words, and every dispatcher override is recorded.
- **The dispatcher always decides:** **Y** to send, **N** to skip, **1–4** to override the priority.
- **Map:** light/dark street map, 2025 satellite, 2020 NJ leaf-off imagery, 3D buildings, the caller's building outlined, and the PSAFE HQ star. Dispatched officers travel their routes with a live ETA.
- **Light and dark mode:** top-right button, remembered per browser.

All calls are scripted with fake names. Officer positions are simulated and labelled as such.

See [PITCH.md](PITCH.md) for the demo script and judging plan.

## Rules

- Demo uses scripted fake calls only.
- Never commit API keys. Put them in `.env` (ignored by git).
