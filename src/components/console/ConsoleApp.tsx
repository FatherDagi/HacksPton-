"use client";
// /console: the combined dispatch console. Same store, scenarios, Gemini extraction and officer
// sync as /dispatch, with a real campus map, team recommendations, live trips, light/dark mode,
// keyboard shortcuts and a phone layout. The dispatcher approves every dispatch.
import "./console.css";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { assessConsole } from "@/lib/console/assess";
import { along, DEMO_TRIP_MS, estimate, fetchRoute, remaining, type RoutePlan } from "@/lib/console/routing";
import { pickTeam, teamNeeds, type Candidate } from "@/lib/console/team";
import type { ExtractError, ExtractResponse } from "@/lib/extraction";
import { FIELD_LABELS, SECTIONS } from "@/lib/fields";
import { URGENCY_LABEL } from "@/lib/priority";
import { formatEta, formatMiles } from "@/lib/recommend";
import { scenarioById } from "@/lib/scenarios";
import { act, newId, serverToLocal, stamp, useAppState, useTerminals } from "@/lib/store";
import type { FieldKey, Incident, IncidentEvent, LatLng, Officer, Priority } from "@/lib/types";
import { History, ListTodo, MessageSquareText, X } from "lucide-react";
import { fmtClock, fmtTime } from "../ui";
import type { ConsoleRoute } from "./ConsoleMap";
import { OfficerUpdates } from "./OfficerUpdates";
import { categoryFrom, deskAnswered, deskIncidentId, deskSegments, matchBuilding, type DeskCall } from "@/lib/deskBridge";

/** Pull-out tabs on the far left of the map. */
type DrawerTab = "transcript" | "questions" | "log";
const DRAWER_TABS: { id: DrawerTab; label: string; title: string; Icon: typeof History }[] = [
  { id: "transcript", label: "Transcript", title: "Live transcript", Icon: MessageSquareText },
  { id: "questions", label: "Questions", title: "AI questions", Icon: ListTodo },
  { id: "log", label: "Activity", title: "AI and dispatcher log", Icon: History },
];

const ConsoleMap = dynamic(() => import("./ConsoleMap"), { ssr: false, loading: () => <div className="dc-map"><p className="dc-empty">Loading map…</p></div> });

/** Short labels and the danger level each demo call reaches. */
const DEMO: Record<string, { label: string; p: Priority }> = {
  "police-frist": { label: "Knife fight", p: 1 },
  "medical-whitman": { label: "Collapsed student", p: 1 },
  "traffic-washington": { label: "Bike crash (escalates)", p: 1 },
  "fire-equad": { label: "Lab smoke", p: 1 },
  "theft-firestone": { label: "Bike theft", p: 3 },
  "lockout-whitman": { label: "Locked out", p: 4 },
};
const ORDER = ["police-frist", "traffic-washington", "medical-whitman", "fire-equad", "theft-firestone", "lockout-whitman"];
const STATUS_LABEL = { available: "Available", busy: "Busy", responding: "Responding", on_scene: "On scene" } as const;
const STATUS_VAR = { available: "var(--available)", busy: "var(--busy)", responding: "var(--sent)", on_scene: "var(--onscene)" } as const;

type Mode = "gemini" | "prerecorded";
interface Trip { route: LatLng[]; t0: number; eta: number; k: number; next: number; incidentId: string }

function applyPrerecorded(inc: Incident, from: number, to: number) {
  const sc = scenarioById(inc.scenarioId);
  if (!sc) return;
  const updates = sc.segments.slice(from, to).flatMap((seg) => (seg.updates ?? []).map((u) => ({ ...u, evidenceSegmentId: seg.id })));
  if (updates.length) act({ type: "APPLY_AI_UPDATES", at: Date.now(), incidentId: inc.id, updates, source: "demo" });
}

export function ConsoleApp({ fontClass }: { fontClass: string }) {
  const state = useAppState();
  const terminals = useTerminals();

  // ---------- incident tabs: every open incident has a tab; each screen picks its own ----------
  const [viewId, setViewId] = useState<string | null>(null);
  const openIncidents = useMemo(
    () => state.incidents.filter((i) => i.status !== "closed").sort((a, b) => a.createdAt - b.createdAt),
    [state.incidents],
  );
  const incident =
    state.incidents.find((i) => i.id === viewId && i.status !== "closed") ??
    state.incidents.find((i) => i.id === state.activeIncidentId) ??
    openIncidents[openIncidents.length - 1] ??
    null;
  const open = incident && incident.status !== "closed" ? incident : null;
  const scenario = incident ? scenarioById(incident.scenarioId) : null;
  const live = !!incident && !!incident.callStartedAt && !incident.callEndedAt;

  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [now, setNow] = useState<number | null>(null);
  const [geminiReady, setGeminiReady] = useState<boolean | null>(null);
  const [mode, setMode] = useState<Mode>("prerecorded");
  const [aiBusy, setAiBusy] = useState(false);
  const [geminiQs, setGeminiQs] = useState<Record<string, string[]>>({});
  const geminiQuestions = (incident && geminiQs[incident.id]) || [];
  const [plans, setPlans] = useState<Record<string, RoutePlan>>({});
  const [trips, setTrips] = useState<Record<string, Trip>>({});
  const [dispatchRoutes, setDispatchRoutes] = useState<Record<string, LatLng[]>>({});
  const [flash, setFlash] = useState(0);
  // Per-incident request ordering, so an old Gemini answer never overwrites a newer one.
  const seqRef = useRef<Record<string, number>>({});
  const appliedSeqRef = useRef<Record<string, number>>({});

  // Pull-out drawers over the map: all closed by default; badges count what arrived since last viewed.
  const [drawer, setDrawer] = useState<DrawerTab | null>(null);
  const [seen, setSeen] = useState({ transcript: 0, log: 0 });

  // ---------- setup: theme, clock, AI availability ----------
  useEffect(() => {
    const t = setTimeout(() => {
      try { if (localStorage.getItem("dc-theme") === "light") setTheme("light"); } catch { /* storage blocked: stay dark */ }
      setNow(Date.now());
    }, 0);
    const clock = setInterval(() => setNow(Date.now()), 500);
    fetch("/api/extract").then((r) => r.json()).then((j: { geminiConfigured: boolean }) => {
      setGeminiReady(j.geminiConfigured);
      if (j.geminiConfigured) setMode("gemini");
    }).catch(() => setGeminiReady(false));
    return () => { clearTimeout(t); clearInterval(clock); };
  }, []);
  const toggleTheme = useCallback(() => {
    setTheme((t) => {
      const next = t === "dark" ? "light" : "dark";
      try { localStorage.setItem("dc-theme", next); } catch { /* not remembered */ }
      return next;
    });
  }, []);

  // ---------- call playback (same flow as /dispatch) ----------
  const runGemini = useCallback(async (inc: Incident, transcript: Incident["transcript"]) => {
    const seq = (seqRef.current[inc.id] = (seqRef.current[inc.id] ?? 0) + 1);
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
      if (seq < (appliedSeqRef.current[inc.id] ?? 0)) return;
      appliedSeqRef.current[inc.id] = seq;
      if (j.updates.length) act({ type: "APPLY_AI_UPDATES", at: Date.now(), incidentId: inc.id, updates: j.updates, source: "ai" });
      setGeminiQs((p) => ({ ...p, [inc.id]: j.suggestedQuestions }));
    } catch (err) {
      act({ type: "LOG", at: Date.now(), incidentId: inc.id, actor: "system", eventType: "ai_fallback", message: `Gemini unavailable (${err instanceof Error ? err.message : "error"}). Switched to prerecorded extraction.` });
      setMode("prerecorded");
      setGeminiQs((p) => ({ ...p, [inc.id]: [] }));
      applyPrerecorded(inc, 0, transcript.length);
    } finally {
      if (seq === seqRef.current[inc.id]) setAiBusy(false);
    }
  }, []);

  /** Reveal the next scripted line of one demo incident (any tab, not only the one on screen). */
  const revealFor = useCallback((inc: Incident) => {
    const sc = scenarioById(inc.scenarioId);
    if (!sc || inc.revealed >= sc.segments.length) return;
    const idx = inc.revealed;
    const seg = sc.segments[idx];
    act({ type: "REVEAL_SEGMENT", at: Date.now(), incidentId: inc.id });
    if (mode === "prerecorded") applyPrerecorded(inc, idx, idx + 1);
    else if (seg.speaker === "caller") {
      const { updates: _u, ...plain } = seg;
      void _u;
      runGemini(inc, [...inc.transcript, plain]);
    }
  }, [mode, runGemini]);
  const revealNext = useCallback(() => { if (incident) revealFor(incident); }, [incident, revealFor]);

  // Scripted calls keep playing in the background while you look at another tab.
  const nextReveal = (() => {
    let best: { inc: Incident; due: number } | null = null;
    for (const inc of openIncidents) {
      const sc = scenarioById(inc.scenarioId);
      if (!sc || !inc.callStartedAt || inc.callEndedAt) continue;
      const seg = sc.segments[inc.revealed];
      if (!seg) continue;
      const due = inc.callStartedAt + seg.t * 1000;
      if (!best || due < best.due) best = { inc, due };
    }
    return best;
  })();
  useEffect(() => {
    if (!nextReveal || now === null) return;
    const { inc, due } = nextReveal;
    const t = setTimeout(() => revealFor(inc), Math.max(0, due - Date.now()));
    return () => clearTimeout(t);
  }, [nextReveal, now, revealFor]);

  /** A new demo call opens in its own tab; other incidents stay open in theirs. */
  const startDemo = useCallback((id: string) => {
    const at = Date.now();
    const incidentId = newId("inc");
    setMode(geminiReady ? "gemini" : "prerecorded");
    act({ type: "START_CALL", at, incidentId, number: `INC-${String(Math.floor(at / 1000) % 100000).padStart(5, "0")}`, scenarioId: id });
    setViewId(incidentId);
  }, [geminiReady]);

  // ---------- live bridge to the station desk (station-desk/, real calls translated to English) ----------
  const [desk, setDesk] = useState<{ ok: boolean; calls: DeskCall[] } | null>(null);
  useEffect(() => {
    let alive = true;
    let t: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const j = (await (await fetch("/api/desk", { cache: "no-store" })).json()) as { ok: boolean; calls?: DeskCall[] };
        const next = { ok: j.ok, calls: j.calls ?? [] };
        // Keep the same object when nothing changed so polling doesn't re-render the console every second.
        if (alive) setDesk((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      } catch {
        if (alive) setDesk((prev) => (prev && !prev.ok && prev.calls.length === 0 ? prev : { ok: false, calls: [] }));
      }
      // Poll faster while a call is live so ringing and new words show up quickly.
      if (alive) t = setTimeout(poll, lastLive.current ? 400 : 1000);
    };
    void poll();
    return () => { alive = false; clearTimeout(t); };
  }, []);
  const lastLive = useRef(false);
  const deskCalls = useMemo(() => desk?.calls ?? [], [desk]);
  const deskLiveCalls = deskCalls.filter((c) => c.status === "live");
  useEffect(() => { lastLive.current = deskLiveCalls.length > 0; }, [deskLiveCalls.length]);
  const bridgedCall = open?.deskCallId ? deskCalls.find((c) => c.id === open.deskCallId) ?? null : null;

  // Auto-take: when the dispatcher answers (or a desk practice call starts), open the call as an
  // incident and switch this screen to its tab. The id is the same on every screen, so it opens once.
  const [connected, setConnected] = useState<Record<string, number>>({});
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  const switchedTo = useRef<Set<string>>(new Set());
  /** Open a desk call as its incident (if it isn't yet) and show its tab on this screen, right now. */
  const openDeskCall = useCallback((c: DeskCall, showConnected: boolean) => {
    switchedTo.current.add(c.id);
    const at = Date.now();
    const incidentId = deskIncidentId(c.id);
    if (!state.incidents.some((i) => i.id === incidentId)) {
      act({ type: "START_LIVE_CALL", at, incidentId, number: `INC-${String(Math.floor(at / 1000) % 100000).padStart(5, "0")}`, deskCallId: c.id, callerLanguage: c.callerLanguage });
    }
    setMode(geminiReady ? "gemini" : "prerecorded");
    setViewId(incidentId);
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
  // Ringing = live phone call nobody has answered and the dispatcher hasn't opened by clicking the alert.
  const ringing = deskLiveCalls.filter((c) => !deskAnswered(c) && !opened.has(c.id));

  // Mirror every live desk call's transcript into its incident (not only the tab on screen); run Gemini
  // once the caller has paused; end the console call when the desk call ends.
  const extractTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const extractedText = useRef<Record<string, string>>({});
  useEffect(() => {
    for (const inc of openIncidents) {
      if (!inc.deskCallId) continue;
      const call = deskCalls.find((c) => c.id === inc.deskCallId);
      if (!call) continue;
      const segments = deskSegments(call);
      // Only send when the words changed: the store rebuilds objects on every action, so an
      // unconditional act here would re-run this effect forever.
      if (JSON.stringify(segments) !== JSON.stringify(inc.transcript)) {
        act({ type: "SET_DESK_TRANSCRIPT", at: Date.now(), incidentId: inc.id, transcript: segments });
      }
      const callerText = segments.filter((x) => x.speaker === "caller").map((x) => x.text).join(" ");
      if (mode === "gemini" && callerText && callerText !== extractedText.current[inc.id]) {
        clearTimeout(extractTimers.current[inc.id]);
        extractTimers.current[inc.id] = setTimeout(() => {
          extractedText.current[inc.id] = callerText;
          runGemini({ ...inc, transcript: segments }, segments);
        }, 1200);
      }
      if (call.status !== "live" && inc.callStartedAt && !inc.callEndedAt) act({ type: "END_CALL", at: Date.now(), incidentId: inc.id });
    }
  }, [openIncidents, deskCalls, mode, runGemini]);

  // Classify and place each live call from what has been said (the dispatcher can still edit fields).
  useEffect(() => {
    for (const inc of openIncidents) {
      if (!inc.deskCallId) continue;
      const call = deskCalls.find((c) => c.id === inc.deskCallId);
      const text = [
        inc.fields.category.value, inc.fields.description.value, inc.fields.building.value, inc.fields.location_details.value,
        call?.callType, call?.location, ...inc.transcript.filter((x) => x.speaker === "caller").map((x) => x.text),
      ].filter(Boolean).join(" \n ");
      if (!text) continue;
      const at = Date.now();
      const cat = categoryFrom(text);
      if (cat && inc.category === "other") act({ type: "SET_CATEGORY", at, incidentId: inc.id, category: cat });
      if (inc.locationPending) {
        const b = matchBuilding(text);
        if (b) act({ type: "SET_LOCATION", at, incidentId: inc.id, buildingId: b });
      }
    }
  }, [openIncidents, deskCalls]);

  // Banner over the map: ringing calls, then "Connected" for a few seconds after auto-take.
  const recentlyConnected = deskLiveCalls.filter((c) => connected[c.id] && now !== null && now - connected[c.id] < 1500);

  // ---------- priority (AI proposal; dispatcher confirms or overrides) ----------
  const assessment = open ? assessConsole(open.category, open.fields) : null;
  const shownPriority: Priority | null = open ? open.priorityDecision?.priority ?? assessment!.proposed : null;

  // ---------- routes + team ----------
  const free = useMemo(
    () => (open ? state.officers.filter((o) => o.status === "available" && !open.declinedOfficerIds.includes(o.id)) : []),
    [open, state.officers],
  );
  // Includes the incident position: a live desk call starts at a placeholder and moves once the building is known.
  const planKey = (o: Officer, inc: Incident) => `${o.id}|${inc.id}|${inc.location[0].toFixed(5)},${inc.location[1].toFixed(5)}|${o.location[0].toFixed(5)},${o.location[1].toFixed(5)}`;
  useEffect(() => {
    if (!open) return;
    let alive = true;
    for (const o of free) {
      const k = planKey(o, open);
      if (plans[k]?.real) continue;
      fetchRoute(o.location, open.location, o.mode).then((p) => { if (alive) setPlans((prev) => (prev[k] === p ? prev : { ...prev, [k]: p })); });
    }
    return () => { alive = false; };
  }, [open, free, plans]);
  const planFor = useCallback((o: Officer, inc: Incident) => plans[planKey(o, inc)] ?? estimate(o.location, inc.location, o.mode), [plans]);

  const candidates: Candidate[] = open ? free.map((o) => ({ officer: o, plan: planFor(o, open) })) : [];
  const { needs, why } = open && shownPriority ? teamNeeds(open, shownPriority) : { needs: [], why: "" };
  const { team, missing } = open ? pickTeam(open, needs, candidates) : { team: [], missing: [] };
  const assignments = open ? state.assignments.filter((a) => a.incidentId === open.id && a.status === "active") : [];
  const assigned = assignments.map((a) => ({ a, o: state.officers.find((x) => x.id === a.officerId)! })).filter((x) => x.o);
  const dispatched = assigned.length > 0;
  const allOnScene = dispatched && assigned.every((x) => x.o.status === "on_scene");
  const teamIds = dispatched ? assigned.map((x) => x.o.id) : team.map((c) => c.officer.id);

  const routes: ConsoleRoute[] = (() => {
    if (!open) return [];
    if (dispatched) {
      return assigned.filter((x) => x.o.status === "responding").map(({ o }) => {
        const tr = trips[o.id];
        const planned = dispatchRoutes[o.id];
        const pts = tr ? [o.location, ...tr.route.slice(tr.next)] : planned ? remaining(planned, o.location) : [o.location, open.location];
        return { id: o.id, points: pts, foot: o.mode === "foot", kind: "assigned" as const };
      });
    }
    return team.map((c) => ({ id: c.officer.id, points: c.plan.route, foot: c.officer.mode === "foot", kind: "proposed" as const }));
  })();
  // Terminals poll 4x a second; one silent for 5 s while on a call has lost signal (crash, ambush, dead battery).
  const terminalOnline = (id: string) => !!terminals[id] && (now ?? 0) - serverToLocal(terminals[id]) < 5000;
  const lost = assigned.filter(({ o }) => terminals[o.id] && !terminalOnline(o.id)).map(({ o }) => ({ o, since: serverToLocal(terminals[o.id]) }));
  const fitKey = open ? `${open.id}|${dispatched ? "sent" : team.map((c) => c.officer.id + (c.plan.real ? "r" : "e")).join(",")}` : "";

  // ---------- trips: officers travel their routes; positions sync to the officer page ----------
  // One tick every 300 ms while trips run. Store updates happen here, never inside a state updater.
  useEffect(() => {
    if (!Object.keys(trips).length) return;
    const t = setTimeout(() => {
      const ts = Date.now();
      const next: Record<string, Trip> = {};
      for (const [id, tr] of Object.entries(trips)) {
        const k = Math.min(1, (ts - tr.t0) / DEMO_TRIP_MS);
        if (k >= 1) {
          act({ type: "OFFICER_STATUS", at: ts, officerId: id, status: "on_scene" });
          continue;
        }
        const { at, next: n } = along(tr.route, k);
        act({ type: "OFFICER_LOCATION", at: ts, officerId: id, location: at, label: "En route (GPS, simulated)" });
        next[id] = { ...tr, k, next: n };
      }
      setTrips(next);
    }, 300);
    return () => clearTimeout(t);
  }, [trips]);

  const approveTeam = () => {
    if (!open || !team.length || dispatched) return;
    const at = stamp();
    const started: Record<string, Trip> = {};
    for (const c of team) {
      act({ type: "APPROVE_ASSIGNMENT", at, incidentId: open.id, officerId: c.officer.id, assignmentId: newId("asg"), etaSeconds: c.plan.etaSeconds, route: c.plan.route });
      // A unit signed in on a patrol terminal drives itself once the officer acknowledges; others are simulated here.
      if (!terminalOnline(c.officer.id)) started[c.officer.id] = { route: c.plan.route, t0: at, eta: c.plan.etaSeconds, k: 0, next: 1, incidentId: open.id };
    }
    setTrips((p) => ({ ...p, ...started }));
    setDispatchRoutes((p) => ({ ...p, ...Object.fromEntries(team.map((c) => [c.officer.id, c.plan.route])) }));
  };
  const swapLast = () => {
    if (!open || !team.length || dispatched) return;
    act({ type: "DECLINE_UNIT", at: stamp(), incidentId: open.id, officerId: team[team.length - 1].officer.id });
  };

  // ---------- AI log: re-grades and team proposals (with an audit trail in the incident record) ----------
  const lastProposed = useRef<Record<string, Priority>>({});
  const proposedNow = assessment?.proposed ?? null;
  const reasonsNow = assessment?.reasons.join("; ") ?? "";
  const hasFacts = !!open && Object.values(open.fields).some((f) => f.value);
  useEffect(() => {
    if (!open || !proposedNow || !hasFacts) return;
    const prev = lastProposed.current[open.id];
    if (prev === proposedNow) return;
    lastProposed.current[open.id] = proposedNow;
    act({
      type: "LOG", at: Date.now(), incidentId: open.id, actor: "ai", eventType: prev ? "priority_regrade" : "priority_proposed",
      message: prev ? `Re-graded P${prev} → P${proposedNow}: ${reasonsNow}.` : `Proposed P${proposedNow}: ${reasonsNow}.`,
    });
    if (prev && proposedNow < prev) setTimeout(() => setFlash((f) => f + 1), 0);
  }, [open, proposedNow, reasonsNow, hasFacts]);

  const lastTeam = useRef<Record<string, string>>({});
  const teamSig = team.map((c) => c.officer.id).join(",");
  const teamText = team.map((c) => `${c.officer.callsign} (${formatEta(c.plan.etaSeconds)}${c.plan.real ? "" : ", est."})`).join(" + ");
  const plansSettled = team.every((c) => c.plan.real);
  useEffect(() => {
    if (!open || dispatched || !teamSig || !hasFacts || !plansSettled) return;
    if (lastTeam.current[open.id] === teamSig) return;
    const t = setTimeout(() => {
      lastTeam.current[open.id] = teamSig;
      act({ type: "LOG", at: Date.now(), incidentId: open.id, actor: "ai", eventType: "team_proposed", message: `Proposed ${teamText}. ${why} Waiting for dispatcher.` });
    }, 700);
    return () => clearTimeout(t);
  }, [open, dispatched, teamSig, teamText, why, hasFacts, plansSettled]);

  // ---------- keyboard ----------
  const [override, setOverride] = useState<{ p: Priority; reason: string } | null>(null);
  // useEffectEvent: the listener always sees the latest team/incident without re-subscribing.
  const onKey = useEffectEvent((e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || t?.closest?.("input, textarea, select")) return;
      const k = e.key.toLowerCase();
      if (k === "escape" && drawer) closeDrawer();
      else if (k === "y") approveTeam();
      else if (k === "n") swapLast();
      else if (k === "e" && live) revealNext();
      else if (k === "t") toggleTheme();
      else if (k === "c" && open && assessment && !open.priorityDecision)
        act({ type: "DECIDE_PRIORITY", at: stamp(), incidentId: open.id, priority: assessment.proposed, proposed: assessment.proposed, overrideReason: null });
      else if ("1234".includes(k) && k && open) setOverride({ p: Number(k) as Priority, reason: "" });
  });
  useEffect(() => {
    const h = (e: KeyboardEvent) => onKey(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // ---------- render ----------
  const events = open ? state.events.filter((e) => e.incidentId === open.id).slice().reverse() : [];
  const callClock = incident?.callStartedAt
    ? live && now ? fmtClock(now - incident.callStartedAt) : incident.callEndedAt ? fmtClock(incident.callEndedAt - incident.callStartedAt) : "--:--"
    : "--:--";
  const aiChip = geminiReady === null ? "Checking AI…" : mode === "gemini" ? (aiBusy ? "Gemini listening…" : "AI: Gemini") : "AI: prerecorded demo";

  const transcriptCount = incident?.transcript.length ?? 0;
  const logCount = events.filter((e) => e.type !== "transcript").length;
  const openQuestions = open ? open.questions.filter((q) => q.state === "open" && open.fields[q.fieldKey].status === "unknown").length : 0;
  const markSeen = () => setSeen({ transcript: transcriptCount, log: logCount });
  const toggleDrawer = (t: DrawerTab) => { markSeen(); setDrawer((cur) => (cur === t ? null : t)); };
  function closeDrawer() { markSeen(); setDrawer(null); }
  const badges: Record<DrawerTab, number> = {
    transcript: drawer === "transcript" ? 0 : Math.max(0, transcriptCount - seen.transcript),
    questions: openQuestions,
    log: drawer === "log" ? 0 : Math.max(0, logCount - seen.log),
  };

  return (
    <div className={`dc ${fontClass}`} data-theme={theme} data-prio={shownPriority ?? ""}>
      <header className={`dc-head${flash ? " flash" : ""}`} key={`h${flash}`}>
        <Link href="/" className="dc-brand" title="Back to the start screen">Dispatch Copilot <small>Princeton Public Safety</small></Link>
        <span className="dc-sim">Simulation only</span>
        <span className={`dc-live${live ? " on" : ""}`}><span className="dc-dot" />{live ? "Call in progress" : incident ? "Call ended" : "No call"} · {callClock}</span>
        {incident && <span style={{ color: "var(--muted)" }}>{incident.number}</span>}
        <span className={`dc-chip${mode === "gemini" ? " ai" : ""}`}>{aiChip}</span>
        <div className="dc-seg" role="group" aria-label="Demo calls">
          {ORDER.map((id) => {
            const d = DEMO[id];
            return (
              <button key={id} type="button" aria-pressed={incident?.scenarioId === id}
                onClick={() => startDemo(id)} title={`${scenarioById(id)?.title ?? id} (reaches P${d.p})`}>
                <i style={{ background: `var(--p${d.p})` }} />{d.label}
              </button>
            );
          })}
        </div>
        {/* Station desk status. Answered calls open automatically; there is no "take call" button. */}
        <span className={`dc-chip${desk?.ok ? " ai" : ""}`} title={desk?.ok ? "Answered phone calls open here automatically" : "Run npm run desk to take real phone calls"}>
          {desk === null ? "Checking desk…" : !desk.ok ? "Desk offline" : deskLiveCalls.length ? `Desk: ${deskLiveCalls.length} live call${deskLiveCalls.length > 1 ? "s" : ""}` : "Desk ready"}
        </span>
        <span className="dc-spacer" />
        {live && scenario && <button type="button" className="dc-btn" onClick={revealNext}>Next line <kbd>E</kbd></button>}
        {live && <button type="button" className="dc-btn danger" onClick={() => act({ type: "END_CALL", at: Date.now(), incidentId: incident!.id })}>End call</button>}
        {!live && open && <button type="button" className="dc-btn" onClick={() => act({ type: "CLOSE_INCIDENT", at: Date.now(), incidentId: open.id })}>Close incident</button>}
        <button type="button" className="dc-btn" onClick={toggleTheme}>{theme === "dark" ? "Light mode" : "Dark mode"}</button>
        <button type="button" className="dc-btn ghost" onClick={() => { if (confirm("Reset the demo? All simulated incidents and unit positions go back to the start.")) { setTrips({}); act({ type: "RESET" }); } }}>Reset demo</button>
        <nav className="dc-nav" aria-label="Pages">
          <Link href="/dispatch">Classic view</Link>
          <Link href="/incidents">Incidents</Link>
        </nav>
      </header>

      {/* One tab per open incident; this screen chooses which one it shows. */}
      {openIncidents.length > 0 && (
        <nav className="dc-tabs" aria-label="Open incidents">
          {openIncidents.map((inc) => {
            const p = inc.priorityDecision?.priority ?? assessConsole(inc.category, inc.fields).proposed;
            const onCall = !!inc.callStartedAt && !inc.callEndedAt;
            return (
              <button key={inc.id} type="button" aria-pressed={inc.id === incident?.id} onClick={() => setViewId(inc.id)}
                title={`${inc.number} · ${inc.title}`}>
                <i style={{ background: `var(--p${p})` }} />
                <b>{inc.number}</b>
                <span>{inc.deskCallId ? "Live call" : DEMO[inc.scenarioId ?? ""]?.label ?? inc.category}</span>
                {onCall && <em className="dc-tab-live">● on call</em>}
              </button>
            );
          })}
        </nav>
      )}

      <div className="dc-cols">
        {/* CENTER: what to do next, with the map as the main workspace */}
        <section className="dc-col dc-center" aria-label="Recommendation and map">
          <div className="dc-bar" data-mode={allOnScene ? "onscene" : dispatched ? "sent" : ""}>
            <div className="dc-bar-text">
              {!open ? (
                <>
                  <span className="dc-kicker">Pick a demo call above to start.</span>
                  <span className="dc-team">The AI suggests who to send. You approve every dispatch.</span>
                </>
              ) : dispatched ? (
                <>
                  <span className="dc-kicker" aria-live="polite">{allOnScene ? "On scene" : "Sent to patrol terminals"}</span>
                  <span className="dc-team">
                    {assigned.map(({ o, a }) => {
                      const tr = trips[o.id];
                      const left = tr ? Math.round((1 - tr.k) * tr.eta) : 0;
                      return (
                        <span key={o.id}>
                          <span style={{ color: STATUS_VAR[o.status] }}>●</span>{o.callsign}
                          <small>{o.status === "on_scene" ? "on scene" : tr ? `ETA ${fmtClock(left * 1000)}` : a.acknowledgedAt ? "en route" : "waiting for officer to acknowledge"}{tr && a.acknowledgedAt ? " · acknowledged" : ""}</small>
                        </span>
                      );
                    })}
                  </span>
                </>
              ) : (
                <>
                  <span className="dc-kicker" aria-live="polite">
                    AI suggests {team.length + missing.length === 1 ? "1 unit" : `${team.length + missing.length} units`} · {why}
                  </span>
                  <span className="dc-team">
                    {team.map((c) => (
                      <span key={c.officer.id}>
                        {c.officer.callsign}
                        <small>{c.officer.type === "police" ? "" : `${c.officer.type.toUpperCase()} · `}{formatEta(c.plan.etaSeconds)} {c.officer.mode === "foot" ? "on foot" : "by car"}{c.plan.avoidsClosure ? " · passes a closure" : ""}</small>
                      </span>
                    ))}
                    {missing.length > 0 && <small style={{ color: "var(--warn)" }}>{missing.length} more needed, none free: request mutual aid</small>}
                  </span>
                </>
              )}
            </div>
            <div className="dc-bar-actions">
              {open && !dispatched && team.length > 0 && (
                <>
                  <button type="button" className="dc-btn lg primary" onClick={approveTeam}>Send {team.length > 1 ? `${team.length} units` : team[0].officer.callsign} <kbd>Y</kbd></button>
                  <button type="button" className="dc-btn lg" onClick={swapLast}>{team.length > 1 ? "Swap last" : "Next option"} <kbd>N</kbd></button>
                </>
              )}
              {open && !dispatched && team.length === 0 && open.declinedOfficerIds.length > 0 && (
                <button type="button" className="dc-btn lg" onClick={() => act({ type: "RESET_DECLINES", at: Date.now(), incidentId: open.id })}>Reconsider skipped units</button>
              )}
            </div>
          </div>

          {lost.map(({ o, since }) => (
            <div key={o.id} className="dc-lost" role="alert">
              <b>{o.callsign} terminal lost signal</b> {now ? fmtClock(Math.max(0, now - since)) : ""} ago. Last known position and route trail are on the map. Check on the unit.
            </div>
          ))}
          <div className="dc-maprow">
            <nav className="dc-rail" aria-label="Call tools">
              {DRAWER_TABS.map(({ id, label, Icon }) => (
                <button key={id} type="button" aria-pressed={drawer === id} aria-controls="dc-drawer" onClick={() => toggleDrawer(id)}>
                  <Icon aria-hidden />
                  {label}
                  {badges[id] > 0 && <span className="dc-railbadge">{badges[id]}</span>}
                </button>
              ))}
            </nav>
            <div className="dc-mapwrap">
              {/* Incoming phone calls: large banner while ringing, then "Connected" once auto-taken. */}
              {(ringing.length > 0 || recentlyConnected.length > 0) && (
                <div className="dc-callbanners" role="alert" aria-live="assertive">
                  {ringing.map((c) => (
                    // Clicking opens the call's incident tab immediately (no waiting for the answer).
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
              {/* The map never resizes or remounts when a drawer opens. */}
              <ConsoleMap officers={state.officers} incident={open} priority={shownPriority} routes={routes} teamIds={teamIds} theme={theme} fitKey={fitKey} lostIds={lost.map((x) => x.o.id)} />
              <aside id="dc-drawer" className={`dc-drawer${drawer ? " open" : ""}`} aria-hidden={!drawer} inert={!drawer}
                aria-label={DRAWER_TABS.find((t) => t.id === drawer)?.title ?? "Drawer"}>
                <h2 className="dc-strip">
                  <span>{DRAWER_TABS.find((t) => t.id === drawer)?.title}{" "}
                    {drawer === "transcript" && live && <small>Listening…</small>}
                    {drawer === "questions" && <small>{mode === "gemini" ? "checklist + Gemini" : "checklist"}</small>}
                    {drawer === "log" && <small>audit trail</small>}
                  </span>
                  <button type="button" className="dc-btn sm ghost" aria-label="Close drawer" onClick={closeDrawer}><X size={15} aria-hidden /></button>
                </h2>
                {/* Every pane stays mounted so live updates never pause; only the selected one shows. */}
                <div className="dc-drawer-body">
                  <div className={`dc-drawer-pane${drawer === "transcript" ? " on" : ""}`}><Transcript incident={incident} partial={live && bridgedCall?.partial ? bridgedCall.partial : null} /></div>
                  <div className={`dc-drawer-pane${drawer === "questions" ? " on" : ""}`}><AskNext incident={open} geminiQuestions={mode === "gemini" ? geminiQuestions : []} /></div>
                  <div className={`dc-drawer-pane${drawer === "log" ? " on" : ""}`}><Log events={events} /></div>
                </div>
              </aside>
            </div>
          </div>

          <div className="dc-units">
            <h2 className="dc-strip">
              Units
              <span className="dc-legend">
                {(["available", "responding", "on_scene", "busy"] as const).map((s) => (
                  <span key={s}><i className="dc-sq" style={{ background: STATUS_VAR[s] }} />{STATUS_LABEL[s]}</span>
                ))}
                <span>Positions simulated</span>
              </span>
            </h2>
            <div className="dc-scroll" style={{ overflowX: "auto" }}>
              <UnitsTable officers={state.officers} incident={open} planFor={planFor} teamIds={teamIds} />
            </div>
          </div>
        </section>

        {/* RIGHT: incident details */}
        <aside className="dc-col dc-right" aria-label="Incident details">
          <h2 className="dc-strip">Incident details {open && <small>{open.title}</small>}</h2>
          {open && assessment ? (
            <>
              <PriorityBlock incident={open} proposed={assessment.proposed} urgency={URGENCY_LABEL[assessment.urgency]} reasons={assessment.reasons}
                override={override} setOverride={setOverride} />
              {dispatched && <OfficerUpdates assigned={assigned} updates={state.officerUpdates ?? []} />}
              <Fields incident={open} />
            </>
          ) : (
            <p className="dc-empty">Fields fill in automatically as the call is transcribed.</p>
          )}
        </aside>
      </div>
    </div>
  );
}

// ---------------- pieces ----------------
function Transcript({ incident, partial }: { incident: Incident | null; partial?: { speaker: string; text: string } | null }) {
  // Scroll only this list (not the page) so it keeps following the call while its drawer is hidden.
  const list = useRef<HTMLOListElement>(null);
  const end = useRef<HTMLLIElement>(null);
  const n = incident?.transcript.length ?? 0;
  useEffect(() => { if (list.current) list.current.scrollTop = list.current.scrollHeight; }, [n, partial?.text]);
  if (!incident) return <p className="dc-empty">Choose a demo call, or answer a phone call, to start.</p>;
  // Words still being spoken: shown at the end of the current line when the same person is talking
  // (the desk only starts a new line after a 1 s pause or a speaker change).
  const last = incident.transcript[incident.transcript.length - 1];
  const partialSpeaker = partial ? (/caller/i.test(partial.speaker) ? "caller" : "dispatcher") : null;
  const inline = !!partial && !!last && last.speaker === partialSpeaker;
  return (
    <ol ref={list} className="dc-transcript dc-scroll" aria-live="polite">
      {incident.transcript.map((s) => {
        const parts = s.highlight && s.text.includes(s.highlight) ? s.text.split(s.highlight) : null;
        return (
          <li key={s.id}>
            <div className={`dc-who ${s.speaker}`}>{s.speaker === "caller" ? "Caller" : "Dispatcher"}<time>{fmtClock(s.t * 1000)}</time></div>
            <p>
              {parts ? <>{parts[0]}<mark>{s.highlight}</mark>{parts[1]}</> : s.text}
              {inline && s === last && <i style={{ opacity: 0.65 }}> {partial!.text}…</i>}
            </p>
          </li>
        );
      })}
      {partial && !inline && (
        <li style={{ opacity: 0.7 }}>
          <div className={`dc-who ${/caller/i.test(partial.speaker) ? "caller" : "dispatcher"}`}>{/caller/i.test(partial.speaker) ? "Caller" : "Dispatcher"}<time>live</time></div>
          <p><i>{partial.text}…</i></p>
        </li>
      )}
      <li ref={end} />
    </ol>
  );
}

function AskNext({ incident, geminiQuestions }: { incident: Incident | null; geminiQuestions: string[] }) {
  if (!incident) return <p className="dc-empty">Questions appear once a call starts.</p>;
  const openQs = incident.questions.filter((q) => q.state === "open" && incident.fields[q.fieldKey].status === "unknown");
  return (
    <div className="dc-scroll">
      <ul className="dc-questions">
        {openQs.map((q) => (
          <li key={q.id}>
            <span>{q.text}</span>
            <button type="button" className="dc-btn sm ghost" aria-label={`Answered: ${q.text}`} title="Answered"
              onClick={() => act({ type: "SET_QUESTION", at: Date.now(), incidentId: incident.id, questionId: q.id, state: "answered" })}>✓</button>
            <button type="button" className="dc-btn sm ghost" aria-label={`Dismiss: ${q.text}`} title="Dismiss"
              onClick={() => act({ type: "SET_QUESTION", at: Date.now(), incidentId: incident.id, questionId: q.id, state: "dismissed" })}>✕</button>
          </li>
        ))}
        {openQs.length === 0 && <li><span style={{ color: "var(--faint)" }}>Checklist complete.</span></li>}
      </ul>
      {geminiQuestions.length > 0 && (
        <div className="dc-gq"><b>Gemini suggests</b>{geminiQuestions.map((q) => <div key={q}>• {q}</div>)}</div>
      )}
    </div>
  );
}

function Log({ events }: { events: IncidentEvent[] }) {
  if (!events.length) return <p className="dc-empty">Every AI step and dispatcher decision is recorded here.</p>;
  // "Demo" = prerecorded extraction; never labelled as AI output.
  const who = { ai: "AI", demo: "Demo", dispatcher: "Dispatcher", officer: "Officer", system: "System" } as const;
  return (
    <ol className="dc-log dc-scroll">
      {events.filter((e) => e.type !== "transcript").map((e) => (
        <li key={e.id} className={e.type === "priority_regrade" ? "alert" : ""}>
          <time>{fmtTime(e.at).replace(/\s?[AP]M$/i, "")}</time>
          <span className={`a-${e.actor}`}>{who[e.actor]}</span>
          <span>{e.message}</span>
        </li>
      ))}
    </ol>
  );
}

function UnitsTable({ officers, incident, planFor, teamIds }: {
  officers: Officer[]; incident: Incident | null; planFor: (o: Officer, i: Incident) => RoutePlan; teamIds: string[];
}) {
  const rows = officers.map((o) => ({ o, plan: incident ? planFor(o, incident) : null }))
    .sort((a, b) => (a.plan?.etaSeconds ?? 0) - (b.plan?.etaSeconds ?? 0));
  return (
    <div className="dc-table" role="table" aria-label="Units">
      <div className="dc-row head" role="row">
        <span role="columnheader">Unit</span><span role="columnheader">Type</span><span role="columnheader">Status</span>
        <span role="columnheader">Location</span><span role="columnheader">Route to call</span>
      </div>
      {rows.map(({ o, plan }) => (
        <div key={o.id} role="row" className={`dc-row${teamIds.includes(o.id) ? " rec" : ""}`}>
          <span role="cell"><b>{o.callsign}</b> <small>{o.name}</small></span>
          <span role="cell">{o.type === "police" ? "Police" : o.type.toUpperCase()} <small>{o.mode === "foot" ? "foot" : "car"}</small></span>
          <span role="cell" className="dc-status" style={{ color: STATUS_VAR[o.status] }}><i className="dc-sq" style={{ background: STATUS_VAR[o.status] }} />{STATUS_LABEL[o.status]}</span>
          <span role="cell" style={{ color: "var(--muted)" }}>{o.busyWith ?? o.locationLabel}</span>
          <span role="cell">{plan && o.status === "available" ? <>{formatEta(plan.etaSeconds)} · {formatMiles(plan.distanceMeters)} <small>{plan.real ? "road" : "est."}</small></> : "—"}</span>
        </div>
      ))}
    </div>
  );
}

function PriorityBlock({ incident, proposed, urgency, reasons, override, setOverride }: {
  incident: Incident; proposed: Priority; urgency: string; reasons: string[];
  override: { p: Priority; reason: string } | null; setOverride: (o: { p: Priority; reason: string } | null) => void;
}) {
  const d = incident.priorityDecision;
  const shown = d?.priority ?? proposed;
  const decide = (p: Priority, reason: string | null) => {
    act({ type: "DECIDE_PRIORITY", at: stamp(), incidentId: incident.id, priority: p, proposed, overrideReason: p === proposed ? null : reason });
    setOverride(null);
  };
  return (
    <div className="dc-prio-block">
      <div className="dc-prow">
        <span className="dc-plabel">Priority</span>
        <div className="dc-prio" role="group" aria-label="Priority">
          {([1, 2, 3, 4] as Priority[]).map((p) => (
            <button key={p} type="button" aria-pressed={shown === p} data-proposed={p === proposed}
              onClick={() => (p === proposed ? decide(p, null) : setOverride({ p, reason: "" }))}>{p}</button>
          ))}
        </div>
      </div>
      <div className="dc-prow">
        <span className="dc-plabel">Why</span>
        <div>
          <strong style={{ color: "var(--prio)" }}>{urgency}.</strong>
          <ul className="dc-reasons">{reasons.map((r) => <li key={r}>{r}</li>)}</ul>
        </div>
      </div>
      <div className="dc-decision">
        {d ? (
          <span>{d.overrideReason ? `Dispatcher set P${d.priority} (AI said P${proposed}): ${d.overrideReason}` : `Dispatcher confirmed P${d.priority}`}</span>
        ) : (
          <>
            <button type="button" className="dc-btn sm primary" onClick={() => decide(proposed, null)}>Confirm P{proposed} <kbd>C</kbd></button>
            <span style={{ color: "var(--faint)", fontSize: 12 }}>or press 1–4 to override</span>
          </>
        )}
      </div>
      {override && override.p !== proposed && (
        <form className="dc-override" onSubmit={(e) => { e.preventDefault(); if (override.reason.trim()) decide(override.p, override.reason.trim()); }}>
          <label className="sr-only" htmlFor="dc-reason">Reason for P{override.p}</label>
          <input id="dc-reason" className="dc-input" autoFocus value={override.reason} placeholder={`Why P${override.p}? (required)`}
            onChange={(e) => setOverride({ ...override, reason: e.target.value })} onKeyDown={(e) => e.key === "Escape" && setOverride(null)} />
          <button type="submit" className="dc-btn sm primary" disabled={!override.reason.trim()}>Set P{override.p}</button>
          <button type="button" className="dc-btn sm ghost" onClick={() => setOverride(null)}>Cancel</button>
        </form>
      )}
      <p className="dc-note">Transparent demo rules, not a certified dispatch protocol. The dispatcher decides.</p>
    </div>
  );
}

function Fields({ incident }: { incident: Incident }) {
  return (
    <div className="dc-fields dc-scroll">
      {SECTIONS.map((sec) => (
        <div key={sec.title}>
          <h3>{sec.title}</h3>
          {sec.keys.map((k) => <FieldRow key={k} incident={incident} k={k} />)}
        </div>
      ))}
      <p className="dc-note">Underlined values link to the words they came from. Values you confirm or edit are locked; the AI never overwrites them.</p>
    </div>
  );
}

function FieldRow({ incident, k }: { incident: Incident; k: FieldKey }) {
  const f = incident.fields[k];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [showEv, setShowEv] = useState(false);
  const ev = f.evidenceSegmentId ? incident.transcript.find((s) => s.id === f.evidenceSegmentId) : null;
  const save = () => { act({ type: "EDIT_FIELD", at: Date.now(), incidentId: incident.id, key: k, value: draft.trim(), status: "confirmed" }); setEditing(false); };
  return (
    <div className="dc-field">
      <span className="k">{FIELD_LABELS[k]}</span>
      <button type="button" className={`v${ev ? " has-ev" : ""}${f.value ? "" : " unknown"}`} disabled={!ev && !!f.value} onClick={() => (ev ? setShowEv((v) => !v) : (setDraft(""), setEditing(true)))}
        title={ev ? "Show the words this came from" : f.value ? undefined : "Type it in"}>
        {f.value ?? "Not asked yet"}{f.source === "dispatcher" && <small style={{ color: "var(--faint)" }}> (you)</small>}
      </button>
      <span className="acts">
        <span className={`dc-badge ${f.status}`}>{f.status === "confirmed" ? "Confirmed" : f.status === "unverified" ? "Heard" : "Unknown"}</span>
        {f.status === "unverified" && (
          <button type="button" className="dc-btn sm ghost" aria-label={`Confirm ${FIELD_LABELS[k]}`}
            onClick={() => act({ type: "EDIT_FIELD", at: Date.now(), incidentId: incident.id, key: k, value: f.value ?? "", status: "confirmed" })}>Confirm</button>
        )}
        <button type="button" className="dc-btn sm ghost" aria-label={`Edit ${FIELD_LABELS[k]}`} onClick={() => { setDraft(f.value ?? ""); setEditing(true); }}>✎</button>
      </span>
      {showEv && ev && <p className="dc-evidence">“{ev.text}” <small>({ev.speaker})</small></p>}
      {editing && (
        <form className="dc-edit" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <label className="sr-only" htmlFor={`dc-f-${k}`}>{FIELD_LABELS[k]}</label>
          <input id={`dc-f-${k}`} className="dc-input" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setEditing(false)} />
          <button type="submit" className="dc-btn sm primary">Save</button>
        </form>
      )}
    </div>
  );
}
