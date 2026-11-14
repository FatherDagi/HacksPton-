# Emergency Dispatch Copilot

HackPrinceton Fall 2026. An AI-assisted dispatch workstation that listens to a (simulated) emergency call, fills in a critical information sheet, lists questions still to ask, proposes a priority for human review, and recommends the best available unit. **The dispatcher always makes the final decision. The AI never dispatches on its own.**

> **Simulation only — not for operational use.** All calls, people, units and incidents are fictional. Nothing connects to real emergency services.

## Run it

```bash
npm install
cp .env.example .env.local   # then paste your Gemini key into .env.local
npm run dev
```

Open http://localhost:3000/dispatch, pick a scenario, and press **Run demo scenario**. Open `/officer?unit=M1` (or the link shown after you approve an assignment) in another tab to act as the responder.

## Pages

| Route | What it is |
| --- | --- |
| `/console` | **Combined console** (same store and Gemini extraction): real campus map (light/dark streets, 2025 satellite, 2020 NJ leaf-off, 3D), real road/footpath routes, team recommendation (e.g. 2 officers + EMS for a weapon), live re-grade P2→P1 mid-call, officers travel their routes, AI and dispatcher log, light/dark mode, keyboard shortcuts (Y send · N swap · E next line · C confirm · 1–4 override · T theme), phone layout |
| `/dispatch` | Map-first CAD workstation: campus map with a left rail (Transcript · AI Questions · Activity Log drawers that slide over the map) and a permanent incident panel (priority, missing info, recommended unit with approval, officer communication with dispatcher-approved updates and officer acknowledgment) |
| `/officer` | Mobile responder page: assignment, Acknowledge, Available / Busy / Responding / On scene |
| `/incidents` | Incident history |
| `/incidents/[id]` | Incident record, transcript and full audit timeline, Google Sheets export |
| `/building` | Sponsor building intelligence (Matterport / Vexcel / CoStar), placeholders until data is connected |

## Status

| Feature | State |
| --- | --- |
| Three scripted calls (medical, fire, security), progressive transcript | Working |
| Critical info sheet with Confirmed / Unverified / Unknown, evidence quotes, dispatcher edits that AI can't overwrite | Working |
| Curated question checklists, mark answered / dismissed | Working |
| Transparent P1–P4 demo rules, confirm or override with reason | Working |
| Deterministic unit ranking, simulated ETAs, closure-aware routes, approve / decline with confirmation | Working |
| Leaflet + OpenStreetMap campus map with unit markers, closures, routes | Working |
| Officer page synced in real time | Working across tabs in one browser; cross-device needs Supabase |
| Gemini extraction (`/api/extract`, Zod-validated, falls back to prerecorded) | Implemented; needs `GEMINI_API_KEY` |
| Supabase database + realtime | Pending |
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
