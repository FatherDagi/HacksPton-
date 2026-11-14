# Emergency Dispatch Copilot

HackPrinceton Fall 2026. An AI-assisted dispatch workstation that listens to a (simulated) emergency call, fills in a critical information sheet, lists questions still to ask, proposes a priority for human review, and recommends the best available unit. **The dispatcher always makes the final decision. The AI never dispatches on its own.**

> **Simulation only — not for operational use.** All calls, people, units and incidents are fictional. Nothing connects to real emergency services.

## Run it

```bash
npm install
cp .env.example .env.local   # then paste your Gemini key into .env.local
npm run dev                  # dispatcher console + patrol terminal + sync server
npm run desk                 # optional: station desk for live/translated calls (port 8787)
```

Open http://localhost:3000 and pick **Dispatcher** (`/console`, the primary product) or **Patrol officer** (`/officer`). A second laptop on the same network can open `http://<host-ip>:3000`; every screen stays in sync through `/api/sync`.

## Pages

| Route | What it is |
| --- | --- |
| `/console` | **Primary product.** Map-first dispatch console: real campus map (streets, satellite, NJ leaf-off, 3D) with a left rail of pull-out drawers (Transcript · AI questions · Activity log) that slide over the map; AI team recommendation with Y/N approval; live re-grades; officers travel real routes; incident details with confirm/override; officer communication (pending changes since dispatch, sent only after dispatcher review, acknowledged on the patrol terminal); **Take live call** from the station desk |
| `/officer` | Patrol-car terminal: pick a unit, receive dispatches with live notes and route, acknowledge assignments and dispatcher updates |
| `/dispatch` | Classic view (fallback): Leaflet map-first workstation |
| `/incidents`, `/incidents/[id]` | Incident history and full audit timeline |
| `/building` | Sponsor building intelligence placeholders (Matterport / Vexcel / CoStar) |

## Live calls from the station desk

`station-desk/` (Sagar's Python server) answers the station phone (Twilio) or a practice call, streams the audio to Gemini Live, and translates the caller into English. With `npm run desk` running, the console shows **Take live call**:

- the desk's English transcript streams into the Transcript drawer (sentences rebuilt from the desk's fragments; words still being spoken show as a live line)
- Gemini fills the incident sheet after each finished caller sentence
- the call is classified (medical / fire / police) and placed on a campus building from what the caller said; both are logged and editable
- the console call ends when the desk call ends

The console reads the desk through a read-only proxy (`/api/desk`, `STATION_DESK_URL`, default `http://127.0.0.1:8787`). Scripted demo calls keep working when the desk is offline.

## Status

| Feature | State |
| --- | --- |
| Three scripted calls (medical, fire, security), progressive transcript | Working |
| Critical info sheet with Confirmed / Unverified / Unknown, evidence quotes, dispatcher edits that AI can't overwrite | Working |
| Curated question checklists, mark answered / dismissed | Working |
| Transparent P1–P4 demo rules, confirm or override with reason | Working |
| Deterministic unit ranking, simulated ETAs, closure-aware routes, approve / decline with confirmation | Working |
| Leaflet + OpenStreetMap campus map with unit markers, closures, routes | Working |
| Console and patrol terminal synced in real time | Working across laptops on one network (`/api/sync`, in-memory) |
| Gemini extraction (`/api/extract`, Zod-validated, falls back to prerecorded) | Implemented; needs `GEMINI_API_KEY` |
| Persistent database (Supabase) | Not used; demo state lives in the dev server's memory |
| Google Sheets export | Stub, returns "not configured" |
| Matterport / Vexcel / CoStar | Placeholders |

When Gemini is not configured or fails, the UI says **"Prerecorded demo extraction (not AI)"** so it never implies AI output.

## Architecture

```
src/
  app/
    dispatch/ officer/ incidents/ incidents/[id]/ building/   pages
    api/extract/route.ts          Gemini extraction (server-side key only)
    api/export/sheets/route.ts    Google Sheets export (stub)
  components/
    dispatch/  Workstation, CallPanel, IncidentSheet, UnitsPanel, CampusMap
    officer/   OfficerView
    incidents/ IncidentList, IncidentDetail
    ui.tsx     shared primitives
  lib/
    types.ts       shared data models
    campus.ts      buildings, closures, seed units (fictional)
    scenarios.ts   prerecorded calls + precomputed extraction
    fields.ts      field catalogue + question checklists
    priority.ts    illustrative P1–P4 rules (not MPDS / not clinical)
    recommend.ts   eligibility, ranking, simulated ETA + routes
    extraction.ts  Zod schemas + Gemini JSON schema
    store.ts       action/reducer store, cross-tab sync
```

## Standalone HTML console

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

- Demo uses scripted fake calls only. No invented survival statistics.
- Never commit API keys. Secrets live in `.env.local` (git-ignored); see `.env.example`.
