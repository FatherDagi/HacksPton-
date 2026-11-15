"use client";
// HQ: dark campus map + compact liquid-glass docks. Cases left, recommend bottom-left, roster right.
import "./console.css";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { cleryGeography, draftClery } from "@/lib/clery";
import { assessConsole } from "@/lib/console/assess";
import { DEFAULT_PANELS, loadPanels, PANEL_LABEL, savePanels, type PanelId, type PanelState } from "@/lib/console/panels";
import { PATROL_BEATS } from "@/lib/campus";
import { along, estimate, fetchRoute, remaining, type RoutePlan } from "@/lib/console/routing";
import { reserveAcrossBoard, teamNeeds, type Candidate } from "@/lib/console/team";
import type { ExtractError, ExtractResponse } from "@/lib/extraction";
import { FIELD_LABELS, SECTIONS } from "@/lib/fields";
import { URGENCY_LABEL } from "@/lib/priority";
import { formatEta } from "@/lib/recommend";
import { SCENARIOS, scenarioById } from "@/lib/scenarios";
import { categoryFrom, deskAnswered, deskIncidentId, deskSegments, type DeskCall } from "@/lib/deskBridge";
import { findPlaces, isVague, placeLatLng, primaryPlace, spokenName } from "@/lib/places";
import { act, newId, registerHq, serverToLocal, stamp, useAppState, useIsLeader, useOnline, useTerminals } from "@/lib/store";
import type { FieldKey, Incident, LatLng, Officer, OfficerAvatar, Priority } from "@/lib/types";
import { fmtClock, fmtTime } from "../ui";
import type { ConsoleRoute } from "./ConsoleMap";

/** Busy (amber) units: one slow start→end task (~5–7 min), then stay. Green stays put. */
const PATROL_TICK_MS = 2_000;
interface PatrolTrip {
  route: LatLng[];
  t0: number;
  label: string;
  phase: "moving" | "done";
  durationMs: number;
}

const CRITICAL_SECTIONS: { title: string; keys: FieldKey[] }[] = [
  { title: "Location", keys: ["building", "address", "floor", "room", "location_details"] },
  { title: "Nature", keys: ["description", "incident_time"] },
  { title: "Caller", keys: ["callback", "caller_name", "caller_safe"] },
  { title: "Injuries", keys: ["people_count", "condition", "conscious", "breathing", "patient_info"] },
  { title: "Threats", keys: ["weapons", "hazards", "suspect", "direction", "vehicle"] },
  { title: "Responders", keys: ["access"] },
];

const ConsoleMap = dynamic(() => import("./ConsoleMap"), {
  ssr: false,
  loading: () => <div className="dc-map" style={{ position: "absolute", inset: 0 }} />,
});

const STATUS_LABEL = { available: "Available", busy: "Busy", responding: "Responding", on_scene: "On scene" } as const;
const TRIP_MS = 12_000;
const EXTRACT_DEBOUNCE_MS = 900; // fill the notes this soon after the caller's words change
const EXTRACT_EVERY_MS = 3_000; // then at most this often per call (Gemini quota is per minute)
const DEMO_RING_MS = 4_000; // a demo call rings this long before it answers itself

type Mode = "gemini" | "prerecorded";
interface Trip { route: LatLng[]; t0: number; eta: number; k: number; next: number; incidentId: string }

function applyPrerecorded(inc: Incident, from: number, to: number) {
  const sc = scenarioById(inc.scenarioId);
  if (!sc) return;
  const updates = sc.segments.slice(from, to).flatMap((seg) => (seg.updates ?? []).map((u) => ({ ...u, evidenceSegmentId: seg.id })));
  if (updates.length) act({ type: "APPLY_AI_UPDATES", at: Date.now(), incidentId: inc.id, updates, source: "demo" });
}

function callTone(inc: Incident, assigned: Set<string>): "open" | "active" | "done" {
  if (inc.status === "closed") return "done";
  if (assigned.has(inc.id) || inc.status === "dispatched" || inc.status === "on_scene") return "active";
  return "open";
}

function signClery(incident: Incident, note: string | null) {
  const d = draftClery(incident);
  const loc = [incident.fields.building.value, incident.fields.room.value].filter(Boolean).join(" · ") || "Unknown";
  act({
    type: "SIGN_CLERY", at: stamp(), incidentId: incident.id,
    reportable: d.reportable, category: d.category, geographyLabel: d.geographyLabel, nibrs: d.nibrs,
    dailyLog: d.dailyLog, timelyWarning: d.timelyWarning, note,
    location: loc, title: incident.title, incidentNumber: incident.number,
    eventAt: incident.callStartedAt ?? incident.createdAt,
  });
}

export function ConsoleApp({ fontClass }: { fontClass: string }) {
  const state = useAppState();
  const terminals = useTerminals();
  const openIncidents = useMemo(
    () => state.incidents.filter((i) => i.status !== "closed"),
    [state.incidents],
  );
  const incident = state.incidents.find((i) => i.id === state.activeIncidentId) ?? null;
  const open = incident && incident.status !== "closed" ? incident : null;
  const scenario = incident ? scenarioById(incident.scenarioId) : null;
  const live = !!incident && !!incident.callStartedAt && !incident.callEndedAt;

  const [now, setNow] = useState<number | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [geminiReady, setGeminiReady] = useState<boolean | null>(null);
  const [mode, setMode] = useState<Mode>("prerecorded");
  const [aiBusy, setAiBusy] = useState(false);
  const [geminiQuestions, setGeminiQuestions] = useState<string[]>([]);
  const [plans, setPlans] = useState<Record<string, RoutePlan>>({});
  const [trips, setTrips] = useState<Record<string, Trip>>({});
  const [dispatchRoutes, setDispatchRoutes] = useState<Record<string, LatLng[]>>({});
  const [patrols, setPatrols] = useState<Record<string, PatrolTrip>>({});
  const startedPatrol = useRef<Set<string>>(new Set());
  const [selectedOfficerId, setSelectedOfficerId] = useState<string | null>(null);
  const [panels, setPanels] = useState<PanelState>(DEFAULT_PANELS);
  const [panelMenu, setPanelMenu] = useState(false);
  const [cleryWeek, setCleryWeek] = useState(false);
  const [reader, setReader] = useState<"transcript" | "fields" | "ask" | null>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [pendingPrio, setPendingPrio] = useState<Priority | null>(null);
  const [doneOpen, setDoneOpen] = useState(false);
  const autoCleryFor = useRef<Set<string>>(new Set());
  const seqRef = useRef(0);
  const appliedSeqRef = useRef(0);

  useEffect(() => {
    setHydrated(true);
    const t = setTimeout(() => {
      setPanels(loadPanels());
      setNow(Date.now());
    }, 0);
    const clock = setInterval(() => setNow(Date.now()), 500);
    fetch("/api/extract").then((r) => r.json()).then((j: { geminiConfigured: boolean }) => {
      setGeminiReady(j.geminiConfigured);
      if (j.geminiConfigured) setMode("gemini");
    }).catch(() => setGeminiReady(false));
    return () => { clearTimeout(t); clearInterval(clock); };
  }, []);

  const togglePanel = (id: PanelId) => {
    setPanels((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      savePanels(next);
      return next;
    });
  };

  const selectCase = (id: string) => {
    const picked = state.incidents.find((i) => i.id === id);
    act({ type: "SET_ACTIVE_INCIDENT", at: stamp(), incidentId: id });
    setSelectedOfficerId(null);
    // Completed cases: open transcript in the left dock so the empty space fills.
    setReader(picked && picked.status === "closed" ? "transcript" : null);
    setPanels((prev) => {
      if (prev.detail) return prev;
      const next = { ...prev, detail: true };
      savePanels(next);
      return next;
    });
  };

  const runGemini = useCallback(async (inc: Incident, transcript: Incident["transcript"]) => {
    const seq = ++seqRef.current;
    setAiBusy(true);
    const confirmed: Record<string, string> = {};
    for (const f of Object.values(inc.fields)) if (f.source === "dispatcher" && f.value) confirmed[f.key] = f.value;
    try {
      const res = await fetch("/api/extract", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: inc.category, transcript: transcript.map(({ id, speaker, text }) => ({ id, speaker, text })), confirmed }),
      });
      const j = (await res.json()) as ExtractResponse | ExtractError;
      if (!j.ok) throw new Error(j.message);
      if (seq < appliedSeqRef.current) return;
      appliedSeqRef.current = seq;
      if (j.updates.length) act({ type: "APPLY_AI_UPDATES", at: Date.now(), incidentId: inc.id, updates: j.updates, source: "ai" });
      setGeminiQuestions(j.suggestedQuestions);
    } catch (err) {
      act({ type: "LOG", at: Date.now(), incidentId: inc.id, actor: "system", eventType: "ai_fallback", message: `Gemini unavailable (${err instanceof Error ? err.message : "error"}).` });
      setMode("prerecorded");
      setGeminiQuestions([]);
      applyPrerecorded(inc, 0, transcript.length);
    } finally {
      if (seq === seqRef.current) setAiBusy(false);
    }
  }, []);

  const revealNext = useCallback(() => {
    if (!incident || !scenario || incident.revealed >= scenario.segments.length) return;
    const idx = incident.revealed;
    const seg = scenario.segments[idx];
    act({ type: "REVEAL_SEGMENT", at: Date.now(), incidentId: incident.id });
    if (mode === "prerecorded") applyPrerecorded(incident, idx, idx + 1);
    else if (seg.speaker === "caller") {
      const { updates: _u, ...plain } = seg;
      void _u;
      runGemini(incident, [...incident.transcript, plain]);
    }
  }, [incident, scenario, mode, runGemini]);

  useEffect(() => {
    if (!live || !incident || !scenario || now === null) return;
    const nextSeg = scenario.segments[incident.revealed];
    if (!nextSeg) return;
    const t = setTimeout(revealNext, Math.max(0, incident.callStartedAt! + nextSeg.t * 1000 - Date.now()));
    return () => clearTimeout(t);
  }, [live, incident, scenario, now, revealNext]);

  const endCall = useCallback(() => {
    if (!incident || !live) return;
    act({ type: "END_CALL", at: Date.now(), incidentId: incident.id });
  }, [incident, live]);

  // Clery drafts auto-append to the weekly file from the call sheet — dispatcher never "files" them.
  useEffect(() => {
    const log = state.cleryLog ?? [];
    for (const inc of state.incidents) {
      if (!inc.callEndedAt) continue;
      // Location pinned down after filing: refresh the automatic entry's Clery geography.
      const filed = log.find((c) => c.incidentId === inc.id);
      if (filed && filed.note == null && filed.geographyLabel !== cleryGeography(inc).label) {
        signClery(inc, null);
        continue;
      }
      if (inc.clerySignOff || autoCleryFor.current.has(inc.id)) continue;
      if (filed) {
        autoCleryFor.current.add(inc.id);
        continue;
      }
      autoCleryFor.current.add(inc.id);
      signClery(inc, null);
    }
  }, [state.incidents, state.cleryLog]);

  // ---------- live bridge to the station desk (station-desk/, real calls translated to English) ----------
  const [desk, setDesk] = useState<{ ok: boolean; calls: DeskCall[] } | null>(null);
  const lastLive = useRef(false);
  useEffect(() => {
    let alive = true;
    let t: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const j = (await (await fetch("/api/desk", { cache: "no-store" })).json()) as { ok: boolean; calls?: DeskCall[] };
        const next = { ok: j.ok, calls: j.calls ?? [] };
        if (alive) setDesk((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      } catch {
        if (alive) setDesk((prev) => (prev && !prev.ok && prev.calls.length === 0 ? prev : { ok: false, calls: [] }));
      }
      if (alive) t = setTimeout(poll, lastLive.current ? 400 : 1000);
    };
    void poll();
    // Chrome slows timers in background tabs (down to once a minute), so check again the moment the
    // dispatcher comes back to this tab instead of waiting for the next slowed tick.
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      clearTimeout(t);
      void poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => { alive = false; clearTimeout(t); document.removeEventListener("visibilitychange", onVisible); };
  }, []);
  const deskCalls = useMemo(() => desk?.calls ?? [], [desk]);
  const deskLiveCalls = deskCalls.filter((c) => c.status === "live");
  useEffect(() => { lastLive.current = deskLiveCalls.length > 0; }, [deskLiveCalls.length]);

  // Auto-take: when the dispatcher answers (or a desk practice call starts), open the call as an
  // incident and switch this screen to it. The id is the same on every screen, so it opens once.
  const [connected, setConnected] = useState<Record<string, number>>({});
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  const switchedTo = useRef<Set<string>>(new Set());
  const openDeskCall = useCallback((c: DeskCall, showConnected: boolean) => {
    switchedTo.current.add(c.id);
    const at = Date.now();
    const incidentId = deskIncidentId(c.id);
    if (!state.incidents.some((i) => i.id === incidentId)) {
      act({ type: "START_LIVE_CALL", at, incidentId, number: `INC-${String(Math.floor(at / 1000) % 100000).padStart(5, "0")}`, deskCallId: c.id, callerLanguage: c.callerLanguage });
    }
    setMode(geminiReady ? "gemini" : "prerecorded");
    act({ type: "SET_ACTIVE_INCIDENT", at, incidentId });
    setSelectedOfficerId(null);
    setReader(null);
    setPanels((prev) => {
      if (prev.detail) return prev;
      const next = { ...prev, detail: true };
      savePanels(next);
      return next;
    });
    setOpened((p) => new Set(p).add(c.id));
    if (showConnected) setConnected((p) => ({ ...p, [c.id]: at }));
  }, [state.incidents, geminiReady]);
  useEffect(() => {
    for (const c of deskLiveCalls) {
      if (!deskAnswered(c) || switchedTo.current.has(c.id)) continue;
      switchedTo.current.add(c.id);
      setTimeout(() => openDeskCall(c, true), 0);
    }
  }, [deskLiveCalls, openDeskCall]);
  // A call answered while this tab was open but in the background may have ended before we saw it
  // live. Still open it as a case so its transcript and critical info aren't lost. Calls from before
  // this page opened are left alone (they were handled, or deliberately cleared from the board).
  const online = useOnline();
  const pageOpenedAt = useRef(0);
  useEffect(() => { pageOpenedAt.current = stamp(); }, []);
  useEffect(() => {
    if (!online || !pageOpenedAt.current) return; // wait for shared state, so we know which cases exist
    for (const c of deskCalls) {
      if (c.status === "live" || switchedTo.current.has(c.id) || !deskAnswered(c)) continue;
      switchedTo.current.add(c.id);
      if (!c.endedAt || c.startedAt < pageOpenedAt.current - 5_000) continue;
      if (state.incidents.some((i) => i.id === deskIncidentId(c.id))) continue;
      setTimeout(() => openDeskCall(c, false), 0);
    }
  }, [online, deskCalls, state.incidents, openDeskCall]);
  const ringing = deskLiveCalls.filter((c) => !deskAnswered(c) && !opened.has(c.id));

  // Demo menu: a scripted call rings like a real one, then "answers" on its own (or when clicked) and
  // plays out line by line in its own case.
  const [demoMenu, setDemoMenu] = useState(false);
  const [demoRing, setDemoRing] = useState<{ scenarioId: string; startedAt: number } | null>(null);
  const [demoConnectedAt, setDemoConnectedAt] = useState<number | null>(null);
  const answerDemo = useCallback(() => {
    if (!demoRing) return;
    const at = Date.now();
    const incidentId = `demo-${at.toString(36)}`;
    act({ type: "START_CALL", at, incidentId, number: `INC-${String(Math.floor(at / 1000) % 100000).padStart(5, "0")}`, scenarioId: demoRing.scenarioId });
    setDemoRing(null);
    setDemoConnectedAt(at);
    setMode(geminiReady ? "gemini" : "prerecorded");
    setSelectedOfficerId(null);
    setReader(null);
    setPanels((prev) => {
      if (prev.detail) return prev;
      const next = { ...prev, detail: true };
      savePanels(next);
      return next;
    });
  }, [demoRing, geminiReady]);
  useEffect(() => {
    if (!demoRing) return;
    const t = setTimeout(answerDemo, Math.max(0, demoRing.startedAt + DEMO_RING_MS - Date.now()));
    return () => clearTimeout(t);
  }, [demoRing, answerDemo]);
  const startDemo = (scenarioId: string) => {
    setDemoMenu(false);
    setDemoRing({ scenarioId, startedAt: stamp() });
  };
  const demoConnected = demoConnectedAt !== null && now !== null && now - demoConnectedAt < 1500;

  // Flag a ringing call in the tab title too, so it shows even when this tab is in the background.
  const ringingCount = ringing.length + (demoRing ? 1 : 0);
  useEffect(() => {
    if (!ringingCount) return;
    const before = document.title;
    let on = true;
    const blink = setInterval(() => {
      on = !on;
      document.title = on ? "☎ Incoming call" : before;
    }, 1000);
    document.title = "☎ Incoming call";
    return () => { clearInterval(blink); document.title = before; };
  }, [ringingCount]);

  // Mirror every live desk call's transcript into its incident; run Gemini once the caller has paused;
  // end the console call when the desk call ends.
  const extractTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const lastExtractAt = useRef<Record<string, number>>({});
  const latestExtract = useRef<Record<string, { inc: Incident; segments: Incident["transcript"]; text: string }>>({});
  const extractedText = useRef<Record<string, string>>({});
  useEffect(() => {
    for (const inc of openIncidents) {
      if (!inc.deskCallId) continue;
      const call = deskCalls.find((c) => c.id === inc.deskCallId);
      if (!call) continue;
      const segments = deskSegments(call);
      if (JSON.stringify(segments) !== JSON.stringify(inc.transcript)) {
        act({ type: "SET_DESK_TRANSCRIPT", at: Date.now(), incidentId: inc.id, transcript: segments });
      }
      const callerText = segments.filter((x) => x.speaker === "caller").map((x) => x.text).join(" ");
      if (mode === "gemini" && callerText && callerText !== extractedText.current[inc.id]) {
        // Throttle, don't debounce: a caller who keeps talking must still update the notes. Fill the
        // notes soon after new words, then at most every EXTRACT_EVERY_MS (Gemini quota is per minute),
        // always with the latest transcript.
        latestExtract.current[inc.id] = { inc: { ...inc, transcript: segments }, segments, text: callerText };
        if (!extractTimers.current[inc.id]) {
          const wait = Math.max(EXTRACT_DEBOUNCE_MS, (lastExtractAt.current[inc.id] ?? 0) + EXTRACT_EVERY_MS - Date.now());
          extractTimers.current[inc.id] = setTimeout(() => {
            delete extractTimers.current[inc.id];
            const job = latestExtract.current[inc.id];
            if (!job || job.text === extractedText.current[inc.id]) return;
            extractedText.current[inc.id] = job.text;
            lastExtractAt.current[inc.id] = Date.now();
            runGemini(job.inc, job.segments);
          }, wait);
        }
      }
      if (call.status !== "live" && inc.callStartedAt && !inc.callEndedAt) act({ type: "END_CALL", at: Date.now(), incidentId: inc.id });
    }
  }, [openIncidents, deskCalls, mode, runGemini]);

  // Classify each live call, and pin places as soon as the caller names them.
  useEffect(() => {
    for (const inc of openIncidents) {
      const call = inc.deskCallId ? deskCalls.find((c) => c.id === inc.deskCallId) : undefined;
      const callerText = inc.transcript.filter((x) => x.speaker === "caller").map((x) => x.text).join(" \n ");
      const at = Date.now();
      let mainPlace = inc.placeName ?? null;
      if (inc.deskCallId) {
        const text = [inc.fields.category.value, inc.fields.description.value, call?.callType, callerText].filter(Boolean).join(" \n ");
        const cat = text ? categoryFrom(text) : null;
        if (cat && inc.category === "other") act({ type: "SET_CATEGORY", at, incidentId: inc.id, category: cat });
        const where = findPlaces([callerText, inc.fields.building.value, inc.fields.location_details.value, call?.location].filter(Boolean).join(" \n "));
        const best = primaryPlace(where);
        const refine = inc.locationPending || (inc.placeKind && (inc.placeKind === "street" || inc.placeKind === "area") && best && !isVague(best));
        if (best && refine && spokenName(best) !== inc.placeName) {
          act({ type: "SET_PLACE", at, incidentId: inc.id, placeId: best.id, name: spokenName(best), kind: best.kind, location: placeLatLng(best) });
          mainPlace = spokenName(best);
        }
      }
      const near = (p: { lat: number; lng: number }) => Math.abs(p.lat - inc.location[0]) + Math.abs(p.lng - inc.location[1]) < 0.0004;
      const pinned = new Set((inc.mentionedPlaces ?? []).map((m) => m.id));
      const others = findPlaces(callerText).filter((p) => !near(p) && spokenName(p) !== mainPlace && !pinned.has(p.id));
      if (others.length) {
        act({ type: "MENTION_PLACES", at, incidentId: inc.id, places: others.map((p) => ({ id: p.id, name: spokenName(p), location: placeLatLng(p) })) });
      }
    }
  }, [openIncidents, deskCalls]);

  const recentlyConnected = deskLiveCalls.filter((c) => connected[c.id] && now !== null && now - connected[c.id] < 1500);

  const assessment = incident ? assessConsole(incident.category, incident.fields) : null;
  const shownPriority: Priority | null = incident ? incident.priorityDecision?.priority ?? assessment!.proposed : null;

  const assignedIds = useMemo(() => {
    const s = new Set<string>();
    for (const a of state.assignments) if (a.status === "active" || a.status === "queued") s.add(a.incidentId);
    return s;
  }, [state.assignments]);

  const ts = now ?? Date.now();
  const freeInFor = useCallback((o: Officer) => {
    if (o.status === "available") return 0;
    if (o.status !== "busy" || o.currentIncidentId) return Number.POSITIVE_INFINITY;
    if (o.busyUntil) return Math.max(0, Math.round((o.busyUntil - ts) / 1000));
    const p = patrols[o.id];
    if (p?.phase === "done") return 0;
    if (p?.phase === "moving") {
      const left = Math.max(0, 1 - (ts - p.t0) / p.durationMs);
      return Math.round(left * p.durationMs / 1000);
    }
    const beat = PATROL_BEATS[o.id];
    return Math.round((beat?.durationMs ?? 360_000) / 1000);
  }, [ts, patrols]);

  /** Free now, wrapping up a post, or already on a call (queued for after they clear). */
  const pool = useMemo(
    () => state.officers.filter((o) => {
      if (open?.declinedOfficerIds.includes(o.id)) return false;
      if (o.status === "available") return true;
      if (o.status === "busy" && !o.currentIncidentId) return freeInFor(o) < 15 * 60;
      if (o.status === "responding" || o.status === "on_scene" || o.currentIncidentId) return true;
      return false;
    }),
    [open, state.officers, freeInFor],
  );
  const free = useMemo(() => pool.filter((o) => o.status === "available"), [pool]);
  // Includes the incident position: a live desk call starts at a placeholder and moves once the place is known.
  const planKey = (o: Officer, inc: Incident) => `${o.id}|${inc.id}|${inc.location[0].toFixed(5)},${inc.location[1].toFixed(5)}|${o.location[0].toFixed(5)},${o.location[1].toFixed(5)}`;
  useEffect(() => {
    if (!open) return;
    let alive = true;
    for (const o of pool) {
      const k = planKey(o, open);
      if (plans[k]?.real) continue;
      fetchRoute(o.location, open.location, o.mode).then((p) => { if (alive) setPlans((prev) => (prev[k] === p ? prev : { ...prev, [k]: p })); });
    }
    return () => { alive = false; };
  }, [open, pool, plans]);
  const planFor = useCallback((o: Officer, inc: Incident) => plans[planKey(o, inc)] ?? estimate(o.location, inc.location, o.mode), [plans]);

  const candidatesFor = useCallback((inc: Incident): Candidate[] => (
    pool.map((o) => {
      const plan = planFor(o, inc);
      // On a call → treat as "busy until clear" so free units still win recommendations.
      const onCall = !!(o.currentIncidentId) || o.status === "responding" || o.status === "on_scene";
      const freeInSeconds = onCall ? 20 * 60 : freeInFor(o);
      return {
        officer: o,
        plan,
        freeInSeconds: Number.isFinite(freeInSeconds) ? freeInSeconds : 9999,
        effectiveEtaSeconds: (Number.isFinite(freeInSeconds) ? freeInSeconds : 9999) + plan.etaSeconds,
      };
    })
  ), [pool, planFor, freeInFor]);

  const needsInfo = open && shownPriority ? teamNeeds(open, shownPriority) : { why: "", needs: [] as ReturnType<typeof teamNeeds>["needs"] };
  const { why, needs } = needsInfo;

  // Multi-case: reserve the best unit for higher-priority / live calls first so Patel isn't rec'd for both.
  const boardReservations = useMemo(() => {
    const openBoard = state.incidents.filter((i) => i.status !== "closed");
    const cases = openBoard.map((inc) => {
      const p = (inc.priorityDecision?.priority ?? assessConsole(inc.category, inc.fields).proposed) as Priority;
      const need = teamNeeds(inc, p);
      const active = state.assignments.filter((a) => a.incidentId === inc.id && (a.status === "active" || a.status === "queued")).length;
      return { incident: inc, priority: p, needs: need.needs, slots: Math.max(0, need.needs.length - active) };
    });
    return reserveAcrossBoard(cases, candidatesFor);
  }, [state.incidents, state.assignments, candidatesFor]);

  const team = open && shownPriority ? (boardReservations.get(open.id) ?? []) : [];
  const missing = open && shownPriority ? needs.slice(team.length) : [];
  const assignments = open ? state.assignments.filter((a) => a.incidentId === open.id && (a.status === "active" || a.status === "queued")) : [];
  const assigned = assignments.map((a) => ({ a, o: state.officers.find((x) => x.id === a.officerId)! })).filter((x) => x.o);
  const activeAssigned = assigned.filter(({ a }) => a.status === "active");
  const queuedAssigned = assigned.filter(({ a }) => a.status === "queued");
  const dispatched = assigned.length > 0;
  const allOnScene = activeAssigned.length > 0 && activeAssigned.every((x) => x.o.status === "on_scene") && queuedAssigned.length === 0;
  const teamIds = dispatched ? assigned.map((x) => x.o.id) : team.map((c) => c.officer.id);

  // Road routes: live response, completed-case trip replay, and dotted dest lines for busy / en-route units.
  const routes: ConsoleRoute[] = (() => {
    const out: ConsoleRoute[] = [];
    const viewingDone = incident && callTone(incident, assignedIds) === "done";
    if (viewingDone && incident) {
      for (const a of state.assignments.filter((x) => x.incidentId === incident.id && x.route && x.route.length > 1)) {
        out.push({ id: `hist-${a.id}`, points: a.route!, foot: false, kind: "history" });
      }
    } else if (open) {
      if (dispatched) {
        for (const { o, a } of assigned) {
          if (o.status !== "responding" && o.status !== "on_scene") continue;
          const tr = trips[o.id];
          const planned = dispatchRoutes[o.id] ?? a.route;
          const pts = tr
            ? [o.location, ...tr.route.slice(tr.next)]
            : planned && planned.length > 1
              ? remaining(planned, o.location)
              : [o.location, open.location];
          if (pts.length > 1) out.push({ id: o.id, points: pts, foot: o.mode === "foot", kind: "assigned" });
        }
      }
      // No dotted “proposed” paths for free (green) units — paths only appear once a unit is sent.
    }
    // Busy (amber) only: yellow task line while still moving to the post. Gone once they arrive.
    for (const o of state.officers) {
      if (o.status !== "busy" || trips[o.id]) continue;
      const p = patrols[o.id];
      if (p && p.phase === "moving" && p.route.length > 1) {
        out.push({ id: `dest-${o.id}`, points: remaining(p.route, o.location), foot: o.mode === "foot", kind: "dest" });
      }
    }
    return out;
  })();

  const terminalOnline = (id: string) => !!terminals[id] && (now ?? 0) - serverToLocal(terminals[id]) < 5000;
  const lost = assigned.filter(({ o }) => terminals[o.id] && !terminalOnline(o.id)).map(({ o }) => ({ o, since: serverToLocal(terminals[o.id]) }));
  // Stable campus overview — selecting a call highlights markers; never dives the camera in.
  const fitKey = "campus";

  useEffect(() => {
    if (!Object.keys(trips).length) return;
    const t = setTimeout(() => {
      const ts = Date.now();
      const next: Record<string, Trip> = {};
      for (const [id, tr] of Object.entries(trips)) {
        const k = Math.min(1, (ts - tr.t0) / TRIP_MS);
        if (k >= 1) { act({ type: "OFFICER_STATUS", at: ts, officerId: id, status: "on_scene" }); continue; }
        const { at, next: n } = along(tr.route, k);
        // A signed-in patrol device moves its own officer (real or simulated GPS); don't fight it.
        if (!terminalOnline(id)) act({ type: "OFFICER_LOCATION", at: ts, officerId: id, location: at, label: "En route (GPS)" });
        next[id] = { ...tr, k, next: n };
      }
      setTrips(next);
    }, 300);
    return () => clearTimeout(t);
  }, [trips]);

  // This is an HQ screen: all HQ screens show the same shared state, and only the leader (the screen
  // open longest) animates officers, so two screens never push competing positions.
  useEffect(() => {
    registerHq(true);
    return () => registerHq(false);
  }, []);
  const isLeader = useIsLeader();

  // Ambient motion for busy (amber) units: one slow trip along their beat, then stay on post. Only the
  // leader screen does this, picking up from wherever the officer is now (no snapping back on reload).
  useEffect(() => {
    if (!hydrated || !isLeader) return;
    let alive = true;
    const assignedIds = new Set(
      state.assignments.filter((a) => a.status === "active").map((a) => a.officerId),
    );
    for (const o of state.officers) {
      if (o.status !== "busy" || assignedIds.has(o.id)) continue;
      const beat = PATROL_BEATS[o.id];
      if (!beat || beat.points.length < 2) continue;
      if (patrols[o.id] || startedPatrol.current.has(o.id)) continue;
      if (terminalOnline(o.id) || /on post$/.test(o.locationLabel)) continue; // device-driven, or already there
      startedPatrol.current.add(o.id);
      const delay = (o.id.charCodeAt(1) % 5) * 500;
      const from: LatLng = o.location;
      const to = beat.points[1];
      window.setTimeout(() => {
        if (!alive) return;
        fetchRoute(from, to, beat.mode).then((plan) => {
          if (!alive || plan.route.length < 2) {
            startedPatrol.current.delete(o.id);
            return;
          }
          setPatrols((prev) => prev[o.id] ? prev : {
            ...prev,
            [o.id]: {
              route: plan.route,
              t0: Date.now(),
              label: beat.label,
              phase: "moving",
              durationMs: beat.durationMs,
            },
          });
        });
      }, delay);
    }
    for (const id of [...startedPatrol.current, ...Object.keys(patrols)]) {
      const o = state.officers.find((x) => x.id === id);
      if (!o || o.status !== "busy" || assignedIds.has(id)) {
        startedPatrol.current.delete(id);
        setPatrols((prev) => {
          if (!prev[id]) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }
    }
    return () => { alive = false; };
  }, [hydrated, isLeader, state.officers, state.assignments, patrols]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isLeader || !Object.keys(patrols).length) return;
    const assignedIds = new Set(
      state.assignments.filter((a) => a.status === "active").map((a) => a.officerId),
    );
    const t = setTimeout(() => {
      const nowTs = Date.now();
      const next: Record<string, PatrolTrip> = { ...patrols };
      for (const [id, p] of Object.entries(patrols)) {
        const o = state.officers.find((x) => x.id === id);
        if (!o || o.status !== "busy" || assignedIds.has(id) || terminalOnline(id)) {
          delete next[id];
          continue;
        }
        if (p.phase === "done") continue;
        const k = Math.min(1, (nowTs - p.t0) / p.durationMs);
        const { at } = along(p.route, k);
        if (k < 1) {
          act({ type: "OFFICER_LOCATION", at: nowTs, officerId: id, location: at, label: p.label });
          continue;
        }
        const end = p.route[p.route.length - 1] ?? at;
        act({ type: "OFFICER_LOCATION", at: nowTs, officerId: id, location: end, label: `${p.label} · on post` });
        next[id] = { ...p, phase: "done", route: [end] };
      }
      setPatrols(next);
    }, PATROL_TICK_MS);
    return () => clearTimeout(t);
  }, [isLeader, patrols, state.officers, state.assignments]); // eslint-disable-line react-hooks/exhaustive-deps

  const sendOfficer = (o: Officer) => {
    if (!open) return;
    const already = state.assignments.some((a) => a.officerId === o.id && a.incidentId === open.id && (a.status === "active" || a.status === "queued"));
    if (already) return;
    const onCall = !!(o.currentIncidentId) || o.status === "responding" || o.status === "on_scene";
    if (!onCall && o.status !== "available" && o.status !== "busy") return;
    const plan = planFor(o, open);
    const at = stamp();
    act({ type: "APPROVE_ASSIGNMENT", at, incidentId: open.id, officerId: o.id, assignmentId: newId("asg"), etaSeconds: plan.etaSeconds, route: plan.route });
    // Only simulate movement when this is their active job (not queued behind another call).
    if (!onCall && !terminalOnline(o.id)) {
      setTrips((p) => ({ ...p, [o.id]: { route: plan.route, t0: at, eta: plan.etaSeconds, k: 0, next: 1, incidentId: open.id } }));
    }
    setDispatchRoutes((p) => ({ ...p, [o.id]: plan.route }));
    setSelectedOfficerId(o.id);
    setAssignOpen(false);
  };
  const unassignOfficer = (officerId: string) => {
    if (!open) return;
    const asg = state.assignments.find((a) => a.officerId === officerId && a.incidentId === open.id && (a.status === "active" || a.status === "queued"));
    if (!asg) return;
    act({ type: "CANCEL_ASSIGNMENT", at: stamp(), assignmentId: asg.id });
    if (asg.status === "active") {
      setTrips((p) => { const n = { ...p }; delete n[officerId]; return n; });
      setDispatchRoutes((p) => { const n = { ...p }; delete n[officerId]; return n; });
    }
  };

  const manualPrio = useRef(false);
  useEffect(() => {
    setAssignOpen(false);
    setPendingPrio(null);
    manualPrio.current = false;
  }, [open?.id]);

  // Auto-grade every open case as soon as the caller has said something, and keep that grade current
  // as the call fills in. Once the dispatcher sets a level themselves (with a confirm), theirs sticks.
  useEffect(() => {
    for (const inc of openIncidents) {
      if (!inc.transcript.some((x) => x.speaker === "caller")) continue;
      const proposed = assessConsole(inc.category, inc.fields).proposed;
      const d = inc.priorityDecision;
      if (d && (!d.auto || d.priority === proposed)) continue;
      act({ type: "DECIDE_PRIORITY", at: stamp(), incidentId: inc.id, priority: proposed, proposed, overrideReason: null, auto: true });
    }
  }, [openIncidents]);

  useEffect(() => {
    if (!live && reader === "ask") setReader(null);
  }, [live, reader]);

  const selectedOfficer = selectedOfficerId ? state.officers.find((o) => o.id === selectedOfficerId) ?? null : null;
  const selectedPlan = selectedOfficer && open ? planFor(selectedOfficer, open) : null;
  const selectedAsg = selectedOfficer ? state.assignments.find((a) => a.officerId === selectedOfficer.id && a.status === "active") ?? null : null;
  const selectedIncForOfficer = selectedAsg ? state.incidents.find((i) => i.id === selectedAsg.incidentId) ?? null : null;
  const etaLeft = selectedAsg && selectedOfficer?.status === "responding"
    ? Math.max(0, selectedAsg.etaSeconds - Math.round(((now ?? Date.now()) - (selectedAsg.acknowledgedAt ?? selectedAsg.approvedAt)) / 1000))
    : selectedPlan?.etaSeconds ?? null;

  const confirmPriority = (p: Priority) => {
    if (!open || !assessment) return;
    const prev = open.priorityDecision?.priority ?? null;
    const reason = prev != null && prev !== p ? `Changed from P${prev}` : null;
    act({ type: "DECIDE_PRIORITY", at: stamp(), incidentId: open.id, priority: p, proposed: assessment.proposed, overrideReason: reason });
    setPendingPrio(null);
  };

  const casePriority = (i: Incident): Priority | null =>
    i.priorityDecision?.priority ?? null;
  const caseIsLive = (i: Incident) => !!i.callStartedAt && !i.callEndedAt;

  const byPriority = (a: Incident, b: Incident) => {
    const pa = casePriority(a) ?? assessConsole(a.category, a.fields).proposed;
    const pb = casePriority(b) ?? assessConsole(b.category, b.fields).proposed;
    return pa - pb || (a.callStartedAt ?? a.createdAt) - (b.callStartedAt ?? b.createdAt);
  };
  // Top rail L→R: completed · yellow attending · red waiting · live (rightmost).
  const boardActive = [...state.incidents]
    .filter((i) => callTone(i, assignedIds) === "active" && !caseIsLive(i))
    .sort(byPriority);
  const boardOpen = [...state.incidents]
    .filter((i) => callTone(i, assignedIds) === "open" && !caseIsLive(i))
    .sort(byPriority);
  const boardRinging = [...state.incidents]
    .filter((i) => caseIsLive(i) && callTone(i, assignedIds) !== "done")
    .sort(byPriority);
  const boardDone = [...state.incidents]
    .filter((i) => callTone(i, assignedIds) === "done")
    .sort((a, b) => (b.callEndedAt ?? b.closedAt ?? b.createdAt) - (a.callEndedAt ?? a.closedAt ?? a.createdAt));
  const boardOpenCount = boardActive.length + boardOpen.length + boardRinging.length;

  const onKey = useEffectEvent((e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (e.metaKey || e.ctrlKey || e.altKey || t?.closest?.("input, textarea, select")) return;
    const k = e.key.toLowerCase();
    if (k === "c" && open && assessment) confirmPriority(assessment.proposed);
    else if ("1234".includes(k) && k && open) {
      manualPrio.current = true;
      setPendingPrio(Number(k) as Priority);
    }
  });
  useEffect(() => {
    const h = (e: KeyboardEvent) => onKey(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const openBackups = (state.backups ?? []).filter((b) => b.status !== "resolved");
  const atHq = state.officers.filter((o) => /HQ/i.test(o.locationLabel) && o.status === "available");
  const recIds = new Set(team.map((c) => c.officer.id));
  const callStartedLabel = (i: Incident) =>
    new Date(i.callStartedAt ?? i.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const caseBoardTitle = (i: Incident) => i.title.split(":")[0];

  return (
    <div className={`dc ${fontClass}`} data-theme="dark" data-prio={shownPriority ?? ""}>
      <div className="dc-stage">
        <ConsoleMap
          officers={state.officers}
          incident={open ?? incident}
          priority={shownPriority}
          routes={routes}
          teamIds={teamIds}
          theme="dark"
          fitKey={`${fitKey}-${reader ? "rail" : "map"}`}
          padLeft={reader ? 730 : 396}
          padTop={panels.board ? 68 : 56}
          padRight={panels.roster ? 300 : 72}
          lostIds={lost.map((x) => x.o.id)}
          selectedOfficerId={selectedOfficerId}
          onSelectOfficer={(id) => { setSelectedOfficerId(id); }}
          incidents={state.incidents}
          selectedIncidentId={state.activeIncidentId}
          onSelectIncident={selectCase}
          assignedIncidentIds={[...assignedIds]}
        />
        {panels.board && (boardOpenCount > 0 || boardDone.length > 0) && (
          <header className="dc-cases-top" aria-label="Cases">
            <ul className="dc-cases-rail">
              {boardDone.length > 0 && (
                <li className="dc-cases-done-wrap">
                  <div className={`dc-cases-done${doneOpen ? " open" : ""}`}>
                    <button
                      type="button"
                      className="dc-cases-done-toggle"
                      aria-expanded={doneOpen}
                      title={doneOpen ? "Hide completed" : `Completed · ${boardDone.length}`}
                      onClick={() => setDoneOpen((v) => !v)}
                    >
                      <i className="dc-tone done" />
                      <span>{boardDone.length}</span>
                    </button>
                    {doneOpen && (
                      <div className="dc-done-dots" role="list">
                        {boardDone.map((i) => {
                          const p = casePriority(i) ?? assessConsole(i.category, i.fields).proposed;
                          return (
                            <button
                              key={i.id}
                              type="button"
                              role="listitem"
                              className={`dc-done-dot${i.id === incident?.id ? " on" : ""}`}
                              title={`${caseBoardTitle(i)} · P${p} · ${callStartedLabel(i)}`}
                              aria-label={`Completed: ${caseBoardTitle(i)}`}
                              onClick={() => selectCase(i.id)}
                            />
                          );
                        })}
                      </div>
                    )}
                  </div>
                </li>
              )}
              {boardActive.map((i) => {
                const p = casePriority(i);
                return (
                  <li key={i.id}>
                    <button
                      type="button"
                      className={`dc-case-pill active${i.id === incident?.id ? " on" : ""}`}
                      onClick={() => selectCase(i.id)}
                    >
                      <i className="dc-tone active" />
                      <span className="dc-case-pill-main">
                        <em>{p != null ? `P${p}` : "—"}</em>
                        {caseBoardTitle(i)}
                      </span>
                    </button>
                  </li>
                );
              })}
              {boardOpen.map((i) => {
                const p = casePriority(i);
                return (
                  <li key={i.id}>
                    <button
                      type="button"
                      className={`dc-case-pill open${i.id === incident?.id ? " on" : ""}`}
                      onClick={() => selectCase(i.id)}
                    >
                      <i className="dc-tone open" />
                      <span className="dc-case-pill-main">
                        <em>{p != null ? `P${p}` : "—"}</em>
                        {caseBoardTitle(i)}
                      </span>
                    </button>
                  </li>
                );
              })}
              {boardRinging.map((i) => {
                const p = casePriority(i);
                return (
                  <li key={i.id}>
                    <button
                      type="button"
                      className={`dc-case-pill live${i.id === incident?.id ? " on" : ""}`}
                      onClick={() => selectCase(i.id)}
                    >
                      <i className="dc-tone open" />
                      <span className="dc-case-pill-main">
                        <em>{p != null ? `P${p}` : "—"}</em>
                        {caseBoardTitle(i)}
                      </span>
                      <span className="dc-live-flash">Live</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </header>
        )}
        {(ringing.length > 0 || recentlyConnected.length > 0 || demoRing || demoConnected) && (
          <div className="dc-callbanners" role="alert" aria-live="assertive">
            {demoRing && (
              <button type="button" className="dc-callbanner ringing" onClick={answerDemo}>
                <span className="dc-callbanner-icon" aria-hidden>☎</span>
                <span className="dc-callbanner-main">
                  <b>Incoming emergency call</b>
                  <span>Demo · {scenarioById(demoRing.scenarioId)?.title ?? "Scripted call"}</span>
                </span>
                <span className="dc-callbanner-time">Ringing {now ? fmtClock(Math.max(0, now - demoRing.startedAt)) : ""}</span>
                <span className="dc-callbanner-hint">Click to answer now · answers on its own in a few seconds</span>
              </button>
            )}
            {demoConnected && (
              <div className="dc-callbanner connected">
                <span className="dc-callbanner-icon" aria-hidden>✓</span>
                <span className="dc-callbanner-main">
                  <b>Call connected</b>
                  <span>Demo call</span>
                </span>
              </div>
            )}
            {ringing.map((c) => (
              <button key={c.id} type="button" className="dc-callbanner ringing" onClick={() => openDeskCall(c, false)}>
                <span className="dc-callbanner-icon" aria-hidden>☎</span>
                <span className="dc-callbanner-main">
                  <b>Incoming emergency call</b>
                  <span>{c.from ?? "Unknown number"}{c.callerLanguage && !/^english$/i.test(c.callerLanguage) ? ` · ${c.callerLanguage}` : ""}</span>
                </span>
                <span className="dc-callbanner-time">Ringing {now ? fmtClock(Math.max(0, now - c.startedAt)) : ""}</span>
                <span className="dc-callbanner-hint">Click to open this call now · opens on its own when answered</span>
              </button>
            ))}
            {recentlyConnected.map((c) => (
              <div key={c.id} className="dc-callbanner connected">
                <span className="dc-callbanner-icon" aria-hidden>✓</span>
                <span className="dc-callbanner-main">
                  <b>Call connected</b>
                  <span>{c.from ?? (c.source === "mic" ? "Desk practice call" : "Unknown number")}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {panelMenu && (
        <div className="dc-panels-menu" role="dialog" aria-label="Panels">
          <h3>Snap panels</h3>
          {(Object.keys(PANEL_LABEL) as PanelId[]).map((id) => (
            <label key={id}>
              <input type="checkbox" checked={panels[id]} onChange={() => togglePanel(id)} />
              {PANEL_LABEL[id]}
            </label>
          ))}
          <p className="dc-note">Keep what you need. Map stays primary.</p>
        </div>
      )}

      {openBackups[0] && (
        <div className={`dc-backup ${openBackups[0].status}`} role="alert">
          <div>
            <b>{state.officers.find((o) => o.id === openBackups[0].officerId)?.callsign} needs backup</b>
          </div>
          <div className="dc-backup-acts">
            {openBackups[0].status === "open" && <button type="button" className="dc-btn sm primary" onClick={() => act({ type: "ACK_BACKUP", at: stamp(), requestId: openBackups[0].id })}>Ack</button>}
            <button type="button" className="dc-btn sm" onClick={() => act({ type: "RESOLVE_BACKUP", at: stamp(), requestId: openBackups[0].id })}>Clear</button>
          </div>
        </div>
      )}

      <aside className="dc-dock-left" aria-label="Dispatch">
        {/* Primary dispatch surface — severity + who to send. Cases live in the top rail. */}
        <section className={`dc-panel dispatch grow${open ? " live" : ""}`} aria-label="Dispatch">
          <header className="dc-panel-head">
            <h2>Dispatch</h2>
            {open && <span className="dc-case-id">{open.number}</span>}
          </header>
          <div className="dc-panel-body dc-dispatch-body">
            {!open && incident && callTone(incident, assignedIds) === "done" && assessment && (
              <div className="dc-dispatch-done">
                <div className="dc-sev-readonly">
                  <span className="dc-sev-label">Case severity</span>
                  <b>P{shownPriority ?? assessment.proposed}</b>
                  <span>{URGENCY_LABEL[assessment.urgency]}</span>
                </div>
                {incident.clerySignOff && <p className="dc-clery-note">Clery details added to the weekly file.</p>}
              </div>
            )}
            {!open && !incident && (
              <p className="dc-dispatch-idle">No active cases. Incoming calls and demos open here automatically.</p>
            )}
            {open && assessment && (
              <>
                <PriorityBlock
                  incident={open}
                  proposed={assessment.proposed}
                  pending={pendingPrio}
                  onPick={(p) => { manualPrio.current = true; setPendingPrio(p); }}
                  onConfirm={confirmPriority}
                  onCancel={() => { manualPrio.current = true; setPendingPrio(null); }}
                />
                <div className={`dc-recommend${reader ? " compact" : ""}`} data-mode={allOnScene ? "onscene" : dispatched ? "sent" : ""}>
                  <div className="dc-rec-kicker">Assign police officers</div>
                  <p className="dc-rec-why">{why || "Nearest free officer for this call."}</p>
                  <p className="dc-rec-count">
                    {allOnScene
                      ? "All assigned units on scene"
                      : dispatched
                        ? `${assigned.length} dispatched`
                        : `Recommended: ${needs.length || 1} dispatch`}
                  </p>
                  <div className="dc-assign-row">
                    {assigned.map(({ o, a }) => {
                      const tr = trips[o.id];
                      const left = tr ? Math.round((1 - tr.k) * tr.eta) : 0;
                      const queued = a.status === "queued";
                      return (
                        <div key={a.id} className={`dc-assign-chip${queued ? " queued" : ""}`} title={o.name}>
                          <span className="dc-assign-av"><MiniAvatar avatar={o.avatar ?? { skin: "#E9C9A8", hair: "#2A1A12", hat: "#1A2234" }} /></span>
                          <span className="dc-assign-meta">
                            <b>{o.callsign}</b>
                            <small>
                              {queued
                                ? "queued · after current"
                                : o.status === "on_scene" ? "on scene" : tr ? `ETA ${fmtClock(left * 1000)}` : a.acknowledgedAt ? "en route" : "sent"}
                            </small>
                          </span>
                          {(queued || o.status !== "on_scene") && (
                            <button type="button" className="dc-assign-x" aria-label={`Remove ${o.callsign}`} onClick={() => unassignOfficer(o.id)}>×</button>
                          )}
                        </div>
                      );
                    })}
                    {!allOnScene && (
                      <button type="button" className="dc-assign-plus" aria-label="Open dispatch desk" aria-pressed={assignOpen} onClick={() => setAssignOpen((v) => !v)}>+</button>
                    )}
                  </div>
                  {missing.length > 0 && !dispatched && (
                    <p className="dc-rec-short">{missing.length} more recommended than free right now.</p>
                  )}
                </div>
                {/* Critical notes stay in the left column even while the transcript / Clery / questions panel is open. */}
                <div className={`dc-case-slot${assignOpen ? " assigning" : ""}`}>
                  {assignOpen ? (
                    <div className="dc-dispatch-desk" role="dialog" aria-label="Dispatch desk">
                      <div className="dc-assign-pop-head">
                        <b>Dispatch desk</b>
                        <button type="button" className="dc-btn sm ghost" onClick={() => setAssignOpen(false)}>✕</button>
                      </div>
                      {team.length > 0 && (
                        <>
                          <div className="dc-rec-section-label">Recommended for this case</div>
                          <ul className="dc-assign-list">
                            {team.map((c) => (
                              <li key={c.officer.id}>
                                <button type="button" className="rec" onClick={() => sendOfficer(c.officer)}>
                                  <MiniAvatar avatar={c.officer.avatar ?? { skin: "#E9C9A8", hair: "#2A1A12", hat: "#1A2234" }} />
                                  <span>
                                    <b>{c.officer.callsign}</b>
                                    <small>
                                      {c.freeInSeconds > 0 ? `Free in ${formatEta(c.freeInSeconds)} · then ` : ""}
                                      {formatEta(c.plan.etaSeconds)} · {c.officer.locationLabel}
                                    </small>
                                  </span>
                                  <em>Rec</em>
                                </button>
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                      <div className="dc-rec-section-label">All units (free, busy walk, or queue after current)</div>
                      <ul className="dc-assign-list">
                        {candidatesFor(open)
                          .filter((c) => !assigned.some((x) => x.o.id === c.officer.id))
                          .sort((a, b) => a.effectiveEtaSeconds - b.effectiveEtaSeconds)
                          .map((c) => {
                          const onCall = !!(c.officer.currentIncidentId) || c.officer.status === "responding" || c.officer.status === "on_scene";
                          const walking = c.officer.status === "busy" && !onCall;
                          return (
                          <li key={c.officer.id}>
                            <button type="button" className={recIds.has(c.officer.id) ? "rec" : ""} onClick={() => sendOfficer(c.officer)}>
                              <MiniAvatar avatar={c.officer.avatar ?? { skin: "#E9C9A8", hair: "#2A1A12", hat: "#1A2234" }} />
                              <span>
                                <b>{c.officer.callsign}</b>
                                <small>
                                  {onCall
                                    ? `On call · queue after · ETA ${formatEta(c.plan.etaSeconds)}`
                                    : walking
                                      ? `Busy walk · ${formatEta(c.freeInSeconds)} left · then ${formatEta(c.plan.etaSeconds)}`
                                      : `${c.freeInSeconds > 0 ? `Task ${formatEta(c.freeInSeconds)} left · ` : ""}ETA ${formatEta(c.plan.etaSeconds)}${c.officer.busyWith ? ` · ${c.officer.busyWith}` : ` · ${c.officer.locationLabel}`}`}
                                </small>
                              </span>
                              {recIds.has(c.officer.id) && <em>Rec</em>}
                            </button>
                          </li>
                          );
                        })}
                        {pool.length === 0 && <li className="dc-board-empty">No free officers</li>}
                      </ul>
                    </div>
                  ) : (
                    <div className="dc-notes-inline">
                      <div className="dc-sev-label">Critical notes</div>
                      <CriticalNotes incident={open} />
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
          {incident && (
            <div className="dc-note-acts" role="group" aria-label="Open case details">
              <button type="button" className={reader === "transcript" ? "on" : ""} onClick={() => setReader(reader === "transcript" ? null : "transcript")}>
                Transcript
              </button>
              <button type="button" className={reader === "fields" ? "on" : ""} onClick={() => setReader(reader === "fields" ? null : "fields")}>
                Clery fields
              </button>
              {live && (
                <button type="button" className={reader === "ask" ? "on" : ""} onClick={() => setReader(reader === "ask" ? null : "ask")}>
                  Suggested Qs
                </button>
              )}
            </div>
          )}
        </section>

        <footer className="dc-dock-foot" aria-label="Console tools">
          <div className="dc-dock-foot-row">
            {live && (
              <button type="button" className="dc-btn sm danger" onClick={endCall} title="End the active call">End call</button>
            )}
            <button type="button" className="dc-btn sm" onClick={() => setPanelMenu((v) => !v)} aria-pressed={panelMenu}>Panels</button>
            <Link href="/officer" className="dc-btn sm">Patrol view</Link>
            {desk?.ok && deskLiveCalls.length > 0 && (
              <span className="dc-chip ai">{deskLiveCalls.length} phone live</span>
            )}
          </div>
        </footer>
      </aside>

      {reader && incident && (
        <aside className="dc-rail" aria-label={
          reader === "transcript" ? "Transcript"
            : reader === "fields" ? "Clery fields"
              : "Suggested questions"
        }>
          <header className="dc-rail-head">
            <h2>
              {reader === "transcript" ? "Transcript"
                : reader === "fields" ? "Clery fields"
                  : "Suggested questions"}
            </h2>
            <button type="button" className="dc-btn sm ghost" onClick={() => setReader(null)} aria-label="Close">✕</button>
          </header>
          <div className="dc-rail-body">
            {reader === "transcript" && <Transcript incident={incident} />}
            {reader === "fields" && (
              <>
                <p className="dc-rail-hint">Clery Act / weekly file fields — not sent to patrol.</p>
                <Fields incident={incident} readOnly={callTone(incident, assignedIds) === "done"} />
              </>
            )}
            {reader === "ask" && live && <AskNext incident={open} geminiQuestions={mode === "gemini" ? geminiQuestions : []} />}
            {reader === "ask" && !live && <p className="dc-empty">Suggested questions only while the call is live.</p>}
          </div>
        </aside>
      )}

      {panels.roster && (
        <aside className="dc-dock-right" aria-label="Roster">
          <header className="dc-panel-head"><h2>Officers</h2></header>
          <div className="dc-panel-body dc-scroll">
            <p className="dc-roster-group">In the field</p>
            <ul className="dc-roster">
              {state.officers
                .filter((o) => !(/HQ/i.test(o.locationLabel) && o.status === "available"))
                .sort((a, b) => {
                  const rank = { responding: 0, on_scene: 1, busy: 2, available: 3 };
                  return rank[a.status] - rank[b.status] || a.callsign.localeCompare(b.callsign);
                })
                .map((o) => (
                  <li key={o.id}>
                    <button type="button" className={selectedOfficerId === o.id ? "on" : ""} onClick={() => setSelectedOfficerId(o.id)}>
                      <span className="av" style={{ borderColor: `var(${o.status === "available" ? "--available" : o.status === "busy" ? "--busy" : "--committed"})` }}>
                        <MiniAvatar avatar={o.avatar ?? { skin: "#E9C9A8", hair: "#2A1A12", hat: "#1A2234" }} />
                      </span>
                      <span>
                        <b>{o.callsign}</b>
                        <small>
                          {STATUS_LABEL[o.status]}
                          {o.status === "busy" ? ` · ${formatEta(freeInFor(o))} left` : ""}
                          {o.busyWith ? ` · ${o.busyWith}` : ""}
                        </small>
                      </span>
                    </button>
                  </li>
                ))}
            </ul>
            <p className="dc-roster-group" style={{ marginTop: 14 }}>
              {atHq.length} free at HQ
            </p>
            <ul className="dc-roster">
              {atHq
                .sort((a, b) => a.callsign.localeCompare(b.callsign))
                .map((o) => (
                  <li key={o.id}>
                    <button type="button" className={selectedOfficerId === o.id ? "on" : ""} onClick={() => setSelectedOfficerId(o.id)}>
                      <span className="av" style={{ borderColor: "var(--available)" }}>
                        <MiniAvatar avatar={o.avatar ?? { skin: "#E9C9A8", hair: "#2A1A12", hat: "#1A2234" }} />
                      </span>
                      <span>
                        <b>{o.callsign}</b>
                        <small>Available · HQ</small>
                      </span>
                    </button>
                  </li>
                ))}
            </ul>
            {panels.tools && (
              <div style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--panel-line)" }}>
                <Link href="/officer" className="dc-btn" style={{ width: "100%", justifyContent: "center" }}>Open patrol</Link>
              </div>
            )}
          </div>
        </aside>
      )}

      {selectedOfficer && (
        <div className="dc-pop" role="dialog" aria-label={selectedOfficer.callsign}>
          <header>
            <div>
              <b>{selectedOfficer.callsign}</b>
              <small>{selectedOfficer.name} · #{selectedOfficer.badge}</small>
            </div>
            <button type="button" className="dc-btn sm ghost" onClick={() => setSelectedOfficerId(null)}>✕</button>
          </header>
          <p className="dc-pop-status" data-s={selectedOfficer.status}>
            {STATUS_LABEL[selectedOfficer.status]}
            {terminalOnline(selectedOfficer.id) ? " · GPS live" : ""}
            {selectedOfficer.locationLabel.includes("HQ") ? " · at HQ" : ""}
          </p>
          <p style={{ margin: 0, color: "var(--panel-muted)", fontSize: 12 }}>{selectedOfficer.busyWith ?? selectedOfficer.locationLabel}</p>
          {selectedIncForOfficer && (
            <p style={{ margin: "8px 0 0", fontSize: 12 }}>
              <b>Task:</b> {selectedIncForOfficer.title.split(":")[0]}
              {etaLeft != null && selectedOfficer.status === "responding" && <> · ETA {fmtClock(etaLeft * 1000)}</>}
              {selectedOfficer.status === "on_scene" && <> · on scene</>}
            </p>
          )}
          {selectedOfficer.status === "busy" && (
            <p style={{ margin: "8px 0 0", fontSize: 12 }}>
              Task left: {formatEta(freeInFor(selectedOfficer))}
              {selectedOfficer.busyWith ? ` · ${selectedOfficer.busyWith}` : ""}
            </p>
          )}
          {!selectedIncForOfficer && (selectedOfficer.status === "available" || selectedOfficer.status === "busy") && open && selectedPlan && (
            <p style={{ margin: "8px 0 0", fontSize: 12 }}>
              {selectedOfficer.status === "busy" ? `Free in ${formatEta(freeInFor(selectedOfficer))} · then ` : ""}
              ETA to case: {formatEta(selectedPlan.etaSeconds)}
            </p>
          )}
          <div className="dc-pop-acts">
            {open && !selectedOfficer.currentIncidentId && (selectedOfficer.status === "available" || selectedOfficer.status === "busy") && (
              <button type="button" className="dc-btn sm primary" onClick={() => sendOfficer(selectedOfficer)}>Assign</button>
            )}
            <Link href={`/officer?unit=${selectedOfficer.id}`} className="dc-btn sm">Terminal</Link>
          </div>
        </div>
      )}

      <div className="dc-legend-bar" aria-hidden="true">
        <span className="dc-leg-group">Calls</span>
        <span><i className="dc-leg-call open" />Needs unit</span>
        <span><i className="dc-leg-call active" />Attending</span>
        <span><i className="dc-leg-call done" />Done</span>
        <span className="dc-leg-group">Officers</span>
        <span><i style={{ background: "var(--available)" }} />Free</span>
        <span><i style={{ background: "var(--busy)" }} />Busy</span>
        <span><i style={{ background: "var(--committed)" }} />On call</span>
      </div>

      <div className="dc-demo">
        {demoMenu && (
          <div className="dc-demo-menu" role="menu" aria-label="Demo calls">
            <h3>Play a demo call</h3>
            {SCENARIOS.map((sc) => (
              <button key={sc.id} type="button" role="menuitem" disabled={!!demoRing} onClick={() => startDemo(sc.id)}>
                <i className={`dc-demo-cat ${sc.category}`} aria-hidden />
                <span>{sc.title}</span>
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          className="dc-demo-toggle"
          aria-haspopup="menu"
          aria-expanded={demoMenu}
          onClick={() => setDemoMenu((v) => !v)}
        >
          Demos
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d={demoMenu ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6"} stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      <button
        type="button"
        className="dc-clery-fab"
        aria-label="Open weekly Clery file"
        title="Weekly Clery file"
        onClick={() => setCleryWeek(true)}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" stroke="currentColor" strokeWidth="1.75" />
          <path d="M14 3v5h5M9 13h6M9 17h6" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
        </svg>
      </button>

      {cleryWeek && (
        <CleryWeekDrawer entries={state.cleryLog ?? []} onClose={() => setCleryWeek(false)} />
      )}
    </div>
  );
}

/** Critical notes: the standard call-taking checklist (location first, then nature, caller, injuries,
 *  threats, access). Filled from the call as it happens; anything not heard yet reads "Not available". */
function CriticalNotes({ incident }: { incident: Incident }) {
  const clery = cleryGeography(incident);
  return (
    <div className="dc-notes-rail">
      <div className="dc-crit-clery" data-geo={clery.geography} title={clery.reasons[0]}>
        <span>Clery</span>
        <b>{clery.label}</b>
        <small>{clery.reasons[0]}</small>
      </div>
      {CRITICAL_SECTIONS.map((sec) => (
        <section key={sec.title} className="dc-crit-sec">
          <h4>{sec.title}</h4>
          <dl className="dc-crit">
            {sec.keys.map((k) => {
              const v = incident.fields[k]?.value;
              return (
                <div key={k} className={v ? "has" : "na"}>
                  <dt>{FIELD_LABELS[k]}</dt>
                  <dd>{v || "Not available"}</dd>
                </div>
              );
            })}
          </dl>
        </section>
      ))}
    </div>
  );
}

function MiniAvatar({ avatar }: { avatar: OfficerAvatar }) {
  return (
    <svg width="22" height="22" viewBox="0 0 30 30" aria-hidden="true">
      <circle cx="15" cy="15" r="15" fill="#12161e" />
      <circle cx="15" cy="14" r="7" fill={avatar.skin} />
      <path d="M8 11 Q15 4 22 11 L22 13 L8 13 Z" fill={avatar.hair} />
    </svg>
  );
}

function Transcript({ incident }: { incident: Incident | null }) {
  const end = useRef<HTMLLIElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [incident?.transcript.length]);
  if (!incident) return <p className="dc-empty">No call selected.</p>;
  return (
    <ol className="dc-transcript">
      {incident.transcript.map((s) => (
        <li key={s.id}>
          <div className={`dc-who ${s.speaker}`}>{s.speaker === "caller" ? "Caller" : "Dispatcher"}<time>00:{String(s.t).padStart(2, "0")}</time></div>
          <p>{s.text}</p>
        </li>
      ))}
      <li ref={end} />
    </ol>
  );
}

function AskNext({ incident, geminiQuestions }: { incident: Incident | null; geminiQuestions: string[] }) {
  if (!incident) return <p className="dc-empty">Select an active call.</p>;
  const openQs = incident.questions.filter((q) => q.state === "open" && incident.fields[q.fieldKey].status === "unknown");
  return (
    <div>
      <ul className="dc-questions">
        {openQs.map((q) => (
          <li key={q.id}>
            <span>{q.text}</span>
            <button type="button" className="dc-btn sm ghost" style={{ boxShadow: "none" }}
              onClick={() => act({ type: "SET_QUESTION", at: Date.now(), incidentId: incident.id, questionId: q.id, state: "answered" })}>✓</button>
          </li>
        ))}
        {openQs.length === 0 && <li><span style={{ color: "var(--panel-faint)" }}>Checklist clear.</span></li>}
      </ul>
      {geminiQuestions.length > 0 && <div className="dc-gq">{geminiQuestions.map((q) => <div key={q}>• {q}</div>)}</div>}
    </div>
  );
}

function PriorityBlock({ incident, proposed, pending, onPick, onConfirm, onCancel }: {
  incident: Incident;
  proposed: Priority;
  pending: Priority | null;
  onPick: (p: Priority) => void;
  onConfirm: (p: Priority) => void;
  onCancel: () => void;
}) {
  const current = incident.priorityDecision?.priority ?? null;
  const showConfirm = pending != null && pending !== current;
  return (
    <div className="dc-prio-block">
      <div className="dc-sev-label">Severity</div>
      <div className="dc-prio" role="group" aria-label="Case severity">
        {([1, 2, 3, 4] as Priority[]).map((p) => {
          const isSuggested = current == null && p === proposed;
          const isCurrent = current === p;
          const isPending = pending === p && pending !== current;
          return (
            <button
              key={p}
              type="button"
              className={[isSuggested ? "suggested" : "", isPending ? "pending" : ""].filter(Boolean).join(" ") || undefined}
              aria-pressed={isCurrent}
              data-p={p}
              onClick={() => onPick(p)}
              title={isCurrent ? `Current P${p} — pick another to change` : isSuggested ? `Suggested P${p}` : `Set P${p}`}
            >
              {isSuggested ? `Suggested P${p}` : `P${p}`}
            </button>
          );
        })}
      </div>
      {showConfirm && (
        <div className="dc-prio-confirm">
          <span>{current != null ? "Change to" : "Confirm"} <b>P{pending}</b>{pending === proposed ? " (suggested)" : ""}?</span>
          <button type="button" className="dc-btn sm primary" onClick={() => onConfirm(pending)}>Confirm</button>
          <button type="button" className="dc-btn sm ghost" onClick={onCancel}>Not now</button>
        </div>
      )}
      {current != null && !showConfirm && (
        <span className="dc-sev-set">
          {incident.priorityDecision?.auto ? `Auto-graded P${current} · pick another level to change` : `Set by dispatcher · P${current}`}
        </span>
      )}
      {current == null && !showConfirm && <span className="dc-sev-set">Grades itself once the caller speaks</span>}
    </div>
  );
}

function Fields({ incident, readOnly }: { incident: Incident; readOnly: boolean }) {
  const sections = SECTIONS.map((sec) => ({
    ...sec,
    keys: sec.keys.filter((k) => !!incident.fields[k].value),
  })).filter((sec) => sec.keys.length > 0);

  if (sections.length === 0) {
    return <p className="dc-empty">No fields captured on this call yet.</p>;
  }

  return (
    <div className="dc-fields">
      {sections.map((sec) => (
        <div key={sec.title}>
          <h3>{sec.title}</h3>
          {sec.keys.map((k) => <FieldRow key={k} incident={incident} k={k} readOnly={readOnly} />)}
        </div>
      ))}
    </div>
  );
}

function FieldRow({ incident, k, readOnly }: { incident: Incident; k: FieldKey; readOnly: boolean }) {
  const f = incident.fields[k];
  const [showEv, setShowEv] = useState(false);
  const ev = f.evidenceSegmentId ? incident.transcript.find((s) => s.id === f.evidenceSegmentId) : null;
  if (!f.value) return null;
  void readOnly;
  return (
    <div className="dc-field">
      <span className="k">{FIELD_LABELS[k]}</span>
      <div className="dc-field-main">
        <button type="button" className={`v${ev ? " has-ev" : ""}`} disabled={!ev}
          onClick={() => { if (ev) setShowEv((v) => !v); }}>
          {f.value}
        </button>
        {showEv && ev && <p className="dc-evidence">“{ev.text}”</p>}
      </div>
      <span className={`dc-badge ${f.status}`}>{f.status === "confirmed" ? "OK" : f.status === "unverified" ? "Heard" : "?"}</span>
    </div>
  );
}

function CleryWeekDrawer({ entries, onClose }: {
  entries: {
    id: string; incidentNumber: string; title: string; at: number; category: string;
    reportable: boolean; geographyLabel: string; nibrs: string; location: string;
    timelyWarning: boolean; dailyLog: boolean; note: string | null;
  }[];
  onClose: () => void;
}) {
  const sorted = [...entries].sort((a, b) => b.at - a.at);
  return (
    <div className="dc-clery-overlay" role="dialog" aria-label="Weekly Clery file">
      <button type="button" className="dc-clery-scrim" aria-label="Close weekly Clery file" onClick={onClose} />
      <aside className="dc-clery-drawer">
        <header>
          <div>
            <h2>Weekly Clery file</h2>
            <p>Auto-added from each call sheet · Clery Act fields for review</p>
          </div>
          <button type="button" className="dc-btn sm ghost" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <ul className="dc-week-list">
          {sorted.map((e) => (
            <li key={e.id}>
              <strong>{e.incidentNumber} · {e.title}</strong>
              <div className="dc-week-grid">
                <span>When</span><b>{fmtTime(e.at)}</b>
                <span>Location</span><b>{e.location}</b>
                <span>Category</span><b>{e.category}</b>
                <span>Clery crime?</span><b className={e.reportable ? "yes" : ""}>{e.reportable ? "Reportable" : "No"}</b>
                <span>Geography</span><b>{e.geographyLabel}</b>
                <span>NIBRS</span><b>{e.nibrs}</b>
                <span>Daily crime log</span><b>{e.dailyLog ? "Yes" : "No"}</b>
                <span>Timely warning</span><b className={e.timelyWarning ? "warn" : ""}>{e.timelyWarning ? "Consider" : "No"}</b>
              </div>
              {e.note && <small className="dc-week-note">{e.note}</small>}
            </li>
          ))}
          {sorted.length === 0 && <li><small>No Clery details yet — they appear when a call ends.</small></li>}
        </ul>
      </aside>
    </div>
  );
}
