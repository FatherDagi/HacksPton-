"use client";
// Client side of the demo store. Every change is an action. Actions are applied locally at once
// (optimistic) and posted to /api/sync, which puts every laptop's actions in one order. Each client
// polls that log and rebuilds its state as: server-confirmed state + its own not-yet-confirmed actions.
// Works across laptops on the same network (open http://<host-ip>:3000 on the second one).
import { useSyncExternalStore } from "react";
import { emptyFields } from "./fields";
import { reduce, seedState, type Action } from "./reducer";
import type { AppState } from "./types";

export { reduce, seedState, type Action } from "./reducer";

interface Pending { cid: number; action: Action }
export interface SyncResponse {
  seq: number;
  snapshot?: AppState;
  actions?: { seq: number; client: string; cid: number; action: Action }[];
  /** Unit id -> last time a patrol terminal signed in as that unit polled (server clock, ms). */
  terminals: Record<string, number>;
  now: number;
}

const POLL_MS = 250;
const SERVER_SNAPSHOT = seedState();
const clientId = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Math.random());

let confirmed: AppState = SERVER_SNAPSHOT;
let confirmedSeq = -1;
let pending: Pending[] = [];
let nextCid = 1;
let state: AppState = SERVER_SNAPSHOT;
let started = false;
let terminalUnit: string | null = null;
let terminals: Record<string, number> = {};
let serverSkew = 0; // server clock - local clock
let online = false;
const listeners = new Set<() => void>();

function rebuild() {
  const next = pending.reduce((s, p) => reduce(s, p.action), confirmed);
  if (next !== state) state = next;
  listeners.forEach((l) => l());
}

async function poll() {
  try {
    const q = new URLSearchParams({ since: String(confirmedSeq) });
    if (terminalUnit) q.set("unit", terminalUnit);
    const res = await fetch(`/api/sync?${q}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`sync ${res.status}`);
    const j = (await res.json()) as SyncResponse;
    if (j.snapshot) {
      confirmed = {
        ...j.snapshot,
        backups: j.snapshot.backups ?? [],
        messages: j.snapshot.messages ?? [],
        cleryLog: j.snapshot.cleryLog ?? [],
        officerUpdates: j.snapshot.officerUpdates ?? [],
        incidents: j.snapshot.incidents.map((i) => ({
          ...i,
          fields: { ...emptyFields(), ...i.fields },
          clerySignOff: i.clerySignOff ?? null,
          mentionedPlaces: i.mentionedPlaces ?? [],
        })),
      };
      pending = []; // server state already contains anything we sent before a restart/trim
    }
    for (const a of j.actions ?? []) {
      confirmed = reduce(confirmed, a.action);
      if (a.client === clientId) pending = pending.filter((p) => p.cid !== a.cid);
    }
    confirmedSeq = j.seq;
    serverSkew = j.now - Date.now();
    if (JSON.stringify(j.terminals) !== JSON.stringify(terminals)) terminals = j.terminals;
    online = true;
    rebuild();
  } catch {
    if (online) { online = false; listeners.forEach((l) => l()); }
  }
  setTimeout(poll, POLL_MS);
}

function ensureStarted() {
  if (started || typeof window === "undefined") return;
  started = true;
  void poll();
}

export function act(action: Action) {
  ensureStarted();
  const cid = nextCid++;
  pending.push({ cid, action });
  rebuild();
  fetch("/api/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client: clientId, cid, action }) })
    .then((res) => { if (!res.ok) throw new Error(`sync ${res.status}`); })
    .catch(() => {
      // Server unreachable: keep the change locally so this screen still works on its own.
      confirmed = reduce(confirmed, action);
      pending = pending.filter((p) => p.cid !== cid);
      rebuild();
    });
}

/** Call from a patrol terminal page so dispatch knows that unit is signed in (and notices if it drops). */
export function signInTerminal(unitId: string | null) {
  terminalUnit = unitId;
}

function subscribe(l: () => void) {
  ensureStarted();
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useAppState(): AppState {
  return useSyncExternalStore(subscribe, () => state, () => SERVER_SNAPSHOT);
}

const NO_TERMINALS: Record<string, number> = {};
/** Last poll time (local clock) of each signed-in patrol terminal. */
export function useTerminals(): Record<string, number> {
  return useSyncExternalStore(subscribe, () => terminals, () => NO_TERMINALS);
}
export const serverToLocal = (t: number) => t - serverSkew;

export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, () => online, () => false);
}

/** Current time for action timestamps (call only from event handlers). */
export const stamp = () => Date.now();

export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
