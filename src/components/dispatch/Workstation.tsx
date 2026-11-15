"use client";
import { Building2, ListChecks, Play, SkipForward, Square } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ExtractError, ExtractResponse } from "@/lib/extraction";
import { rankUnits } from "@/lib/recommend";
import { scenarioById, SCENARIOS } from "@/lib/scenarios";
import { act, newId, useAppState } from "@/lib/store";
import type { Incident } from "@/lib/types";
import { Button, SimBanner, cx, fmtClock } from "../ui";
import type { MapRoute } from "./CampusMap";
import { ActivityDrawer, QuestionsDrawer, TranscriptDrawer } from "./Drawers";
import { IncidentPanel } from "./IncidentPanel";
import { MapDrawer, MapRail, type DrawerTab } from "./MapRail";

const CampusMap = dynamic(() => import("./CampusMap"), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center text-sm text-faint">Loading map…</div>,
});

type ExtractionMode = "gemini" | "prerecorded";

/** Applies precomputed extraction for segments [from, to). */
function applyPrerecorded(inc: Incident, from: number, to: number) {
  const sc = scenarioById(inc.scenarioId);
  if (!sc) return;
  const updates = sc.segments.slice(from, to).flatMap((seg) => (seg.updates ?? []).map((u) => ({ ...u, evidenceSegmentId: seg.id })));
  if (updates.length) act({ type: "APPLY_AI_UPDATES", at: Date.now(), incidentId: inc.id, updates, source: "demo" });
}

export function Workstation() {
  const state = useAppState();
  const incident = state.incidents.find((i) => i.id === state.activeIncidentId) ?? null;
  const scenario = incident ? scenarioById(incident.scenarioId) : null;
  const live = !!incident && !!incident.callStartedAt && !incident.callEndedAt;

  const [scenarioId, setScenarioId] = useState(SCENARIOS[0].id);
  const [geminiReady, setGeminiReady] = useState<boolean | null>(null);
  const [mode, setMode] = useState<ExtractionMode>("prerecorded");
  const [aiBusy, setAiBusy] = useState(false);
  const [geminiQuestions, setGeminiQuestions] = useState<string[]>([]);
  const [now, setNow] = useState<number | null>(null);
  const seqRef = useRef(0);
  const appliedSeqRef = useRef(0);

  // Left rail drawers: all closed by default. Counts seen when a drawer was last open drive the "new" badges.
  const [drawer, setDrawer] = useState<DrawerTab | null>(null);
  const [seen, setSeen] = useState({ transcript: 0, activity: 0 });
  const transcriptCount = incident?.transcript.length ?? 0;
  const incidentEvents = useMemo(
    () => (incident ? state.events.filter((e) => e.incidentId === incident.id).sort((a, b) => a.at - b.at) : []),
    [incident, state.events],
  );
  const markSeen = useCallback(() => setSeen({ transcript: transcriptCount, activity: incidentEvents.length }), [transcriptCount, incidentEvents.length]);
  const toggleDrawer = useCallback(
    (t: DrawerTab) => {
      markSeen();
      setDrawer((cur) => (cur === t ? null : t));
    },
    [markSeen],
  );
  const closeDrawer = useCallback(() => {
    markSeen();
    setDrawer(null);
  }, [markSeen]);

  // Is Gemini configured on the server?
  useEffect(() => {
    fetch("/api/extract")
      .then((r) => r.json())
      .then((j: { geminiConfigured: boolean }) => {
        setGeminiReady(j.geminiConfigured);
        if (j.geminiConfigured) setMode("gemini");
      })
      .catch(() => setGeminiReady(false));
  }, []);

  // Clock
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, 500);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, []);

  const runGemini = useCallback(async (inc: Incident, transcript: Incident["transcript"]) => {
    const seq = ++seqRef.current;
    setAiBusy(true);
    const confirmed: Record<string, string> = {};
    for (const f of Object.values(inc.fields)) if (f.source === "dispatcher" && f.value) confirmed[f.key] = f.value;
    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: inc.category, transcript: transcript.map(({ id, speaker, text }) => ({ id, speaker, text })), confirmed }),
      });
      const j = (await res.json()) as ExtractResponse | ExtractError;
      if (!j.ok) throw new Error(j.message);
      // Ignore responses older than one we've already applied.
      if (seq < appliedSeqRef.current) return;
      appliedSeqRef.current = seq;
      if (j.updates.length) act({ type: "APPLY_AI_UPDATES", at: Date.now(), incidentId: inc.id, updates: j.updates, source: "ai" });
      setGeminiQuestions(j.suggestedQuestions);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown error";
      act({ type: "LOG", at: Date.now(), incidentId: inc.id, actor: "system", eventType: "ai_fallback", message: `Gemini unavailable (${msg}). Switched to prerecorded extraction.` });
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
    if (mode === "prerecorded") {
      applyPrerecorded(incident, idx, idx + 1);
    } else if (seg.speaker === "caller") {
      const { updates: _u, ...plain } = seg;
      void _u;
      runGemini(incident, [...incident.transcript, plain]);
    }
  }, [incident, scenario, mode, runGemini]);

  // Progressive playback: reveal each segment when its timestamp is reached.
  useEffect(() => {
    if (!live || !incident || !scenario || now === null) return;
    const nextSeg = scenario.segments[incident.revealed];
    if (!nextSeg) return;
    const due = incident.callStartedAt! + nextSeg.t * 1000;
    const t = setTimeout(revealNext, Math.max(0, due - Date.now()));
    return () => clearTimeout(t);
  }, [live, incident, scenario, now, revealNext]);

  const startDemo = () => {
    const sc = scenarioById(scenarioId)!;
    const at = Date.now();
    seqRef.current = 0;
    appliedSeqRef.current = 0;
    setGeminiQuestions([]);
    setMode(geminiReady ? "gemini" : "prerecorded");
    act({ type: "PREP_DEMO", at });
    act({ type: "START_CALL", at, incidentId: newId("inc"), number: `INC-${String(Math.floor(at / 1000) % 100000).padStart(5, "0")}`, scenarioId: sc.id });
  };

  // Recommendations and map routes
  const recs = useMemo(() => (incident && incident.status !== "closed" ? rankUnits(incident, state.officers) : []), [incident, state.officers]);
  const assignment = incident ? state.assignments.find((a) => a.incidentId === incident.id && a.status === "active") ?? null : null;
  const routes: MapRoute[] = useMemo(() => {
    if (!incident) return [];
    if (assignment) {
      const o = state.officers.find((x) => x.id === assignment.officerId);
      if (o && o.status === "responding") return [{ points: [o.location, incident.location], kind: "assigned" }];
      return [];
    }
    return recs[0] ? [{ points: recs[0].route, kind: "proposed" }] : [];
  }, [incident, assignment, recs, state.officers]);
  const highlightId = assignment?.officerId ?? recs[0]?.officer.id ?? null;

  const extractionLabel =
    mode === "gemini" ? (aiBusy ? "Gemini extracting…" : "Gemini · AI-generated") : "Prerecorded demo extraction (not AI)";

  const clock = !incident
    ? "--:--"
    : live && now
      ? fmtClock(now - incident.callStartedAt!)
      : incident.callEndedAt && incident.callStartedAt
        ? fmtClock(incident.callEndedAt - incident.callStartedAt)
        : "--:--";
  const assignedOfficer = assignment ? state.officers.find((o) => o.id === assignment.officerId) ?? null : null;
  const officerUpdates = assignment ? (state.officerUpdates ?? []).filter((u) => u.assignmentId === assignment.id) : [];
  const openQuestions = incident
    ? incident.questions.filter((q) => q.state === "open" && incident.fields[q.fieldKey].status === "unknown").length
    : 0;
  const activeIncident = incident && incident.status !== "closed" ? incident : null;

  return (
    <div className="flex h-screen min-h-[640px] flex-col">
      {/* Top bar */}
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-panel px-4 py-2">
        <span className="text-[15px] font-bold tracking-tight">Dispatch Copilot</span>
        <SimBanner />
        <span className={cx("rounded-[2px] border px-1.5 py-0.5 text-[11px]", mode === "gemini" ? "border-accent/50 text-[#8fb6f5]" : "border-line2 text-faint")}>
          {geminiReady === null ? "Checking AI…" : mode === "gemini" ? "AI: Gemini connected" : geminiReady ? "AI: fallback (prerecorded)" : "AI: not configured (prerecorded)"}
        </span>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {!live ? (
            <>
              <label htmlFor="scenario" className="sr-only">Scenario</label>
              <select id="scenario" value={scenarioId} onChange={(e) => setScenarioId(e.target.value)}
                className="h-9 rounded-[3px] border border-line2 bg-panel2 px-2 text-[13px] text-ink">
                {SCENARIOS.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
              </select>
              <Button variant="primary" onClick={startDemo}><Play size={14} /> Run demo scenario</Button>
              {incident && incident.status !== "closed" && (
                <Button onClick={() => act({ type: "CLOSE_INCIDENT", at: Date.now(), incidentId: incident.id })}>Close incident</Button>
              )}
            </>
          ) : (
            <>
              <Button onClick={revealNext} disabled={!scenario || incident!.revealed >= scenario.segments.length} title="Reveal the next line now">
                <SkipForward size={14} /> Next line
              </Button>
              <Button variant="danger" onClick={() => act({ type: "END_CALL", at: Date.now(), incidentId: incident!.id })}>
                <Square size={12} /> End call
              </Button>
            </>
          )}
          <nav className="flex items-center gap-1 border-l border-line pl-2" aria-label="Pages">
            <Link className="inline-flex h-9 items-center gap-1 px-2 text-[13px] text-sub hover:text-ink" href="/incidents"><ListChecks size={14} /> Incidents</Link>
            <Link className="inline-flex h-9 items-center gap-1 px-2 text-[13px] text-sub hover:text-ink" href="/building"><Building2 size={14} /> Building</Link>
          </nav>
        </div>
      </header>

      {/* Map-first: rail + map (~67%) | permanent incident panel (~33%) */}
      <main className="flex min-h-0 flex-1 flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(360px,33%)]">
        <div className="flex min-h-[420px] min-w-0 flex-1 lg:min-h-0">
          <MapRail
            active={drawer}
            onToggle={toggleDrawer}
            badges={{
              transcript: drawer === "transcript" ? 0 : Math.max(0, transcriptCount - seen.transcript),
              questions: openQuestions,
              activity: drawer === "activity" ? 0 : Math.max(0, incidentEvents.length - seen.activity),
            }}
          />
          {/* The drawer overlays the map; the map never resizes or remounts. */}
          <div className="relative min-w-0 flex-1">
            <CampusMap officers={state.officers} incident={activeIncident} routes={routes} highlightOfficerId={highlightId} />
            <MapDrawer tab={drawer} onClose={closeDrawer}>
              {{
                transcript: <TranscriptDrawer incident={incident} live={live} />,
                questions: <QuestionsDrawer incident={activeIncident} sourceLabel={extractionLabel} geminiQuestions={mode === "gemini" ? geminiQuestions : []} />,
                activity: <ActivityDrawer events={incidentEvents} />,
              }}
            </MapDrawer>
          </div>
        </div>
        <IncidentPanel
          incident={incident}
          live={live}
          clock={clock}
          recs={recs}
          assignment={assignment}
          assignedOfficer={assignedOfficer}
          officers={state.officers}
          officerUpdates={officerUpdates}
          highlightId={highlightId}
          onOpenQuestions={() => {
            markSeen();
            setDrawer("questions");
          }}
        />
      </main>
    </div>
  );
}
