"use client";
// Client-side demo store. Every change is an action applied by a deterministic
// reducer; actions are broadcast to other tabs (BroadcastChannel) so the
// /officer page in another tab stays in sync. Supabase Realtime replaces this
// transport in Phase 3 for cross-device sync.
import { useSyncExternalStore } from "react";
import { buildingById, SEED_OFFICERS } from "./campus";
import { emptyFields, initialQuestions } from "./fields";
import { scenarioById } from "./scenarios";
import type {
  AppState, EventActor, FieldKey, FieldStatus, FieldUpdate, Incident, IncidentEvent, OfficerStatus, Priority,
} from "./types";

const STORAGE_KEY = "edc:state:v1";
const CHANNEL = "edc:actions";

export type Action =
  | { type: "START_CALL"; at: number; incidentId: string; number: string; scenarioId: string }
  | { type: "REVEAL_SEGMENT"; at: number; incidentId: string }
  | { type: "APPLY_AI_UPDATES"; at: number; incidentId: string; updates: (FieldUpdate & { evidenceSegmentId: string | null })[]; source: "ai" | "demo" }
  | { type: "END_CALL"; at: number; incidentId: string }
  | { type: "EDIT_FIELD"; at: number; incidentId: string; key: FieldKey; value: string; status: FieldStatus }
  | { type: "SET_QUESTION"; at: number; incidentId: string; questionId: string; state: "open" | "answered" | "dismissed" }
  | { type: "DECIDE_PRIORITY"; at: number; incidentId: string; priority: Priority; proposed: Priority; overrideReason: string | null }
  | { type: "APPROVE_ASSIGNMENT"; at: number; incidentId: string; officerId: string; assignmentId: string; etaSeconds: number }
  | { type: "DECLINE_UNIT"; at: number; incidentId: string; officerId: string }
  | { type: "RESET_DECLINES"; at: number; incidentId: string }
  | { type: "ACK_ASSIGNMENT"; at: number; assignmentId: string }
  | { type: "OFFICER_STATUS"; at: number; officerId: string; status: OfficerStatus }
  | { type: "OFFICER_LOCATION"; at: number; officerId: string; location: [number, number]; label: string }
  | { type: "CLOSE_INCIDENT"; at: number; incidentId: string }
  | { type: "LOG"; at: number; incidentId: string; actor: EventActor; eventType: string; message: string }
  | { type: "RESET" };

let eventSeq = 0;
const evt = (incidentId: string, at: number, actor: EventActor, type: string, message: string): IncidentEvent => ({
  id: `${at}-${++eventSeq}-${type}`,
  incidentId,
  at,
  actor,
  type,
  message,
});

function historicalIncident(id: string, number: string, title: string, buildingId: string, category: Incident["category"], hoursAgo: number): Incident {
  const at = SEED_TIME - hoursAgo * 3600_000;
  const b = buildingById(buildingId)!;
  const fields = emptyFields();
  fields.building = { key: "building", value: b.name, status: "confirmed", source: "dispatcher", evidenceSegmentId: null, updatedAt: at };
  fields.description = { key: "description", value: title, status: "confirmed", source: "dispatcher", evidenceSegmentId: null, updatedAt: at };
  return {
    id, number, scenarioId: null, category, title, buildingId, location: b.location, status: "closed",
    createdAt: at, closedAt: at + 40 * 60_000, callStartedAt: at, callEndedAt: at + 3 * 60_000, revealed: 0,
    transcript: [], fields, questions: [], priorityDecision: { priority: 3, overrideReason: null, decidedAt: at + 60_000 },
    declinedOfficerIds: [],
  };
}

// Fixed seed time keeps server and client snapshots identical.
const SEED_TIME = Date.UTC(2026, 10, 13, 20, 0, 0);

export function seedState(): AppState {
  return {
    rev: 0,
    officers: SEED_OFFICERS.map((o) => ({ ...o, lastLocationAt: SEED_TIME })),
    incidents: [
      historicalIncident("hist-1", "2026-0412", "Bike theft reported (simulated)", "firestone", "police", 20),
      historicalIncident("hist-2", "2026-0413", "Fall on stairs, minor injury (simulated)", "dillon", "medical", 9),
      historicalIncident("hist-3", "2026-0414", "Fire alarm, burnt toast (simulated)", "whitman", "fire", 4),
    ],
    assignments: [],
    events: [],
    activeIncidentId: null,
  };
}

function mapIncident(s: AppState, id: string, fn: (i: Incident) => Incident): AppState {
  return { ...s, incidents: s.incidents.map((i) => (i.id === id ? fn(i) : i)) };
}

export function reduce(s: AppState, a: Action): AppState {
  const next = reduceInner(s, a);
  return next === s ? s : { ...next, rev: s.rev + 1 };
}

function reduceInner(s: AppState, a: Action): AppState {
  switch (a.type) {
    case "RESET":
      return { ...seedState(), rev: s.rev };

    case "START_CALL": {
      const sc = scenarioById(a.scenarioId);
      if (!sc) return s;
      const b = buildingById(sc.buildingId)!;
      const inc: Incident = {
        id: a.incidentId, number: a.number, scenarioId: sc.id, category: sc.category, title: sc.title,
        buildingId: b.id, location: b.location, status: "intake", createdAt: a.at, closedAt: null,
        callStartedAt: a.at, callEndedAt: null, revealed: 0, transcript: [], fields: emptyFields(),
        questions: initialQuestions(sc.category), priorityDecision: null, declinedOfficerIds: [],
      };
      return {
        ...s,
        incidents: [inc, ...s.incidents],
        activeIncidentId: inc.id,
        events: [...s.events, evt(inc.id, a.at, "system", "incident_created", `Incident ${inc.number} created; simulated call started (${sc.title}).`)],
      };
    }

    case "REVEAL_SEGMENT": {
      const inc = s.incidents.find((i) => i.id === a.incidentId);
      const sc = inc && scenarioById(inc.scenarioId);
      if (!inc || !sc || inc.revealed >= sc.segments.length) return s;
      const seg = sc.segments[inc.revealed];
      const { updates: _u, ...segment } = seg;
      void _u;
      return {
        ...mapIncident(s, inc.id, (i) => ({ ...i, revealed: i.revealed + 1, transcript: [...i.transcript, segment] })),
        events: [...s.events, evt(inc.id, a.at, "demo", "transcript", `${seg.speaker === "caller" ? "Caller" : "Dispatcher"}: "${seg.text}"`)],
      };
    }

    case "APPLY_AI_UPDATES": {
      const inc = s.incidents.find((i) => i.id === a.incidentId);
      if (!inc) return s;
      const fields = { ...inc.fields };
      const applied: string[] = [];
      for (const u of a.updates) {
        const cur = fields[u.key];
        // Never overwrite dispatcher-entered values, and skip no-op updates.
        if (cur.source === "dispatcher") continue;
        if (cur.value === u.value && cur.status === u.status) continue;
        fields[u.key] = { key: u.key, value: u.value, status: u.status, source: a.source, evidenceSegmentId: u.evidenceSegmentId, updatedAt: a.at };
        applied.push(`${u.key}=${u.value}`);
      }
      if (!applied.length) return s;
      // Questions whose field now has a value are answered automatically.
      const questions = inc.questions.map((q) => (q.state === "open" && fields[q.fieldKey].value ? { ...q, state: "answered" as const } : q));
      const label = a.source === "ai" ? "Gemini suggested" : "Prerecorded extraction suggested";
      return {
        ...mapIncident(s, inc.id, (i) => ({ ...i, fields, questions })),
        events: [...s.events, evt(inc.id, a.at, a.source, "field_suggestions", `${label}: ${applied.join("; ")}`)],
      };
    }

    case "END_CALL":
      return {
        ...mapIncident(s, a.incidentId, (i) => ({ ...i, callEndedAt: a.at })),
        events: [...s.events, evt(a.incidentId, a.at, "dispatcher", "call_ended", "Call ended.")],
      };

    case "EDIT_FIELD":
      return {
        ...mapIncident(s, a.incidentId, (i) => {
          const fields = { ...i.fields, [a.key]: { ...i.fields[a.key], value: a.value || null, status: a.value ? a.status : "unknown", source: "dispatcher" as const, updatedAt: a.at } };
          const questions = i.questions.map((q) => (q.state === "open" && q.fieldKey === a.key && a.value ? { ...q, state: "answered" as const } : q));
          return { ...i, fields, questions };
        }),
        events: [...s.events, evt(a.incidentId, a.at, "dispatcher", "field_edit", `Dispatcher set ${a.key} to "${a.value || "(cleared)"}" (${a.status}).`)],
      };

    case "SET_QUESTION":
      return mapIncident(s, a.incidentId, (i) => ({ ...i, questions: i.questions.map((q) => (q.id === a.questionId ? { ...q, state: a.state } : q)) }));

    case "DECIDE_PRIORITY":
      return {
        ...mapIncident(s, a.incidentId, (i) => ({ ...i, priorityDecision: { priority: a.priority, overrideReason: a.overrideReason, decidedAt: a.at } })),
        events: [...s.events, evt(a.incidentId, a.at, "dispatcher", "priority",
          a.priority === a.proposed ? `Dispatcher confirmed proposed priority P${a.priority}.` : `Dispatcher overrode P${a.proposed} → P${a.priority}. Reason: ${a.overrideReason}`)],
      };

    case "APPROVE_ASSIGNMENT": {
      const off = s.officers.find((o) => o.id === a.officerId);
      // Safeguard: a unit can only be assigned while it is still available.
      if (!off || off.status !== "available" || off.currentIncidentId) {
        return { ...s, events: [...s.events, evt(a.incidentId, a.at, "system", "assignment_rejected", `Assignment of ${off?.callsign ?? a.officerId} rejected: unit is no longer available.`)] };
      }
      return {
        ...mapIncident(s, a.incidentId, (i) => ({ ...i, status: "dispatched" })),
        officers: s.officers.map((o) => (o.id === a.officerId ? { ...o, status: "responding", currentIncidentId: a.incidentId, busyWith: null } : o)),
        assignments: [...s.assignments, { id: a.assignmentId, incidentId: a.incidentId, officerId: a.officerId, status: "active", etaSeconds: a.etaSeconds, approvedAt: a.at, acknowledgedAt: null, clearedAt: null }],
        events: [...s.events, evt(a.incidentId, a.at, "dispatcher", "dispatch_approved", `Dispatcher approved ${off.callsign} (${off.name}). Simulated ETA ${Math.round(a.etaSeconds / 60)} min. Details sent to officer page.`)],
      };
    }

    case "DECLINE_UNIT": {
      const off = s.officers.find((o) => o.id === a.officerId);
      return {
        ...mapIncident(s, a.incidentId, (i) => ({ ...i, declinedOfficerIds: [...i.declinedOfficerIds, a.officerId] })),
        events: [...s.events, evt(a.incidentId, a.at, "dispatcher", "recommendation_declined", `Dispatcher declined ${off?.callsign ?? a.officerId}; offering next eligible unit.`)],
      };
    }

    case "RESET_DECLINES":
      return {
        ...mapIncident(s, a.incidentId, (i) => ({ ...i, declinedOfficerIds: [] })),
        events: [...s.events, evt(a.incidentId, a.at, "dispatcher", "declines_reset", "Dispatcher restored declined units to the recommendation list.")],
      };

    case "ACK_ASSIGNMENT": {
      const asg = s.assignments.find((x) => x.id === a.assignmentId);
      if (!asg || asg.acknowledgedAt) return s;
      const off = s.officers.find((o) => o.id === asg.officerId);
      return {
        ...s,
        assignments: s.assignments.map((x) => (x.id === asg.id ? { ...x, acknowledgedAt: a.at } : x)),
        events: [...s.events, evt(asg.incidentId, a.at, "officer", "officer_ack", `${off?.callsign ?? asg.officerId} acknowledged the assignment.`)],
      };
    }

    case "OFFICER_STATUS": {
      const off = s.officers.find((o) => o.id === a.officerId);
      if (!off || off.status === a.status) return s;
      const incId = off.currentIncidentId;
      let next: AppState = s;
      let officerPatch: Partial<typeof off> = { status: a.status };
      if (incId && a.status === "on_scene") {
        const inc = s.incidents.find((i) => i.id === incId)!;
        officerPatch = { ...officerPatch, location: [inc.location[0] - 0.00008, inc.location[1] + 0.00012], locationLabel: buildingById(inc.buildingId)?.name ?? "On scene", lastLocationAt: a.at };
        next = mapIncident(next, incId, (i) => ({ ...i, status: "on_scene" }));
      }
      if (incId && (a.status === "responding" || a.status === "on_scene")) {
        next = { ...next, assignments: next.assignments.map((x) => (x.officerId === off.id && x.status === "active" && !x.acknowledgedAt ? { ...x, acknowledgedAt: a.at } : x)) };
      }
      if (incId && (a.status === "available" || a.status === "busy")) {
        officerPatch = { ...officerPatch, currentIncidentId: null };
        next = { ...next, assignments: next.assignments.map((x) => (x.officerId === off.id && x.status === "active" ? { ...x, status: "cleared", clearedAt: a.at } : x)) };
      }
      if (a.status === "busy" && !incId) officerPatch = { ...officerPatch, busyWith: "Engaged elsewhere" };
      if (a.status === "available") officerPatch = { ...officerPatch, busyWith: null };
      const label = { available: "Available", busy: "Busy", responding: "Responding", on_scene: "On scene" }[a.status];
      return {
        ...next,
        officers: next.officers.map((o) => (o.id === off.id ? { ...o, ...officerPatch } : o)),
        events: incId ? [...next.events, evt(incId, a.at, "officer", "officer_status", `${off.callsign} set status: ${label}.`)] : next.events,
      };
    }

    case "OFFICER_LOCATION":
      return { ...s, officers: s.officers.map((o) => (o.id === a.officerId ? { ...o, location: a.location, locationLabel: a.label, lastLocationAt: a.at } : o)) };

    case "CLOSE_INCIDENT": {
      // Closing an incident clears its assignments and frees the units.
      const freed = s.officers.filter((o) => o.currentIncidentId === a.incidentId);
      return {
        ...mapIncident(s, a.incidentId, (i) => ({ ...i, status: "closed", closedAt: a.at, callEndedAt: i.callEndedAt ?? a.at })),
        officers: s.officers.map((o) => (o.currentIncidentId === a.incidentId ? { ...o, status: "available", currentIncidentId: null, busyWith: null } : o)),
        assignments: s.assignments.map((x) => (x.incidentId === a.incidentId && x.status === "active" ? { ...x, status: "cleared", clearedAt: a.at } : x)),
        activeIncidentId: s.activeIncidentId === a.incidentId ? null : s.activeIncidentId,
        events: [
          ...s.events,
          evt(a.incidentId, a.at, "dispatcher", "incident_closed", `Incident closed.${freed.length ? ` Released ${freed.map((o) => o.callsign).join(", ")}.` : ""}`),
        ],
      };
    }

    case "LOG":
      return { ...s, events: [...s.events, evt(a.incidentId, a.at, a.actor, a.eventType, a.message)] };
  }
}

// ---------- External store plumbing ----------
const SERVER_SNAPSHOT = seedState();
let state: AppState = SERVER_SNAPSHOT;
let loaded = false;
const listeners = new Set<() => void>();
let channel: BroadcastChannel | null = null;

function ensureLoaded() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) state = JSON.parse(raw) as AppState;
  } catch {
    /* ignore corrupt storage */
  }
  if ("BroadcastChannel" in window) {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (e: MessageEvent<Action>) => apply(e.data, false);
  }
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY || !e.newValue) return;
    try {
      const incoming = JSON.parse(e.newValue) as AppState;
      if (incoming.rev > state.rev) {
        state = incoming;
        listeners.forEach((l) => l());
      }
    } catch {
      /* ignore */
    }
  });
}

function apply(action: Action, broadcast: boolean) {
  const next = reduce(state, action);
  if (next === state) return;
  state = next;
  if (broadcast) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* storage full or blocked */
    }
    channel?.postMessage(action);
  }
  listeners.forEach((l) => l());
}

export function act(action: Action) {
  ensureLoaded();
  apply(action, true);
}

function subscribe(l: () => void) {
  ensureLoaded();
  listeners.add(l);
  // Pick up whatever was loaded from storage after hydration.
  queueMicrotask(l);
  return () => listeners.delete(l);
}

export function useAppState(): AppState {
  return useSyncExternalStore(
    subscribe,
    () => {
      ensureLoaded();
      return state;
    },
    () => SERVER_SNAPSHOT,
  );
}

/** Current time for action timestamps (call only from event handlers). */
export const stamp = () => Date.now();

export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
