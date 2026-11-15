// Shared, pure reducer for the demo state. Runs in the browser (optimistic updates) and on the
// sync server (/api/sync), which orders every action so all laptops end up with the same state.
import { BUILDINGS, buildingById, CAMPUS_CENTER, SEED_OFFICERS } from "./campus";
import { emptyFields, initialQuestions } from "./fields";
import { officerSnapshot, pendingChanges } from "./officerComms";
import { scenarioById } from "./scenarios";
import type {
  AppState, EventActor, FieldKey, FieldStatus, FieldUpdate, Incident, IncidentCategory, IncidentEvent, OfficerStatus, Priority,
  TranscriptSegment, UpdateChange,
} from "./types";

/** The seed building with this name, if any (so older pages that look up buildingId still work). */
const buildingByName = (name: string) => BUILDINGS.find((b) => b.name.toLowerCase() === name.toLowerCase());

export type Action =
  | { type: "START_CALL"; at: number; incidentId: string; number: string; scenarioId: string }
  | { type: "REVEAL_SEGMENT"; at: number; incidentId: string }
  | { type: "APPLY_AI_UPDATES"; at: number; incidentId: string; updates: (FieldUpdate & { evidenceSegmentId: string | null })[]; source: "ai" | "demo" }
  | { type: "END_CALL"; at: number; incidentId: string }
  | { type: "EDIT_FIELD"; at: number; incidentId: string; key: FieldKey; value: string; status: FieldStatus }
  | { type: "SET_QUESTION"; at: number; incidentId: string; questionId: string; state: "open" | "answered" | "dismissed" }
  | { type: "DECIDE_PRIORITY"; at: number; incidentId: string; priority: Priority; proposed: Priority; overrideReason: string | null; auto?: boolean }
  | { type: "APPROVE_ASSIGNMENT"; at: number; incidentId: string; officerId: string; assignmentId: string; etaSeconds: number; route?: [number, number][] }
  | { type: "CANCEL_ASSIGNMENT"; at: number; assignmentId: string }
  | { type: "DECLINE_UNIT"; at: number; incidentId: string; officerId: string }
  | { type: "RESET_DECLINES"; at: number; incidentId: string }
  | { type: "ACK_ASSIGNMENT"; at: number; assignmentId: string }
  | { type: "START_LIVE_CALL"; at: number; incidentId: string; number: string; deskCallId: string; callerLanguage: string | null }
  | { type: "SET_DESK_TRANSCRIPT"; at: number; incidentId: string; transcript: TranscriptSegment[] }
  | { type: "SET_CATEGORY"; at: number; incidentId: string; category: IncidentCategory }
  | { type: "SET_LOCATION"; at: number; incidentId: string; buildingId: string }
  | { type: "SET_PLACE"; at: number; incidentId: string; placeId: string; name: string; kind: string; location: [number, number] }
  | { type: "MENTION_PLACES"; at: number; incidentId: string; places: { id: string; name: string; location: [number, number] }[] }
  | { type: "SEND_OFFICER_UPDATE"; at: number; assignmentId: string; updateId: string; changes: UpdateChange[]; snapshot: Record<string, string | null> }
  | { type: "ACK_OFFICER_UPDATE"; at: number; updateId: string }
  | { type: "OFFICER_STATUS"; at: number; officerId: string; status: OfficerStatus }
  | { type: "OFFICER_LOCATION"; at: number; officerId: string; location: [number, number]; label: string }
  | { type: "REQUEST_BACKUP"; at: number; requestId: string; officerId: string; incidentId: string; note: string | null }
  | { type: "ACK_BACKUP"; at: number; requestId: string }
  | { type: "RESOLVE_BACKUP"; at: number; requestId: string }
  | { type: "SET_ACTIVE_INCIDENT"; at: number; incidentId: string | null }
  | { type: "SIGN_CLERY"; at: number; incidentId: string; reportable: boolean; category: string; geographyLabel: string; nibrs: string; dailyLog: boolean; timelyWarning: boolean; note: string | null; location: string; title: string; incidentNumber: string; eventAt: number }
  | { type: "SEND_MESSAGE"; at: number; messageId: string; from: "dispatcher" | "officer"; officerId: string; incidentId: string | null; text: string }
  | { type: "CLOSE_INCIDENT"; at: number; incidentId: string }
  /** The officer on scene declares it clear: the case is resolved and everyone on it is freed. */
  | { type: "CLEAR_SCENE"; at: number; incidentId: string; officerId: string }
  | { type: "LOG"; at: number; incidentId: string; actor: EventActor; eventType: string; message: string }
  | { type: "PREP_DEMO"; at: number }
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

function historicalIncident(id: string, number: string, title: string, buildingId: string, category: Incident["category"], hoursAgo: number, now: number): Incident {
  const at = now - hoursAgo * 3600_000;
  const b = buildingById(buildingId)!;
  const fields = emptyFields();
  fields.building = { key: "building", value: b.name, status: "confirmed", source: "dispatcher", evidenceSegmentId: null, updatedAt: at };
  fields.description = { key: "description", value: title, status: "confirmed", source: "dispatcher", evidenceSegmentId: null, updatedAt: at };
  return {
    id, number, scenarioId: null, category, title, buildingId, location: b.location, status: "closed",
    createdAt: at, closedAt: at + 40 * 60_000, callStartedAt: at, callEndedAt: at + 3 * 60_000, revealed: 0,
    transcript: [], fields, questions: [], priorityDecision: { priority: 3, overrideReason: null, decidedAt: at + 60_000 },
    declinedOfficerIds: [],
    clerySignOff: null,
  };
}

/** Apply scenario segments into fields/transcript. `through` = how many segments (default all). */
function applyScenarioSegments(sc: NonNullable<ReturnType<typeof scenarioById>>, fields: Incident["fields"], transcript: TranscriptSegment[], started: number, through?: number) {
  const segs = through == null ? sc.segments : sc.segments.slice(0, through);
  for (const seg of segs) {
    const { updates, ...rest } = seg;
    transcript.push(rest);
    for (const u of updates ?? []) {
      fields[u.key] = {
        key: u.key, value: u.value, status: u.status, source: "demo",
        evidenceSegmentId: seg.id, updatedAt: started + seg.t * 1000,
      };
    }
  }
  return segs.length;
}

/** Open board case from a scenario — one campus map, many cases at once (the demo). */
function openFromScenario(
  id: string,
  number: string,
  scenarioId: string,
  now: number,
  opts: {
    minutesAgo: number;
    live?: boolean;
    /** Pre-fill this many segments on a live call so severity isn't empty-state P4. */
    liveReveal?: number;
    priority?: Priority | null;
    status?: Incident["status"];
  },
): Incident {
  const sc = scenarioById(scenarioId)!;
  const b = buildingById(sc.buildingId)!;
  const started = now - opts.minutesAgo * 60_000;
  const fields = emptyFields();
  const transcript: TranscriptSegment[] = [];
  let revealed = 0;
  if (opts.live) {
    revealed = applyScenarioSegments(sc, fields, transcript, started, opts.liveReveal ?? 2);
  } else {
    revealed = applyScenarioSegments(sc, fields, transcript, started);
  }
  const questions = initialQuestions(sc.category).map((q) =>
    fields[q.fieldKey].value ? { ...q, state: "answered" as const } : q,
  );
  return {
    id, number, scenarioId: sc.id, category: sc.category, title: sc.title,
    buildingId: b.id, location: b.location, status: opts.status ?? "intake",
    createdAt: started, closedAt: null,
    callStartedAt: started,
    callEndedAt: opts.live ? null : started + Math.max(30, (sc.segments.at(-1)?.t ?? 20) + 5) * 1000,
    revealed, transcript, fields, questions,
    priorityDecision: opts.priority
      ? { priority: opts.priority, overrideReason: null, decidedAt: started + 20_000 }
      : null,
    declinedOfficerIds: [], clerySignOff: null,
  };
}

/** Fresh console: no cases, no history, every officer free at their post. Real calls and the demo
 *  menu are the only things that put cases on the board. */
export function seedState(): AppState {
  const now = Date.now();
  return {
    rev: 0,
    officers: SEED_OFFICERS.map((o) => ({
      ...o, status: "available" as const, currentIncidentId: null, busyWith: null, busyUntil: null, lastLocationAt: now,
    })),
    incidents: [],
    assignments: [],
    events: [],
    backups: [],
    messages: [],
    cleryLog: [],
    activeIncidentId: null,
    officerUpdates: [],
  };
}

/** The old busy demo board (4 open cases, history, officers on jobs). Not used by default. */
export function busyBoardState(): AppState {
  const now = Date.now();
  // Board mix: 1 live (top) · 1 waiting red · 2 yellow attending · rest completed.
  const live = openFromScenario("demo-live", "INC-10001", "medical-cottage", now, {
    minutesAgo: 0, live: true, liveReveal: 2,
  });
  // Severity left unset on open cases so the desk can demo Confirm P#.
  const waiting = openFromScenario("demo-lockout", "INC-10002", "lockout-whitman", now, {
    minutesAgo: 6,
  });
  const attendingA = openFromScenario("demo-frist", "INC-10003", "police-frist", now, {
    minutesAgo: 11, status: "dispatched", priority: 2,
  });
  const attendingB = openFromScenario("demo-theft", "INC-10004", "theft-firestone", now, {
    minutesAgo: 16, status: "on_scene", priority: 3,
  });
  const officers = SEED_OFFICERS.map((o) => {
    if (o.id === "U4") {
      return {
        ...o, status: "responding" as const, currentIncidentId: attendingA.id, busyWith: null, busyUntil: null,
        location: attendingA.location, locationLabel: "En route — Frist", lastLocationAt: now,
      };
    }
    if (o.id === "U7") {
      return {
        ...o, status: "on_scene" as const, currentIncidentId: attendingB.id, busyWith: null, busyUntil: null,
        location: attendingB.location, locationLabel: "Firestone Library", lastLocationAt: now,
      };
    }
    // Amber posts: staggered wrap times so dispatch can prefer units almost free.
    if (o.id === "U1") return { ...o, lastLocationAt: now, busyUntil: now + 75_000 }; // ~1m left near Nassau
    if (o.id === "U8") return { ...o, lastLocationAt: now, busyUntil: now + 50_000 }; // wrapping near Dillon/Whitman
    if (o.id === "U2") return { ...o, lastLocationAt: now, busyUntil: now + 8 * 60_000 };
    if (o.id === "U6") return { ...o, lastLocationAt: now, busyUntil: now + 6 * 60_000 };
    return { ...o, lastLocationAt: now, busyUntil: null };
  });
  return {
    rev: 0,
    officers,
    incidents: [
      live,
      waiting,
      attendingA,
      attendingB,
      historicalIncident("hist-1", "INC-09901", "Noise at Tiger Inn", "tiger-inn", "other", 2, now),
      historicalIncident("hist-2", "INC-09880", "Forgot prox at Whitman", "whitman", "other", 5, now),
      historicalIncident("hist-3", "INC-09840", "Bike theft at Firestone", "firestone", "police", 9, now),
      historicalIncident("hist-4", "INC-09790", "Passed out in Whitman", "whitman", "medical", 14, now),
      historicalIncident("hist-5", "INC-09720", "Door prop — Nassau", "nassau", "other", 20, now),
    ],
    assignments: [
      {
        id: "asg-seed-a", incidentId: attendingA.id, officerId: "U4", status: "active",
        etaSeconds: 180, approvedAt: now - 4 * 60_000, acknowledgedAt: now - 3.5 * 60_000, clearedAt: null,
        sentSnapshot: {},
      },
      {
        id: "asg-seed-b", incidentId: attendingB.id, officerId: "U7", status: "active",
        etaSeconds: 90, approvedAt: now - 10 * 60_000, acknowledgedAt: now - 9 * 60_000, clearedAt: null,
        sentSnapshot: {},
      },
    ],
    events: [],
    backups: [],
    messages: [],
    cleryLog: [
      {
        id: "clery-hist-1", incidentId: "hist-3", incidentNumber: "INC-09840", title: "Bike theft at Firestone",
        at: now - 9 * 3600_000, signedAt: now - 8.5 * 3600_000, reportable: false,
        category: "Not Clery-reportable (property theft)", geographyLabel: "On campus (approximate)",
        nibrs: "23H — All Other Larceny (suggested)", dailyLog: true, timelyWarning: false,
        location: "Firestone Library", note: null,
      },
    ],
    activeIncidentId: live.id,
    officerUpdates: [],
  };
}

function mapIncident(s: AppState, id: string, fn: (i: Incident) => Incident): AppState {
  return { ...s, incidents: s.incidents.map((i) => (i.id === id ? fn(i) : i)) };
}

/** After clearing a job, start the next queued assignment (highest priority / oldest first). */
function promoteQueued(s: AppState, officerId: string, at: number): AppState {
  const queued = s.assignments
    .filter((a) => a.officerId === officerId && a.status === "queued")
    .map((a) => {
      const inc = s.incidents.find((i) => i.id === a.incidentId);
      const p = inc?.priorityDecision?.priority ?? 99;
      return { a, p, at: a.approvedAt };
    })
    .filter((x) => x.a && s.incidents.some((i) => i.id === x.a.incidentId && i.status !== "closed"))
    .sort((x, y) => x.p - y.p || x.at - y.at);
  const next = queued[0]?.a;
  if (!next) {
    return {
      ...s,
      officers: s.officers.map((o) =>
        o.id === officerId ? { ...o, status: "available", currentIncidentId: null, busyWith: null, busyUntil: null } : o
      ),
    };
  }
  const inc = s.incidents.find((i) => i.id === next.incidentId)!;
  const off = s.officers.find((o) => o.id === officerId);
  let out: AppState = {
    ...s,
    assignments: s.assignments.map((x) => (x.id === next.id ? { ...x, status: "active" as const, acknowledgedAt: null } : x)),
    officers: s.officers.map((o) =>
      o.id === officerId
        ? { ...o, status: "responding", currentIncidentId: next.incidentId, busyWith: null, busyUntil: null }
        : o
    ),
    events: [
      ...s.events,
      evt(next.incidentId, at, "system", "queue_promoted",
        `${off?.callsign ?? officerId} cleared prior job — now responding to ${inc.number} (${inc.title.split(":")[0]}).`),
    ],
  };
  if (inc.status === "intake") {
    out = mapIncident(out, inc.id, (i) => ({ ...i, status: "dispatched" }));
  }
  return out;
}

export function reduce(s: AppState, a: Action): AppState {
  let next = reduceInner(s, a);
  if (next !== s && "incidentId" in a && INCIDENT_DETAIL_ACTIONS.has(a.type)) next = autoSendUpdates(next, a.incidentId as string, a.at);
  return next === s ? s : { ...next, rev: s.rev + 1 };
}

const INCIDENT_DETAIL_ACTIONS = new Set<Action["type"]>(["APPLY_AI_UPDATES", "EDIT_FIELD", "DECIDE_PRIORITY", "SET_CATEGORY", "SET_LOCATION", "SET_PLACE"]);

function autoSendUpdates(s: AppState, incidentId: string, at: number): AppState {
  const inc = s.incidents.find((i) => i.id === incidentId);
  if (!inc || inc.status === "closed") return s;
  let out = s;
  for (const asg of s.assignments) {
    if (asg.incidentId !== incidentId || asg.status !== "active") continue;
    const changes = pendingChanges(inc, asg.sentSnapshot);
    if (!changes.length) continue;
    const off = out.officers.find((o) => o.id === asg.officerId);
    out = {
      ...out,
      assignments: out.assignments.map((x) => (x.id === asg.id ? { ...x, sentSnapshot: officerSnapshot(inc) } : x)),
      officerUpdates: [
        ...(out.officerUpdates ?? []),
        { id: `upd-${at}-${asg.id}`, incidentId, assignmentId: asg.id, officerId: asg.officerId, changes, status: "sent", sentAt: at, acknowledgedAt: null },
      ],
      events: [...out.events, evt(incidentId, at, "system", "officer_update_sent",
        `Sent to ${off?.callsign ?? asg.officerId} automatically: ${changes.map((c) => `${c.label}: ${c.to}`).join("; ")}.`)],
    };
  }
  return out;
}

function reduceInner(s: AppState, a: Action): AppState {
  switch (a.type) {
    case "RESET":
      return { ...seedState(), rev: s.rev };

    case "PREP_DEMO":
      // Restore seed roster (most free, several at HQ) and clear active assignments for a clean exercise.
      return {
        ...s,
        officers: SEED_OFFICERS.map((o) => ({ ...o, lastLocationAt: a.at })),
        assignments: s.assignments.map((x) =>
          x.status === "active" ? { ...x, status: "cleared" as const, clearedAt: a.at } : x
        ),
      };

    case "START_CALL": {
      const sc = scenarioById(a.scenarioId);
      if (!sc) return s;
      const b = buildingById(sc.buildingId)!;
      const inc: Incident = {
        id: a.incidentId, number: a.number, scenarioId: sc.id, category: sc.category, title: sc.title,
        buildingId: b.id, location: b.location, status: "intake", createdAt: a.at, closedAt: null,
        callStartedAt: a.at, callEndedAt: null, revealed: 0, transcript: [], fields: emptyFields(),
        questions: initialQuestions(sc.category), priorityDecision: null, declinedOfficerIds: [], clerySignOff: null,
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
        if (cur.source === "dispatcher") continue;
        if (cur.value === u.value && cur.status === u.status) continue;
        fields[u.key] = { key: u.key, value: u.value, status: u.status, source: a.source, evidenceSegmentId: u.evidenceSegmentId, updatedAt: a.at };
        applied.push(`${u.key}=${u.value}`);
      }
      if (!applied.length) return s;
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
        ...mapIncident(s, a.incidentId, (i) => ({ ...i, priorityDecision: { priority: a.priority, overrideReason: a.overrideReason, decidedAt: a.at, auto: !!a.auto } })),
        events: [...s.events, a.auto
          ? evt(a.incidentId, a.at, "system", "priority", `Severity auto-graded P${a.priority} from the call so far.`)
          : evt(a.incidentId, a.at, "dispatcher", "priority",
            a.priority === a.proposed ? `Dispatcher confirmed P${a.priority}.` : `Dispatcher set P${a.priority} (auto-grade was P${a.proposed}). ${a.overrideReason ?? ""}`.trim())],
      };

    case "APPROVE_ASSIGNMENT": {
      const off = s.officers.find((o) => o.id === a.officerId);
      if (!off) {
        return { ...s, events: [...s.events, evt(a.incidentId, a.at, "system", "assignment_rejected", `Assignment rejected: unit not found.`)] };
      }
      const already = s.assignments.some((x) => x.officerId === a.officerId && x.incidentId === a.incidentId && (x.status === "active" || x.status === "queued"));
      if (already) {
        return { ...s, events: [...s.events, evt(a.incidentId, a.at, "system", "assignment_rejected", `${off.callsign} is already on this case.`)] };
      }
      // Free / wrapping-up → active now. Already on a call → queue for after they clear.
      const onCall = !!(off.currentIncidentId) || off.status === "responding" || off.status === "on_scene";
      const freeNow = !onCall && (off.status === "available" || off.status === "busy");
      if (!onCall && !freeNow) {
        return { ...s, events: [...s.events, evt(a.incidentId, a.at, "system", "assignment_rejected", `Assignment of ${off.callsign} rejected: unit is no longer available.`)] };
      }
      const queue = onCall;
      const incForSnap = s.incidents.find((i) => i.id === a.incidentId);
      const asgStatus = queue ? "queued" as const : "active" as const;
      let next: AppState = {
        ...mapIncident(s, a.incidentId, (i) => ({
          ...i,
          status: i.status === "intake" ? "dispatched" : i.status,
        })),
        assignments: [...s.assignments, {
          id: a.assignmentId, incidentId: a.incidentId, officerId: a.officerId, status: asgStatus, etaSeconds: a.etaSeconds,
          approvedAt: a.at, acknowledgedAt: null, clearedAt: null, route: a.route,
          sentSnapshot: incForSnap ? officerSnapshot(incForSnap) : {},
        }],
        events: [...s.events, evt(a.incidentId, a.at, "dispatcher", queue ? "dispatch_queued" : "dispatch_approved",
          queue
            ? `Queued ${off.callsign} for ${incForSnap?.number ?? a.incidentId} after their current job.`
            : `Dispatcher approved ${off.callsign} (${off.name}). Simulated ETA ${Math.round(a.etaSeconds / 60)} min. Details sent to the patrol terminal.`)],
      };
      if (!queue) {
        next = {
          ...next,
          officers: next.officers.map((o) =>
            o.id === a.officerId ? { ...o, status: "responding", currentIncidentId: a.incidentId, busyWith: null, busyUntil: null } : o
          ),
        };
      }
      return next;
    }

    case "CANCEL_ASSIGNMENT": {
      const asg = s.assignments.find((x) => x.id === a.assignmentId);
      if (!asg || asg.status === "cleared") return s;
      const off = s.officers.find((o) => o.id === asg.officerId);
      if (asg.status === "queued") {
        return {
          ...s,
          assignments: s.assignments.map((x) => (x.id === asg.id ? { ...x, status: "cleared" as const, clearedAt: a.at } : x)),
          events: [...s.events, evt(asg.incidentId, a.at, "dispatcher", "queue_canceled",
            `Removed queued assignment for ${off?.callsign ?? asg.officerId}.`)],
        };
      }
      // Active: clear the job, then promote anything waiting behind it.
      let next: AppState = {
        ...s,
        assignments: s.assignments.map((x) => (x.id === asg.id ? { ...x, status: "cleared" as const, clearedAt: a.at } : x)),
        officers: s.officers.map((o) =>
          o.id === asg.officerId && o.currentIncidentId === asg.incidentId
            ? { ...o, status: "available", currentIncidentId: null, busyWith: null, busyUntil: null }
            : o
        ),
        events: [...s.events, evt(asg.incidentId, a.at, "dispatcher", "assignment_canceled",
          `Dispatcher pulled ${off?.callsign ?? asg.officerId} off the call.`)],
      };
      return promoteQueued(next, asg.officerId, a.at);
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

    case "START_LIVE_CALL": {
      if (s.incidents.some((i) => i.id === a.incidentId || (i.deskCallId === a.deskCallId && i.status !== "closed"))) return s;
      const inc: Incident = {
        id: a.incidentId, number: a.number, scenarioId: null, category: "other",
        title: `Live call from station desk${a.callerLanguage && !/^english$/i.test(a.callerLanguage) ? ` (${a.callerLanguage}, translated)` : ""}`,
        buildingId: "", location: CAMPUS_CENTER, status: "intake", createdAt: a.at, closedAt: null,
        callStartedAt: a.at, callEndedAt: null, revealed: 0, transcript: [], fields: emptyFields(),
        questions: initialQuestions("other"), priorityDecision: null, declinedOfficerIds: [], clerySignOff: null,
        deskCallId: a.deskCallId, callerLanguage: a.callerLanguage, locationPending: true,
      };
      return {
        ...s,
        incidents: [inc, ...s.incidents],
        activeIncidentId: inc.id,
        events: [...s.events, evt(inc.id, a.at, "system", "incident_created", `Incident ${inc.number} created from a live station-desk call${a.callerLanguage ? ` (caller language: ${a.callerLanguage})` : ""}.`)],
      };
    }

    case "SET_DESK_TRANSCRIPT": {
      const inc = s.incidents.find((i) => i.id === a.incidentId);
      if (!inc || !inc.deskCallId || JSON.stringify(inc.transcript) === JSON.stringify(a.transcript)) return s;
      return mapIncident(s, inc.id, (i) => ({ ...i, transcript: a.transcript }));
    }

    case "SET_CATEGORY": {
      const inc = s.incidents.find((i) => i.id === a.incidentId);
      if (!inc || inc.category === a.category) return s;
      const questions = initialQuestions(a.category).map((q) => (inc.fields[q.fieldKey].value ? { ...q, state: "answered" as const } : q));
      return {
        ...mapIncident(s, inc.id, (i) => ({ ...i, category: a.category, questions })),
        events: [...s.events, evt(inc.id, a.at, "ai", "category", `Classified the call as ${a.category} from what the caller said.`)],
      };
    }

    case "SET_LOCATION": {
      const b = buildingById(a.buildingId);
      const inc = s.incidents.find((i) => i.id === a.incidentId);
      if (!b || !inc || inc.buildingId === b.id) return s;
      return {
        ...mapIncident(s, inc.id, (i) => ({ ...i, buildingId: b.id, location: b.location, locationPending: false })),
        events: [...s.events, evt(inc.id, a.at, "ai", "location", `Placed the incident at ${b.name} from what the caller said. Confirm with the caller.`)],
      };
    }

    case "SET_PLACE": {
      const inc = s.incidents.find((i) => i.id === a.incidentId);
      if (!inc || (inc.placeName === a.name && !inc.locationPending)) return s;
      const b = buildingByName(a.name);
      return {
        ...mapIncident(s, inc.id, (i) => ({
          ...i, location: a.location, buildingId: b?.id ?? "", placeName: a.name, placeKind: a.kind, locationPending: false,
        })),
        events: [...s.events, evt(inc.id, a.at, "ai", "location",
          `Pinned the incident at ${a.name}${inc.placeName ? ` (was ${inc.placeName})` : ""} from what the caller said. Confirm with the caller.`)],
      };
    }

    case "MENTION_PLACES": {
      const inc = s.incidents.find((i) => i.id === a.incidentId);
      if (!inc) return s;
      const have = new Set((inc.mentionedPlaces ?? []).map((p) => p.id));
      const added = a.places.filter((p) => !have.has(p.id));
      if (!added.length) return s;
      return {
        ...mapIncident(s, inc.id, (i) => ({ ...i, mentionedPlaces: [...(i.mentionedPlaces ?? []), ...added] })),
        events: [...s.events, evt(inc.id, a.at, "ai", "places_mentioned", `Caller mentioned ${added.map((p) => p.name).join(", ")}; pinned on the map.`)],
      };
    }

    case "SEND_OFFICER_UPDATE": {
      const asg = s.assignments.find((x) => x.id === a.assignmentId);
      if (!asg || asg.status !== "active" || a.changes.length === 0) return s;
      const off = s.officers.find((o) => o.id === asg.officerId);
      const summary = a.changes.map((c) => `${c.label}: ${c.to}`).join("; ");
      return {
        ...s,
        assignments: s.assignments.map((x) => (x.id === asg.id ? { ...x, sentSnapshot: a.snapshot } : x)),
        officerUpdates: [
          ...(s.officerUpdates ?? []),
          { id: a.updateId, incidentId: asg.incidentId, assignmentId: asg.id, officerId: asg.officerId, changes: a.changes, status: "sent", sentAt: a.at, acknowledgedAt: null },
        ],
        events: [...s.events, evt(asg.incidentId, a.at, "dispatcher", "officer_update_sent", `Dispatcher sent update to ${off?.callsign ?? asg.officerId}: ${summary}.`)],
      };
    }

    case "ACK_OFFICER_UPDATE": {
      const upd = (s.officerUpdates ?? []).find((u) => u.id === a.updateId);
      if (!upd || upd.status === "acknowledged") return s;
      const off = s.officers.find((o) => o.id === upd.officerId);
      return {
        ...s,
        officerUpdates: (s.officerUpdates ?? []).map((u) => (u.id === upd.id ? { ...u, status: "acknowledged", acknowledgedAt: a.at } : u)),
        events: [...s.events, evt(upd.incidentId, a.at, "officer", "officer_update_ack", `${off?.callsign ?? upd.officerId} acknowledged the update (${upd.changes.map((c) => c.label).join(", ")}).`)],
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
        officerPatch = { ...officerPatch, currentIncidentId: null, busyWith: a.status === "busy" ? "Engaged elsewhere" : null, busyUntil: null };
        next = { ...next, assignments: next.assignments.map((x) => (x.officerId === off.id && x.status === "active" ? { ...x, status: "cleared", clearedAt: a.at } : x)) };
        next = {
          ...next,
          officers: next.officers.map((o) => (o.id === off.id ? { ...o, ...officerPatch } : o)),
          events: [...next.events, evt(incId, a.at, "officer", "officer_status", `${off.callsign} set status: ${a.status === "available" ? "Available" : "Busy"}.`)],
        };
        // Finish current job → pull next queued case onto the officer dashboard.
        if (a.status === "available") return promoteQueued(next, off.id, a.at);
        return next;
      }
      if (a.status === "busy" && !incId) officerPatch = { ...officerPatch, busyWith: "Engaged elsewhere" };
      if (a.status === "available") officerPatch = { ...officerPatch, busyWith: null, busyUntil: null };
      const label = { available: "Available", busy: "Busy", responding: "Responding", on_scene: "On scene" }[a.status];
      return {
        ...next,
        officers: next.officers.map((o) => (o.id === off.id ? { ...o, ...officerPatch } : o)),
        events: incId ? [...next.events, evt(incId, a.at, "officer", "officer_status", `${off.callsign} set status: ${label}.`)] : next.events,
      };
    }

    case "OFFICER_LOCATION":
      return { ...s, officers: s.officers.map((o) => (o.id === a.officerId ? { ...o, location: a.location, locationLabel: a.label, lastLocationAt: a.at } : o)) };

    case "REQUEST_BACKUP": {
      const off = s.officers.find((o) => o.id === a.officerId);
      if (!off) return s;
      const existing = s.backups.find((b) => b.officerId === a.officerId && b.incidentId === a.incidentId && b.status === "open");
      if (existing) {
        return {
          ...s,
          backups: s.backups.map((b) => (b.id === existing.id ? { ...b, at: a.at, note: a.note } : b)),
          events: [...s.events, evt(a.incidentId, a.at, "officer", "backup_requested", `${off.callsign} repeated backup request${a.note ? `: ${a.note}` : "."}`)],
        };
      }
      return {
        ...s,
        backups: [
          ...s.backups,
          { id: a.requestId, officerId: a.officerId, incidentId: a.incidentId, at: a.at, status: "open", note: a.note, acknowledgedAt: null, resolvedAt: null },
        ],
        events: [...s.events, evt(a.incidentId, a.at, "officer", "backup_requested", `${off.callsign} requested backup${a.note ? `: ${a.note}` : "."}`)],
      };
    }

    case "ACK_BACKUP": {
      const req = s.backups.find((b) => b.id === a.requestId);
      if (!req || req.status !== "open") return s;
      const off = s.officers.find((o) => o.id === req.officerId);
      return {
        ...s,
        backups: s.backups.map((b) => (b.id === req.id ? { ...b, status: "acknowledged", acknowledgedAt: a.at } : b)),
        events: [...s.events, evt(req.incidentId, a.at, "dispatcher", "backup_acked", `Dispatch acknowledged backup for ${off?.callsign ?? req.officerId}.`)],
      };
    }

    case "RESOLVE_BACKUP": {
      const req = s.backups.find((b) => b.id === a.requestId);
      if (!req || req.status === "resolved") return s;
      const off = s.officers.find((o) => o.id === req.officerId);
      return {
        ...s,
        backups: s.backups.map((b) => (b.id === req.id ? { ...b, status: "resolved", resolvedAt: a.at, acknowledgedAt: b.acknowledgedAt ?? a.at } : b)),
        events: [...s.events, evt(req.incidentId, a.at, "dispatcher", "backup_resolved", `Backup cleared for ${off?.callsign ?? req.officerId}.`)],
      };
    }

    case "SET_ACTIVE_INCIDENT":
      return { ...s, activeIncidentId: a.incidentId };

    case "SIGN_CLERY": {
      const entry = {
        id: `clery-${a.at}`,
        incidentId: a.incidentId,
        incidentNumber: a.incidentNumber,
        title: a.title,
        at: a.eventAt,
        signedAt: a.at,
        reportable: a.reportable,
        category: a.category,
        geographyLabel: a.geographyLabel,
        nibrs: a.nibrs,
        dailyLog: a.dailyLog,
        timelyWarning: a.timelyWarning,
        location: a.location,
        note: a.note,
      };
      return {
        ...mapIncident(s, a.incidentId, (i) => ({
          ...i,
          clerySignOff: {
            reportable: a.reportable,
            category: a.category,
            geographyLabel: a.geographyLabel,
            nibrs: a.nibrs,
            dailyLog: a.dailyLog,
            timelyWarning: a.timelyWarning,
            note: a.note,
            signedAt: a.at,
          },
        })),
        cleryLog: [entry, ...(s.cleryLog ?? []).filter((c) => c.incidentId !== a.incidentId)],
        events: [...s.events, evt(a.incidentId, a.at, "dispatcher", "clery_signed",
          `Filed to weekly Clery log: ${a.category}${a.reportable ? " (reportable)" : ""}${a.timelyWarning ? "; timely warning flagged" : ""}.`)],
      };
    }

    case "SEND_MESSAGE": {
      const off = s.officers.find((o) => o.id === a.officerId);
      const actor: EventActor = a.from === "dispatcher" ? "dispatcher" : "officer";
      const who = a.from === "dispatcher" ? "HQ" : (off?.callsign ?? a.officerId);
      const msg = { id: a.messageId, at: a.at, from: a.from, officerId: a.officerId, incidentId: a.incidentId, text: a.text };
      return {
        ...s,
        messages: [...(s.messages ?? []), msg].slice(-200),
        events: a.incidentId
          ? [...s.events, evt(a.incidentId, a.at, actor, "unit_message", `${who}: ${a.text}`)]
          : s.events,
      };
    }

    case "CLOSE_INCIDENT": {
      const freed = s.officers.filter((o) => o.currentIncidentId === a.incidentId);
      let next: AppState = {
        ...mapIncident(s, a.incidentId, (i) => ({ ...i, status: "closed", closedAt: a.at, callEndedAt: i.callEndedAt ?? a.at })),
        officers: s.officers.map((o) => (o.currentIncidentId === a.incidentId ? { ...o, status: "available", currentIncidentId: null, busyWith: null, busyUntil: null } : o)),
        assignments: s.assignments.map((x) =>
          x.incidentId === a.incidentId && (x.status === "active" || x.status === "queued")
            ? { ...x, status: "cleared", clearedAt: a.at }
            : x
        ),
        backups: (s.backups ?? []).map((b) => (b.incidentId === a.incidentId && b.status !== "resolved" ? { ...b, status: "resolved", resolvedAt: a.at, acknowledgedAt: b.acknowledgedAt ?? a.at } : b)),
        activeIncidentId: s.activeIncidentId === a.incidentId ? null : s.activeIncidentId,
        events: [
          ...s.events,
          evt(a.incidentId, a.at, "dispatcher", "incident_closed", `Incident closed.${freed.length ? ` Released ${freed.map((o) => o.callsign).join(", ")}.` : ""}`),
        ],
      };
      for (const o of freed) next = promoteQueued(next, o.id, a.at);
      return next;
    }

    case "CLEAR_SCENE": {
      const inc = s.incidents.find((i) => i.id === a.incidentId);
      if (!inc || inc.status === "closed") return s;
      const off = s.officers.find((o) => o.id === a.officerId);
      const closed = reduceInner(s, { type: "CLOSE_INCIDENT", at: a.at, incidentId: a.incidentId });
      return {
        ...closed,
        events: [...closed.events, evt(a.incidentId, a.at, "officer", "scene_clear",
          `${off?.callsign ?? a.officerId} reported the scene clear. Case resolved.`)],
      };
    }

    case "LOG":
      return { ...s, events: [...s.events, evt(a.incidentId, a.at, a.actor, a.eventType, a.message)] };
  }
}
