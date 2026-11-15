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
  /** The HQ screen allowed to animate officers (the one open longest); the others only display. */
  leader: string | null;
  /** True when this device asked to be a patrol officer that another device already holds. */
  unitTaken: boolean;
  now: number;
}

/** Who is asking: a patrol device signed in as `unit`, and/or an HQ screen (`hq`). */
export interface Asker { client: string | null; unit: string | null; hq: boolean }

/** A device's hold on a patrol officer lapses this long after it stops polling. */
const CLAIM_MS = 8_000;
/** HQ screens count as open while they keep polling at least this often. */
const HQ_ACTIVE_MS = 5_000;

interface Presence { client: string; first: number; last: number }

/** Heartbeat `key` for `client`; refused when another client holds it and is still active. */
function beat(presence: Record<string, Presence>, key: string, client: string, now: number): boolean {
  const p = presence[key];
  if (p && p.client !== client && now - p.last < CLAIM_MS) return false;
  presence[key] = { client, first: p && p.client === client ? p.first : now, last: now };
  return true;
}

/** Terminals map (unit -> last seen), the HQ leader, and whether `asker` lost its unit claim. */
function fromPresence(presence: Record<string, Presence>, asker: Asker, now: number) {
  const terminals: Record<string, number> = {};
  let leader: Presence | null = null;
  for (const [key, p] of Object.entries(presence)) {
    if (key.startsWith("unit:")) terminals[key.slice(5)] = p.last;
    else if (key.startsWith("hq:") && now - p.last < HQ_ACTIVE_MS) {
      if (!leader || p.first < leader.first || (p.first === leader.first && p.client < leader.client)) leader = p;
    }
  }
  const held = asker.unit ? presence[`unit:${asker.unit}`] : undefined;
  const unitTaken = !!(held && asker.client && held.client !== asker.client && now - held.last < CLAIM_MS);
  return { terminals, leader: leader?.client ?? null, unitTaken };
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

interface MemHub { state: AppState; seq: number; log: Entry[]; presence: Record<string, Presence>; rosterRev?: number }

function memHub(): MemHub {
  const g = globalThis as unknown as { __edcHub?: MemHub };
  const hub = (g.__edcHub ??= { state: seedState(), seq: 0, log: [], presence: {}, rosterRev: ROSTER_REV });
  if (hub.rosterRev !== ROSTER_REV || !Array.isArray(hub.state?.incidents)) {
    // Roster bump, or a state broken by a bad action before validation existed: reseed.
    hub.state = seedState();
    hub.rosterRev = ROSTER_REV;
    hub.seq += 1;
    hub.log = [];
  }
  hub.state = upgrade(hub.state);
  hub.presence ??= {}; // hubs from before presence existed (hot reload)
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
    // New-style secret keys (sb_secret_…) go in the apikey header only; legacy service_role keys are
    // JWTs and are also sent as a Bearer token.
    headers: SB_KEY.startsWith("sb_")
      ? { apikey: SB_KEY, "content-type": "application/json" }
      : { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`, "content-type": "application/json" },
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

interface Pull { seq: number; entries: Entry[]; presence: Record<string, Presence> }
let lastPresence: Record<string, Presence> = {};
const heartbeats = new Map<string, string>(); // presence key -> client, sent with the next pull

async function catchUp(retry = true): Promise<Replica> {
  let r = g.__edcReplica ?? (await initialised());
  const beats = [...heartbeats].map(([key, client]) => ({ key, client }));
  heartbeats.clear();
  const p = await rpc<Pull>("sync_pull", {
    p_ns: NS, p_after: r.seq, p_beats: beats, p_now: Date.now(), p_claim_ms: CLAIM_MS, p_limit: KEEP,
  });
  lastPresence = p.presence ?? {};
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

export async function readSync(after: number, asker: Asker): Promise<SyncBody> {
  const now = Date.now();
  if (!sharedHub) {
    const hub = memHub();
    if (asker.client && asker.unit) beat(hub.presence, `unit:${asker.unit}`, asker.client, now);
    if (asker.client && asker.hq) beat(hub.presence, `hq:${asker.client}`, asker.client, now);
    return { ...since(hub.log, hub.seq, after, hub.state), ...fromPresence(hub.presence, asker, now), now };
  }
  // Heartbeats go out with this or the next pull; the database decides who holds each officer.
  if (asker.client && asker.unit) heartbeats.set(`unit:${asker.unit}`, asker.client);
  if (asker.client && asker.hq) heartbeats.set(`hq:${asker.client}`, asker.client);
  let r = await replica();
  // This screen already saw a newer action (via another instance): pull again rather than send it an
  // older snapshot, which would make its officers jump backwards.
  if (after > r.seq) r = await catchUp();
  return { ...since(r.log, r.seq, after, r.state), ...fromPresence(lastPresence, asker, now), now };
}

export async function appendAction(client: string, cid: number, action: Action): Promise<number> {
  if (!sharedHub) {
    const hub = memHub();
    hub.state = apply(hub.state, action);
    const e = { seq: ++hub.seq, client, cid, action };
    hub.log.push(e);
    if (hub.log.length > KEEP) hub.log.splice(0, hub.log.length - KEEP);
    return e.seq;
  }
  apply((g.__edcReplica ?? (await initialised())).state, action); // validate before it enters the shared log
  const seq = await rpc<number>("sync_append", { p_ns: NS, p_client: client, p_cid: cid, p_action: action, p_keep: KEEP });
  return Number(seq);
}
