// Server side of the sync hub: one ordered action log shared by every screen (dispatch consoles,
// patrol terminals). Officer assignments, acknowledgements and dispatcher <-> officer messages all
// travel through it.
//
// Locally (`npm run dev`) there is a single server process, so the log lives in memory.
// On Vercel every request can land on a different function instance, each with its own memory, so
// screens would see different states and officers would jump between them. When Supabase is
// configured (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, tables from supabase/migrations), the log lives
// in Postgres and every instance replays the same log on top of the same seed.
import { emptyFields } from "@/lib/fields";
import { reduce, seedState, type Action } from "@/lib/reducer";
import type { AppState } from "@/lib/types";

export interface Entry { seq: number; client: string; cid: number; action: Action }
export interface SyncBody {
  seq: number;
  snapshot?: AppState;
  actions?: Entry[];
  terminals: Record<string, number>;
  now: number;
}

const KEEP = 3000; // log entries kept; older clients get a full snapshot instead
const ROSTER_REV = 10; // bump: clean board (no seeded cases); a bump reseeds the demo
const SNAP_EVERY = 200; // save a fresh snapshot this many actions after the last one

/** Older states (hot reload, older snapshots) may predate newer AppState fields. */
export function upgrade(s: AppState): AppState {
  return {
    ...s,
    backups: s.backups ?? [],
    messages: s.messages ?? [],
    cleryLog: s.cleryLog ?? [],
    officerUpdates: s.officerUpdates ?? [],
    incidents: s.incidents.map((i) => ({
      ...i,
      fields: { ...emptyFields(), ...i.fields }, // cases saved before newer fields existed
      clerySignOff: i.clerySignOff ?? null,
      mentionedPlaces: i.mentionedPlaces ?? [],
    })),
  };
}

export class BadAction extends Error {}

/** Apply an action, refusing anything the reducer doesn't understand (it would wipe the state). */
function apply(state: AppState, action: Action): AppState {
  const next = reduce(state, action);
  if (!next || !Array.isArray(next.incidents) || !Array.isArray(next.officers)) throw new BadAction(`unknown action ${action.type}`);
  return next;
}

function since(log: Entry[], seq: number, after: number, state: AppState) {
  const oldest = log[0]?.seq ?? seq + 1;
  return after < 0 || after > seq || after + 1 < oldest
    ? { seq, snapshot: state }
    : { seq, actions: log.filter((e) => e.seq > after) };
}

// ---------------------------------------------------------------- in-memory hub (one process)

interface MemHub { state: AppState; seq: number; log: Entry[]; terminals: Record<string, number>; rosterRev?: number }

function memHub(): MemHub {
  const g = globalThis as unknown as { __edcHub?: MemHub };
  const hub = (g.__edcHub ??= { state: seedState(), seq: 0, log: [], terminals: {}, rosterRev: ROSTER_REV });
  if (hub.rosterRev !== ROSTER_REV || !Array.isArray(hub.state?.incidents)) {
    // Roster bump, or a state broken by a bad action before validation existed: reseed.
    hub.state = seedState();
    hub.rosterRev = ROSTER_REV;
    hub.seq += 1;
    hub.log = [];
  }
  hub.state = upgrade(hub.state);
  return hub;
}

// ---------------------------------------------------------------- Supabase hub (many instances)

const SB_URL = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
export const sharedHub = Boolean(SB_URL && SB_KEY);

const NS = `demo-v${ROSTER_REV}`; // a roster bump starts a fresh namespace = fresh seed

/** Call one of the sync_* SQL functions through Supabase's REST API (server only: service role key). */
async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(args),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`supabase ${fn} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

interface Replica { state: AppState; seq: number; log: Entry[]; snapSeq: number }
const g = globalThis as unknown as { __edcReplica?: Replica; __edcCatchUp?: Promise<Replica>; __edcInit?: Promise<Replica> };

async function loadSnapshot(): Promise<Replica> {
  // First instance ever writes the one shared seed; everyone else gets the latest saved snapshot.
  const snap = await rpc<{ seq: number; state: AppState }>("sync_init", { p_ns: NS, p_seed: seedState() });
  return { state: upgrade(snap.state), seq: snap.seq, log: [], snapSeq: snap.seq };
}

/** Make sure the namespace exists before the first write from this instance. */
function initialised(): Promise<Replica> {
  return (g.__edcInit ??= loadSnapshot().catch((e) => { g.__edcInit = undefined; throw e; }));
}

interface Pull { seq: number; entries: Entry[]; terminals: Record<string, number> }
let lastTerminals: Record<string, number> = {};
const heartbeats = new Set<string>(); // patrol terminals that polled since the last pull went out

async function catchUp(retry = true): Promise<Replica> {
  let r = g.__edcReplica ?? (await initialised());
  const units = [...heartbeats];
  heartbeats.clear();
  const p = await rpc<Pull>("sync_pull", { p_ns: NS, p_after: r.seq, p_units: units, p_now: Date.now(), p_limit: KEEP });
  lastTerminals = p.terminals ?? {};
  const fresh = p.entries.filter((e) => e.seq > r.seq && e.seq <= p.seq);
  if (fresh.length && fresh[0].seq !== r.seq + 1) {
    // This instance fell behind the kept log: restart from the latest snapshot, once.
    if (!retry) throw new Error("sync log gap");
    g.__edcReplica = await loadSnapshot();
    return catchUp(false);
  }
  if (fresh.length) {
    let state = r.state;
    for (const e of fresh) {
      try { state = apply(state, e.action); } catch { /* skip an action this build doesn't know */ }
    }
    const seq = fresh[fresh.length - 1].seq;
    r = { state, seq, log: [...r.log, ...fresh].slice(-KEEP), snapSeq: r.snapSeq };
    if (seq - r.snapSeq >= SNAP_EVERY) {
      await rpc("sync_save_snapshot", { p_ns: NS, p_seq: seq, p_state: state });
      r.snapSeq = seq;
    }
  }
  g.__edcReplica = r;
  return r;
}

/** One catch-up at a time per instance; concurrent polls share it. */
function replica(): Promise<Replica> {
  return (g.__edcCatchUp ??= catchUp().finally(() => { g.__edcCatchUp = undefined; }));
}

// ---------------------------------------------------------------- public API used by /api/sync

export async function readSync(after: number, unit: string | null): Promise<SyncBody> {
  const now = Date.now();
  if (!sharedHub) {
    const hub = memHub();
    if (unit) hub.terminals[unit] = now;
    return { ...since(hub.log, hub.seq, after, hub.state), terminals: hub.terminals, now };
  }
  if (unit) heartbeats.add(unit); // goes out with this or the next pull
  let r = await replica();
  // This screen already saw a newer action (via another instance): pull again rather than send it an
  // older snapshot, which would make its officers jump backwards.
  if (after > r.seq) r = await catchUp();
  return { ...since(r.log, r.seq, after, r.state), terminals: lastTerminals, now };
}

export async function appendAction(client: string, cid: number, action: Action): Promise<number> {
  if (!sharedHub) {
    const hub = memHub();
    hub.state = apply(hub.state, action);
    if (action.type === "RESET") hub.terminals = {};
    const e = { seq: ++hub.seq, client, cid, action };
    hub.log.push(e);
    if (hub.log.length > KEEP) hub.log.splice(0, hub.log.length - KEEP);
    return e.seq;
  }
  apply((g.__edcReplica ?? (await initialised())).state, action); // validate before it enters the shared log
  const seq = await rpc<number>("sync_append", { p_ns: NS, p_client: client, p_cid: cid, p_action: action, p_keep: KEEP });
  return Number(seq);
}
