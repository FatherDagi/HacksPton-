"use client";
// /officer: the patrol car terminal. Idle = full map with every unit. On dispatch the live incident
// panel slides in from the left and the map moves right with the fastest route to the scene.
// The terminal is the car's GPS: after the officer acknowledges, it reports the unit's position.
import "../console/console.css";
import "./terminal.css";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { assessConsole } from "@/lib/console/assess";
import { along, DEMO_TRIP_MS, fetchRoute, remaining, type RoutePlan } from "@/lib/console/routing";
import { FIELD_LABELS, SECTIONS } from "@/lib/fields";
import { URGENCY_LABEL } from "@/lib/priority";
import { buildingById } from "@/lib/campus";
import { haversine } from "@/lib/recommend";
import { scenarioById } from "@/lib/scenarios";
import { act, newId, signInTerminal, stamp, useAppState, useOnline } from "@/lib/store";
import type { Incident, LatLng, Officer, Priority } from "@/lib/types";
import { fmtClock, fmtTime } from "../ui";
import type { ConsoleRoute } from "../console/ConsoleMap";

const ConsoleMap = dynamic(() => import("../console/ConsoleMap"), { ssr: false, loading: () => <div className="dc-map"><p className="dc-empty">Loading map…</p></div> });

const PRIORITY_WORD: Record<Priority, string> = { 1: "Critical", 2: "Urgent", 3: "Respond", 4: "Routine" };
// Same notes the dispatcher sees, ordered for the officer: danger first, caller last.
const OFFICER_SECTIONS = ["Scene", "People", "Location", "Incident", "Caller"].map((t) => SECTIONS.find((s) => s.title === t)!);
// Demo button: a scripted call that fits the unit type.
const DEMO_CALL = { police: "police-frist", ems: "medical-whitman", fire: "fire-equad" } as const;
const ARRIVE_M = 50; // within this distance of the incident counts as arrived
const DEMO_PACE = 0.6; // play the scripted call a bit faster than real time

const STATUS_LABEL = { available: "Available", busy: "Busy", responding: "Responding", on_scene: "On scene" } as const;

interface Trip { route: LatLng[]; t0: number; eta: number; incidentId: string; done: boolean }

export function Terminal({ fontClass }: { fontClass: string }) {
  const unit = useSearchParams().get("unit");
  const state = useAppState();
  const online = useOnline();
  const me = state.officers.find((o) => o.id === unit) ?? null;

  useEffect(() => {
    signInTerminal(me ? me.id : null);
    return () => signInTerminal(null);
  }, [me?.id]); // eslint-disable-line react-hooks/exhaustive-deps -- sign in once per unit, not per position update

  const asg = me ? state.assignments.find((a) => a.officerId === me.id && a.status === "active") ?? null : null;
  const inc = asg ? state.incidents.find((i) => i.id === asg.incidentId && i.status !== "closed") ?? null : null;

  const [plan, setPlan] = useState<{ incidentId: string; p: RoutePlan } | null>(null);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [now, setNow] = useState(0);
  const [demo, setDemo] = useState<{ incidentId: string; scenarioId: string; t0: number } | null>(null);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  // Fastest route: the one the dispatcher approved, else ask the router from where the car is.
  useEffect(() => {
    if (!me || !inc || plan?.incidentId === inc.id) return;
    if (asg?.route && asg.route.length > 1) {
      const t = setTimeout(() => setPlan({ incidentId: inc.id, p: { route: asg.route!, etaSeconds: asg.etaSeconds, distanceMeters: 0, avoidsClosure: null, real: true } }), 0);
      return () => clearTimeout(t);
    }
    let alive = true;
    fetchRoute(me.location, inc.location, me.mode).then((p) => { if (alive) setPlan({ incidentId: inc.id, p }); });
    return () => { alive = false; };
  }, [me, inc, plan, asg]);

  // Drive once acknowledged (also resumes after a page reload mid-trip).
  useEffect(() => {
    if (!me || !inc || !asg?.acknowledgedAt || me.status !== "responding" || trip?.incidentId === inc.id) return;
    const t = setTimeout(() => {
      // Drive the planned route from wherever the car is now (also covers a reload mid-trip).
      const p = plan?.incidentId === inc.id ? Promise.resolve({ ...plan.p, route: remaining(plan.p.route, me.location) }) : fetchRoute(me.location, inc.location, me.mode);
      p.then((r) => setTrip({ route: r.route, t0: Date.now(), eta: r.etaSeconds, incidentId: inc.id, done: false }));
    }, 0);
    return () => clearTimeout(t);
  }, [me, inc, asg, trip, plan]);

  // GPS reports while driving. Arrival is automatic: no button to press in a tense moment. The unit is
  // on scene once its position reaches the end of the route or comes within ARRIVE_M of the incident.
  useEffect(() => {
    if (!me || !inc || !trip || trip.done || me.status !== "responding") return;
    const t = setTimeout(() => {
      const k = Math.min(1, (Date.now() - trip.t0) / DEMO_TRIP_MS);
      const at = along(trip.route, k).at;
      act({ type: "OFFICER_LOCATION", at: stamp(), officerId: me.id, location: at, label: "En route (car GPS, simulated)" });
      if (k >= 1 || haversine(at, inc.location) < ARRIVE_M) {
        act({ type: "OFFICER_STATUS", at: stamp(), officerId: me.id, status: "on_scene" });
        setTrip({ ...trip, done: true });
      }
    }, 300);
    return () => clearTimeout(t);
  }, [me, inc, trip]);

  // Demo call playback: this terminal reveals the scripted call line by line, so the notes fill in live.
  const demoInc = demo ? state.incidents.find((i) => i.id === demo.incidentId) ?? null : null;
  useEffect(() => {
    const sc = demo && scenarioById(demo.scenarioId);
    if (!demo || !sc || !demoInc || demoInc.status === "closed" || demoInc.revealed >= sc.segments.length) return;
    const seg = sc.segments[demoInc.revealed];
    const t = setTimeout(() => {
      act({ type: "REVEAL_SEGMENT", at: stamp(), incidentId: demo.incidentId });
      const updates = (seg.updates ?? []).map((u) => ({ ...u, evidenceSegmentId: seg.id }));
      if (updates.length) act({ type: "APPLY_AI_UPDATES", at: stamp(), incidentId: demo.incidentId, updates, source: "demo" });
    }, Math.max(0, demo.t0 + seg.t * 1000 * DEMO_PACE - Date.now()));
    return () => clearTimeout(t);
  }, [demo, demoInc]);

  const simulateCall = async () => {
    if (!me || me.status !== "available") return;
    const sc = scenarioById(DEMO_CALL[me.type]);
    const b = sc && buildingById(sc.buildingId);
    if (!sc || !b) return;
    const at = stamp();
    const incidentId = newId("inc");
    // End any call still open on the console so the demo starts clean.
    const active = state.incidents.find((i) => i.id === state.activeIncidentId && i.status !== "closed");
    if (active) act({ type: "CLOSE_INCIDENT", at, incidentId: active.id });
    act({ type: "START_CALL", at, incidentId, number: `INC-${String(Math.floor(at / 1000) % 100000).padStart(5, "0")}`, scenarioId: sc.id });
    // This terminal plays the call, so the console must not replay it too: mark the live call ended.
    act({ type: "END_CALL", at, incidentId });
    act({ type: "LOG", at, incidentId, actor: "system", eventType: "demo", message: `Demo started from ${me.callsign}'s terminal: simulated call, dispatcher approval simulated.` });
    setDemo({ incidentId, scenarioId: sc.id, t0: at });
    const p = await fetchRoute(me.location, b.location, me.mode);
    act({ type: "APPROVE_ASSIGNMENT", at: stamp(), incidentId, officerId: me.id, assignmentId: newId("asg"), etaSeconds: p.etaSeconds, route: p.route });
  };

  if (!me) return <Picker officers={state.officers} fontClass={fontClass} />;

  const assessment = inc ? assessConsole(inc.category, inc.fields) : null;
  const priority: Priority | null = inc ? inc.priorityDecision?.priority ?? assessment!.proposed : null;
  const k = trip && trip.incidentId === inc?.id ? Math.min(1, (now - trip.t0) / DEMO_TRIP_MS) : 0;
  const etaLeft = trip && trip.incidentId === inc?.id ? Math.max(0, Math.round((1 - k) * trip.eta)) : plan?.p.etaSeconds ?? null;

  const routes: ConsoleRoute[] = [];
  if (inc && me.status === "responding") {
    const r = trip?.incidentId === inc.id ? remaining(trip.route, me.location) : plan?.incidentId === inc.id ? plan.p.route : [me.location, inc.location];
    routes.push({ id: me.id, points: r, foot: me.mode === "foot", kind: "assigned" });
  }
  const others = inc ? state.officers.filter((o) => o.id !== me.id && o.currentIncidentId === inc.id) : [];

  return (
    <div className={`dc ot ${fontClass}${inc ? " dispatched" : ""}`} data-theme="dark" data-prio={priority ?? ""}>
      <header className="ot-head">
        <Link href="/" className="dc-brand" title="Back to the start screen">Dispatch Copilot <small>Patrol terminal</small></Link>
        <span className="ot-unit"><b>{me.callsign}</b> {me.name}</span>
        <span className="ot-status" data-s={me.status}>{STATUS_LABEL[me.status]}</span>
        <span className={`ot-link${online ? " on" : ""}`}>{online ? "Linked to dispatch" : "No link to dispatch"}</span>
        <Link href="/officer" className="ot-switch">Switch unit</Link>
      </header>

      <div className="ot-body">
        <aside className="ot-panel" aria-label="Live incident" aria-hidden={!inc}>
          {inc && priority && assessment && asg && (
            <>
              <div className="ot-alert">
                <span className="ot-word">{PRIORITY_WORD[priority]}</span>
                <span className="ot-live"><i />Live from dispatch</span>
              </div>
              <div className="ot-scroll">
                <h1 className="ot-title">{inc.title}</h1>
                <p className="ot-where">{[inc.placeName ?? inc.fields.building.value, inc.fields.floor.value && (/floor/i.test(inc.fields.floor.value) ? inc.fields.floor.value : `floor ${inc.fields.floor.value}`), inc.fields.room.value].filter(Boolean).join(", ") || "Location being confirmed"}</p>

                <Actions me={me} acknowledged={!!asg.acknowledgedAt} etaLeft={etaLeft}
                  onAck={() => act({ type: "ACK_ASSIGNMENT", at: stamp(), assignmentId: asg.id })}
                  onClear={() => act({ type: "OFFICER_STATUS", at: stamp(), officerId: me.id, status: "available" })} />

                {/* Dispatcher-approved updates since dispatch; the officer confirms each one. */}
                {(state.officerUpdates ?? []).filter((u) => u.assignmentId === asg.id && u.status === "sent").map((u) => (
                  <section key={u.id} className="ot-update" role="alert">
                    <h2>Update from dispatch · {fmtTime(u.sentAt)}</h2>
                    <ul>
                      {u.changes.map((c) => (
                        <li key={c.key}><b>{c.label}:</b> {c.to}{c.from && <s>{c.from}</s>}</li>
                      ))}
                    </ul>
                    <button type="button" className="dc-btn lg ot-update-ack" onClick={() => act({ type: "ACK_OFFICER_UPDATE", at: stamp(), updateId: u.id })}>
                      Acknowledge update
                    </button>
                  </section>
                ))}

                <section className="ot-sec">
                  <h2>P{priority} · {URGENCY_LABEL[assessment.urgency]}</h2>
                  <ul className="dc-reasons">{assessment.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
                  {inc.priorityDecision?.overrideReason && <p className="ot-note">Dispatcher set P{inc.priorityDecision.priority}: {inc.priorityDecision.overrideReason}</p>}
                </section>

                {(inc.mentionedPlaces ?? []).length > 0 && (
                  <section className="ot-sec">
                    <h2>Also mentioned (pinned on map)</h2>
                    <p>{(inc.mentionedPlaces ?? []).map((p) => p.name).join(", ")}</p>
                  </section>
                )}

                {others.length > 0 && (
                  <section className="ot-sec">
                    <h2>Also sent</h2>
                    <p>{others.map((o) => `${o.callsign} (${STATUS_LABEL[o.status].toLowerCase()})`).join(", ")}</p>
                  </section>
                )}

                <Notes incident={inc} now={now} />
              </div>
            </>
          )}
        </aside>

        <div className="ot-mapwrap">
          {!inc && me.status === "available" && (
            <button type="button" className="dc-btn lg ot-demo" onClick={simulateCall}>Simulate emergency call</button>
          )}
          <ConsoleMap officers={state.officers} incident={inc} priority={priority} routes={routes} teamIds={[me.id]} theme="dark"
            fitKey={inc ? `${inc.id}|${plan?.incidentId === inc.id ? "planned" : ""}|${me.status}` : ""} />
        </div>
      </div>
    </div>
  );
}

function Actions({ me, acknowledged, etaLeft, onAck, onClear }: {
  me: Officer; acknowledged: boolean; etaLeft: number | null; onAck: () => void; onClear: () => void;
}) {
  if (me.status === "on_scene") {
    return (
      <div className="ot-actions">
        <p className="ot-step">On scene (marked from your position). Dispatch can see where you are.</p>
        <button type="button" className="dc-btn lg" onClick={onClear}>Clear call, back to available</button>
      </div>
    );
  }
  if (!acknowledged) {
    return (
      <div className="ot-actions">
        <p className="ot-step">Dispatch is waiting for you to accept.{etaLeft != null ? ` Fastest route about ${fmtClock(etaLeft * 1000)}.` : ""}</p>
        <button type="button" className="dc-btn lg primary ot-ack" onClick={onAck} autoFocus>Acknowledge and go</button>
      </div>
    );
  }
  return (
    <div className="ot-actions">
      <p className="ot-step">En route. ETA {etaLeft != null ? fmtClock(etaLeft * 1000) : "--:--"}</p>
      <p className="ot-hint">Arrival is marked automatically from your position.</p>
    </div>
  );
}

function Notes({ incident, now }: { incident: Incident; now: number }) {
  return (
    <div className="ot-notes">
      {OFFICER_SECTIONS.map((sec) => {
        const known = sec.keys.filter((k) => incident.fields[k].value);
        return (
          <section key={sec.title} className="ot-sec">
            <h2>{sec.title}</h2>
            {known.length === 0 ? <p className="ot-none">Nothing reported yet</p> : known.map((k) => {
              const f = incident.fields[k];
              const fresh = !!f.updatedAt && now - f.updatedAt < 6000;
              return (
                <div key={k} className={`ot-field${fresh ? " fresh" : ""}${sec.title === "Scene" ? " danger" : ""}`}>
                  <span className="k">{FIELD_LABELS[k]}</span>
                  <span className="v">{f.value}</span>
                  <span className={`dc-badge ${f.status}`} title={f.updatedAt ? `Updated ${fmtTime(f.updatedAt)}` : undefined}>{f.status === "confirmed" ? "Confirmed" : "Heard"}</span>
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

function Picker({ officers, fontClass }: { officers: Officer[]; fontClass: string }) {
  return (
    <div className={`dc ot ${fontClass}`} data-theme="dark">
      <header className="ot-head">
        <Link href="/" className="dc-brand">Dispatch Copilot <small>Patrol terminal</small></Link>
      </header>
      <main className="ot-pick">
        <h1>Which unit is this car?</h1>
        <p>The terminal reports this unit&apos;s position to dispatch and receives its calls.</p>
        <ul>
          {officers.map((o) => (
            <li key={o.id}>
              <Link href={`/officer?unit=${o.id}`}>
                <b>{o.callsign}</b>
                <span>{o.name}</span>
                <small>{o.type === "police" ? "Police" : o.type.toUpperCase()}, {o.mode === "foot" ? "on foot" : "car"}</small>
              </Link>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}
