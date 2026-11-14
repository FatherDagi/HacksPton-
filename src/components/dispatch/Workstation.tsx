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
import { CallPanel } from "./CallPanel";
import { IncidentSheet } from "./IncidentSheet";
import { UnitsPanel } from "./UnitsPanel";
import type { MapRoute } from "./CampusMap";

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
    seqRef.current = 0;
    appliedSeqRef.current = 0;
    setGeminiQuestions([]);
    setMode(geminiReady ? "gemini" : "prerecorded");
    act({ type: "START_CALL", at: Date.now(), incidentId: newId("inc"), number: `INC-${String(Math.floor(Date.now() / 1000) % 100000).padStart(5, "0")}`, scenarioId: sc.id });
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

  return (
    <div className="flex h-screen min-h-[640px] flex-col">
      {/* Top bar */}
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-panel px-4 py-2">
        <span className="text-[15px] font-bold tracking-tight">Dispatch Copilot</span>
        <SimBanner />
        {incident && (
          <span className="flex items-center gap-2 text-[13px]">
            <span className="font-mono text-sub">{incident.number}</span>
            <span className={cx("font-mono font-semibold", live ? "text-[#ffb3ad]" : "text-sub")}>
              {live && now ? fmtClock(now - incident.callStartedAt!) : incident.callEndedAt && incident.callStartedAt ? fmtClock(incident.callEndedAt - incident.callStartedAt) : "--:--"}
            </span>
            <span className="rounded-[2px] border border-line2 px-1.5 text-[11px] uppercase tracking-wide text-sub">{incident.status.replace("_", " ")}</span>
          </span>
        )}
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

      {/* Three columns: call 25% | incident info 42% | map + units 33% */}
      <main className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[25fr_42fr_33fr]">
        <CallPanel incident={incident} live={live} extractionLabel={extractionLabel} geminiQuestions={mode === "gemini" ? geminiQuestions : []} />
        <IncidentSheet incident={incident} />
        <section aria-label="Map and units" className="flex min-h-0 flex-col bg-panel">
          <div className="relative h-[42%] min-h-[240px] shrink-0 border-b border-line">
            <CampusMap officers={state.officers} incident={incident && incident.status !== "closed" ? incident : null} routes={routes} highlightOfficerId={highlightId} />
          </div>
          <UnitsPanel incident={incident && incident.status !== "closed" ? incident : null} officers={state.officers} recs={recs} assignment={assignment} />
        </section>
      </main>
    </div>
  );
}
