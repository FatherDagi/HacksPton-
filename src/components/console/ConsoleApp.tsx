"use client";
// /console: the combined dispatch console. Same store, scenarios, Gemini extraction and officer
// sync as /dispatch, with a real campus map, team recommendations, live trips, light/dark mode,
// keyboard shortcuts and a phone layout. The dispatcher approves every dispatch.
import "./console.css";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { assessConsole } from "@/lib/console/assess";
import { along, estimate, fetchRoute, type RoutePlan } from "@/lib/console/routing";
import { pickTeam, teamNeeds, type Candidate } from "@/lib/console/team";
import type { ExtractError, ExtractResponse } from "@/lib/extraction";
import { FIELD_LABELS, SECTIONS } from "@/lib/fields";
import { URGENCY_LABEL } from "@/lib/priority";
import { formatEta, formatMiles } from "@/lib/recommend";
import { scenarioById } from "@/lib/scenarios";
import { act, newId, stamp, useAppState } from "@/lib/store";
import type { FieldKey, Incident, IncidentEvent, LatLng, Officer, Priority } from "@/lib/types";
import { fmtClock, fmtTime } from "../ui";
import type { ConsoleRoute } from "./ConsoleMap";

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
const TRIP_MS = 12_000; // the demo plays each trip in 12 s; ETAs shown are the real estimates

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
  const incident = state.incidents.find((i) => i.id === state.activeIncidentId) ?? null;
  const open = incident && incident.status !== "closed" ? incident : null;
  const scenario = incident ? scenarioById(incident.scenarioId) : null;
  const live = !!incident && !!incident.callStartedAt && !incident.callEndedAt;

  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [now, setNow] = useState<number | null>(null);
  const [geminiReady, setGeminiReady] = useState<boolean | null>(null);
  const [mode, setMode] = useState<Mode>("prerecorded");
  const [aiBusy, setAiBusy] = useState(false);
  const [geminiQuestions, setGeminiQuestions] = useState<string[]>([]);
  const [plans, setPlans] = useState<Record<string, RoutePlan>>({});
  const [trips, setTrips] = useState<Record<string, Trip>>({});
  const [flash, setFlash] = useState(0);
  const seqRef = useRef(0);
  const appliedSeqRef = useRef(0);

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
      act({ type: "LOG", at: Date.now(), incidentId: inc.id, actor: "system", eventType: "ai_fallback", message: `Gemini unavailable (${err instanceof Error ? err.message : "error"}). Switched to prerecorded extraction.` });
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

  const startDemo = useCallback((id: string) => {
    const at = Date.now();
    // Switching calls ends and closes the current one (frees its units) so the demo flows.
    if (live && incident) act({ type: "END_CALL", at, incidentId: incident.id });
    if (open) act({ type: "CLOSE_INCIDENT", at, incidentId: open.id });
    seqRef.current = 0;
    appliedSeqRef.current = 0;
    setGeminiQuestions([]);
    setTrips({});
    setMode(geminiReady ? "gemini" : "prerecorded");
    act({ type: "START_CALL", at, incidentId: newId("inc"), number: `INC-${String(Math.floor(at / 1000) % 100000).padStart(5, "0")}`, scenarioId: id });
  }, [live, incident, open, geminiReady]);

  // ---------- priority (AI proposal; dispatcher confirms or overrides) ----------
  const assessment = open ? assessConsole(open.category, open.fields) : null;
  const shownPriority: Priority | null = open ? open.priorityDecision?.priority ?? assessment!.proposed : null;

  // ---------- routes + team ----------
  const free = useMemo(
    () => (open ? state.officers.filter((o) => o.status === "available" && !open.declinedOfficerIds.includes(o.id)) : []),
    [open, state.officers],
  );
  const planKey = (o: Officer, inc: Incident) => `${o.id}|${inc.id}|${o.location[0].toFixed(5)},${o.location[1].toFixed(5)}`;
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
        const pts = tr ? [o.location, ...tr.route.slice(tr.next)] : [o.location, open.location];
        return { id: o.id, points: pts, foot: o.mode === "foot", kind: "assigned" as const };
      });
    }
    return team.map((c) => ({ id: c.officer.id, points: c.plan.route, foot: c.officer.mode === "foot", kind: "proposed" as const }));
  })();
  const fitKey = open ? `${open.id}|${dispatched ? "sent" : team.map((c) => c.officer.id + (c.plan.real ? "r" : "e")).join(",")}` : "";

  // ---------- trips: officers travel their routes; positions sync to the officer page ----------
  // One tick every 300 ms while trips run. Store updates happen here, never inside a state updater.
  useEffect(() => {
    if (!Object.keys(trips).length) return;
    const t = setTimeout(() => {
      const ts = Date.now();
      const next: Record<string, Trip> = {};
      for (const [id, tr] of Object.entries(trips)) {
        const k = Math.min(1, (ts - tr.t0) / TRIP_MS);
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
      act({ type: "APPROVE_ASSIGNMENT", at, incidentId: open.id, officerId: c.officer.id, assignmentId: newId("asg"), etaSeconds: c.plan.etaSeconds });
      started[c.officer.id] = { route: c.plan.route, t0: at, eta: c.plan.etaSeconds, k: 0, next: 1, incidentId: open.id };
    }
    setTrips((p) => ({ ...p, ...started }));
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
      if (k === "y") approveTeam();
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

  return (
    <div className={`dc ${fontClass}`} data-theme={theme} data-prio={shownPriority ?? ""}>
      <header className={`dc-head${flash ? " flash" : ""}`} key={`h${flash}`}>
        <span className="dc-brand">Dispatch Copilot · Princeton Public Safety</span>
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
        <span className="dc-spacer" />
        {live && <button type="button" className="dc-btn" onClick={revealNext}>Next line <kbd>E</kbd></button>}
        {live && <button type="button" className="dc-btn danger" onClick={() => act({ type: "END_CALL", at: Date.now(), incidentId: incident!.id })}>End call</button>}
        {!live && open && <button type="button" className="dc-btn" onClick={() => act({ type: "CLOSE_INCIDENT", at: Date.now(), incidentId: open.id })}>Close incident</button>}
        <button type="button" className="dc-btn" onClick={toggleTheme}>{theme === "dark" ? "Light mode" : "Dark mode"}</button>
        <button type="button" className="dc-btn ghost" onClick={() => { if (confirm("Reset the demo? All simulated incidents and unit positions go back to the start.")) { setTrips({}); act({ type: "RESET" }); } }}>Reset demo</button>
        <nav className="dc-nav" aria-label="Pages">
          <Link href="/dispatch">Classic view</Link>
          <Link href="/officer" target="_blank">Officer</Link>
          <Link href="/incidents">Incidents</Link>
        </nav>
      </header>

      <div className="dc-cols">
        {/* LEFT: the call */}
        <section className="dc-col dc-left" aria-label="Call">
          <div className="dc-col" style={{ flex: "3 1 0", minHeight: 0 }}>
            <h2 className="dc-strip">Live transcript {live && <small>Listening…</small>}</h2>
            <Transcript incident={incident} />
          </div>
          <div className="dc-col" style={{ flex: "2 1 0", minHeight: 0, borderTop: "1px solid var(--line)" }}>
            <h2 className="dc-strip">Ask next <small>{mode === "gemini" ? "checklist + Gemini" : "checklist"}</small></h2>
            <AskNext incident={open} geminiQuestions={mode === "gemini" ? geminiQuestions : []} />
          </div>
          <div className="dc-col" style={{ flex: "2 1 0", minHeight: 0, borderTop: "1px solid var(--line)" }}>
            <h2 className="dc-strip">AI and dispatcher log <small>audit trail</small></h2>
            <Log events={events} />
          </div>
        </section>

        {/* CENTER: what to do next */}
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
                  <span className="dc-kicker" aria-live="polite">{allOnScene ? "On scene" : "Sent · details on officer phones"}</span>
                  <span className="dc-team">
                    {assigned.map(({ o, a }) => {
                      const tr = trips[o.id];
                      const left = tr ? Math.round((1 - tr.k) * tr.eta) : 0;
                      return (
                        <span key={o.id}>
                          <span style={{ color: STATUS_VAR[o.status] }}>●</span>{o.callsign}
                          <small>{o.status === "on_scene" ? "on scene" : tr ? `ETA ${fmtClock(left * 1000)}` : STATUS_LABEL[o.status]}{a.acknowledgedAt ? " · acknowledged" : ""}</small>
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

          <ConsoleMap officers={state.officers} incident={open} priority={shownPriority} routes={routes} teamIds={teamIds} theme={theme} fitKey={fitKey} />

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
function Transcript({ incident }: { incident: Incident | null }) {
  const end = useRef<HTMLLIElement>(null);
  const n = incident?.transcript.length ?? 0;
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [n]);
  if (!incident) return <p className="dc-empty">Choose a demo call to start.</p>;
  return (
    <ol className="dc-transcript dc-scroll" aria-live="polite">
      {incident.transcript.map((s) => {
        const parts = s.highlight && s.text.includes(s.highlight) ? s.text.split(s.highlight) : null;
        return (
          <li key={s.id}>
            <div className={`dc-who ${s.speaker}`}>{s.speaker === "caller" ? "Caller" : "Dispatcher"}<time>00:{String(s.t).padStart(2, "0")}</time></div>
            <p>{parts ? <>{parts[0]}<mark>{s.highlight}</mark>{parts[1]}</> : s.text}</p>
          </li>
        );
      })}
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
