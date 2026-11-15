// Sync hub for the demo: one ordered action log in server memory. Every laptop posts its actions here
// and polls for the ones it hasn't seen. State lives as long as the dev server process (fine for a demo).
import { NextResponse } from "next/server";
import { reduce, seedState, type Action } from "@/lib/reducer";
import type { AppState } from "@/lib/types";

interface Entry { seq: number; client: string; cid: number; action: Action }
interface Hub { state: AppState; seq: number; log: Entry[]; terminals: Record<string, number>; rosterRev?: number }

const KEEP = 3000; // log entries kept; older clients get a full snapshot instead
const ROSTER_REV = 9; // bump: attending priorities, queued multi-assign
const g = globalThis as unknown as { __edcHub?: Hub };
const hub: Hub = (g.__edcHub ??= { state: seedState(), seq: 0, log: [], terminals: {}, rosterRev: ROSTER_REV });
// Hot-reload safety: older in-memory hubs may predate newer AppState fields.
if (!hub.state.backups) hub.state = { ...hub.state, backups: [] };
if (!hub.state.messages) hub.state = { ...hub.state, messages: [] };
if (!hub.state.cleryLog) hub.state = { ...hub.state, cleryLog: [] };
if (!hub.state.officerUpdates) hub.state = { ...hub.state, officerUpdates: [] };
hub.state = {
  ...hub.state,
  incidents: hub.state.incidents.map((i) => ({
    ...i,
    clerySignOff: i.clerySignOff ?? null,
    mentionedPlaces: i.mentionedPlaces ?? [],
  })),
};
if (hub.rosterRev !== ROSTER_REV) {
  // Full demo reseed: multi-case board + busy units already moving.
  hub.state = seedState();
  hub.rosterRev = ROSTER_REV;
  hub.seq += 1;
}

export function GET(req: Request) {
  const url = new URL(req.url);
  const since = Number(url.searchParams.get("since") ?? -1);
  const unit = url.searchParams.get("unit");
  const now = Date.now();
  if (unit) hub.terminals[unit] = now;
  const oldest = hub.log[0]?.seq ?? hub.seq + 1;
  const body =
    since < 0 || since > hub.seq || since + 1 < oldest
      ? { seq: hub.seq, snapshot: hub.state }
      : { seq: hub.seq, actions: hub.log.filter((e) => e.seq > since) };
  return NextResponse.json({ ...body, terminals: hub.terminals, now });
}

export async function POST(req: Request) {
  const { client, cid, action } = (await req.json()) as { client: string; cid: number; action: Action };
  if (!action || typeof action.type !== "string") return NextResponse.json({ error: "bad action" }, { status: 400 });
  hub.state = reduce(hub.state, action);
  if (action.type === "RESET") hub.terminals = {};
  const e = { seq: ++hub.seq, client, cid, action };
  hub.log.push(e);
  if (hub.log.length > KEEP) hub.log.splice(0, hub.log.length - KEEP);
  return NextResponse.json({ seq: e.seq });
}
