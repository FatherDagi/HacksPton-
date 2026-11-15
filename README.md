# Emergency Dispatch Copilot

HackPrinceton Fall 2026. An AI-assisted dispatch workstation that listens to a (simulated) emergency call, fills in a critical information sheet, lists questions still to ask, proposes a priority for human review, and recommends the best available unit. **The dispatcher always makes the final decision. The AI never dispatches on its own.**

> **Simulation only — not for operational use.** All calls, people, units and incidents are fictional. Nothing connects to real emergency services.

## Run it

```bash
npm install
cp .env.example .env.local   # then paste your Gemini key into .env.local
npm run dev                  # HQ console + patrol terminal + sync
npm run desk                 # optional: station desk for live/translated calls (port 8787)
```

Open http://localhost:3000 and pick **Dispatcher** (`/console`) or **Patrol officer** (`/officer`). A second laptop on the same network can open `http://<host-ip>:3000`; every screen stays in sync through `/api/sync`.

## Pages

| Route | What it is |
| --- | --- |
| `/console` | **Primary HQ console**: map-first docks, Clery, backup, patrol beats, desk call banners, places pins, officer-update feed, Gemini extract |
| `/officer` | Patrol terminal (`?unit=U1`): map-first phone/laptop sheet, Free/Busy, ack, backup, officer-update ACKs, live sync |
| `/dispatch` | Classic workstation with left-rail drawers (Transcript · Questions · Activity) |
| `/incidents` | Day / incident history |
| `/incidents/[id]` | Incident record, Clery sign-off, transcript, audit timeline, Sheets export stub |
| `/building` | Sponsor building intelligence placeholders |

## Live calls from the station desk

`station-desk/` answers the station phone (Twilio) or a practice call, streams audio to Gemini Live, and translates the caller into English. With `npm run desk` running, a ringing call shows a banner over the HQ map and opens automatically once answered:

- English transcript streams into the console; Gemini fills the sheet after each finished caller sentence
- Call is classified and pinned from the places database (`data/princeton-places.json`, ~667 places)
- Other places mentioned get their own map pins on HQ and every patrol terminal
- Console call ends when the desk call ends

Proxy: `/api/desk` → `STATION_DESK_URL` (default `http://127.0.0.1:8787`). Scripted demos still work when the desk is offline.

## Vercel (multi-service)

Root `vercel.json` deploys two services in one project:

| Service | Public path | Notes |
| --- | --- | --- |
| `app` (Next.js) | `/` | HQ console, patrol, Next `/api/*` |
| `station-desk` (FastAPI) | `/desk` | Desk UI, Twilio webhooks, websockets |

`app` binds to `station-desk` as `STATION_DESK_URL` (do not set that env yourself on Vercel). For Twilio, set `PUBLIC_BASE_URL` to `https://<deployment>.vercel.app/desk`.

## Status

| Feature | State |
| --- | --- |
| Three scripted calls (medical, fire, security), progressive transcript | Working |
| Critical info sheet with Confirmed / Unverified / Unknown, evidence quotes, dispatcher edits that AI can't overwrite | Working |
| Curated question checklists, mark answered / dismissed | Working |
| Transparent P1–P4 demo rules, confirm or override with reason | Working |
| Deterministic unit ranking, simulated ETAs, closure-aware routes, approve / decline with confirmation | Working |
| Leaflet + OpenStreetMap campus map with unit markers, closures, routes | Working |
| Officer page synced in real time (assignments, updates, dispatcher ↔ officer messages) | Working; across devices on Vercel via Supabase (see below) |
| Gemini extraction (`/api/extract`, Zod-validated, falls back to prerecorded) | Implemented; needs `GEMINI_API_KEY` |
| Supabase shared sync log (`supabase/migrations`, `src/lib/syncHub.ts`) | Working when `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are set; in-memory otherwise |
| Google Sheets export | Stub, returns "not configured" |
| Matterport / Vexcel / CoStar | Placeholders |

When Gemini is not configured or fails, the UI says **"Prerecorded demo extraction (not AI)"** so it never implies AI output.

## Shared sync on Vercel (Supabase)

Every screen's actions (assignments, acknowledgements, officer updates, dispatcher ↔ officer messages)
go through one ordered log at `/api/sync`. Locally that log lives in the dev server's memory. On Vercel
each request can hit a different server instance, so the log must live in Postgres, or screens see
different states and officers jump around the map.

1. Create a Supabase project (free tier is fine).
2. Supabase → SQL Editor → paste `supabase/migrations/20261115000000_sync_hub.sql` → Run.
3. Vercel → Project → Settings → Environment Variables: add `SUPABASE_URL` (Project URL) and
   `SUPABASE_SERVICE_ROLE_KEY` (Project Settings → API → service_role). Redeploy.

The browser never talks to Supabase directly; only the server route uses the service key, and the
tables have row-level security on with no policies, so the public anon key can't read or write them.

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

## Rules

- Demo uses scripted fake calls only. No invented survival statistics.
- Never commit API keys. Secrets live in `.env.local` (git-ignored); see `.env.example`.
