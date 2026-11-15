"use client";
// /officer: mobile patrol — full-screen satellite map, live GPS, acknowledge + backup.
// No messaging thread. Status colors match HQ (green free · amber busy · red on call).
import "../console/console.css";
import "./terminal.css";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { assessConsole } from "@/lib/console/assess";
import { along, fetchRoute, remaining, type RoutePlan } from "@/lib/console/routing";
import { FIELD_LABELS } from "@/lib/fields";
import { URGENCY_LABEL } from "@/lib/priority";
import { act, newId, serverToLocal, signInTerminal, stamp, useAppState, useOnline, useTerminals, useUnitTaken } from "@/lib/store";
import type { BackupRequest, Incident, LatLng, Officer, Priority } from "@/lib/types";
import { fmtClock, fmtTime } from "../ui";
import type { ConsoleRoute } from "../console/ConsoleMap";

const ConsoleMap = dynamic(() => import("../console/ConsoleMap"), {
  ssr: false,
  loading: () => <div className="dc-map" style={{ position: "absolute", inset: 0 }} />,
});

const TRIP_MS = 12_000;
const PRIORITY_WORD: Record<Priority, string> = { 1: "Critical", 2: "Urgent", 3: "Respond", 4: "Routine" };
const STATUS_LABEL = { available: "Available", busy: "Busy", responding: "En route", on_scene: "On scene" } as const;
const GLANCE_KEYS = ["weapons", "hazards", "suspect", "conscious", "breathing", "people_count", "caller_safe", "access"] as const;

interface Trip { route: LatLng[]; t0: number; eta: number; incidentId: string; done: boolean }

export function Terminal({ fontClass }: { fontClass: string }) {
  const unit = useSearchParams().get("unit");
  const state = useAppState();
  const online = useOnline();
  const picked = state.officers.find((o) => o.id === unit) ?? null;
  // One device per patrol officer: if another device already holds this officer, this one stays
  // hands-off (no GPS, no status changes) and shows a notice until that device lets go.
  const taken = useUnitTaken();
  const me = taken ? null : picked;
  const terminals = useTerminals();

  useEffect(() => {
    signInTerminal(picked ? picked.id : null);
    return () => signInTerminal(null);
  }, [picked?.id]); // eslint-disable-line react-hooks/exhaustive-deps -- once per unit

  const asg = me ? state.assignments.find((a) => a.officerId === me.id && a.status === "active") ?? null : null;
  const queuedJobs = me
    ? state.assignments
        .filter((a) => a.officerId === me.id && a.status === "queued")
        .map((a) => state.incidents.find((i) => i.id === a.incidentId && i.status !== "closed"))
        .filter((i): i is Incident => !!i)
        .sort((a, b) => (a.priorityDecision?.priority ?? 99) - (b.priorityDecision?.priority ?? 99))
    : [];
  const inc = asg ? state.incidents.find((i) => i.id === asg.incidentId && i.status !== "closed") ?? null : null;
  const myBackup = me && inc
    ? (state.backups ?? []).find((b) => b.officerId === me.id && b.incidentId === inc.id && b.status !== "resolved") ?? null
    : null;

  const [plan, setPlan] = useState<{ incidentId: string; p: RoutePlan } | null>(null);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [now, setNow] = useState(0);
  const [geoOk, setGeoOk] = useState<boolean | null>(null);
  const [wide, setWide] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(min-width: 720px)").matches,
  );
  const [sheetOpen, setSheetOpen] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(min-width: 720px)").matches,
  );
  const pendingUpdates = asg
    ? (state.officerUpdates ?? []).filter((u) => u.assignmentId === asg.id && u.status === "sent")
    : [];
  useEffect(() => {
    if (pendingUpdates.length) setSheetOpen(true);
  }, [pendingUpdates.length]);
  const lastGeo = useRef(0);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 720px)");
    const sync = () => setWide(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // Live device GPS → HQ map
  useEffect(() => {
    if (!me || !navigator.geolocation) {
      setGeoOk(false);
      return;
    }
    const watch = navigator.geolocation.watchPosition(
      (pos) => {
        setGeoOk(true);
        const ts = Date.now();
        if (ts - lastGeo.current < 2000) return;
        lastGeo.current = ts;
        const at: LatLng = [pos.coords.latitude, pos.coords.longitude];
        // Stay near campus for demo if the phone is far away (e.g. travel / VPN)
        const campus = Math.abs(at[0] - 40.3465) < 0.08 && Math.abs(at[1] + 74.6555) < 0.08;
        if (!campus && me.status !== "responding") return;
        act({
          type: "OFFICER_LOCATION",
          at: stamp(),
          officerId: me.id,
          location: campus ? at : me.location,
          label: campus ? "Live GPS" : me.locationLabel,
        });
      },
      () => setGeoOk(false),
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 12_000 },
    );
    return () => navigator.geolocation.clearWatch(watch);
  }, [me?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!me || !inc || plan?.incidentId === inc.id) return;
    if (asg?.route && asg.route.length > 1) {
      const t = setTimeout(() => setPlan({
        incidentId: inc.id,
        p: { route: asg.route!, etaSeconds: asg.etaSeconds, distanceMeters: 0, avoidsClosure: null, real: true },
      }), 0);
      return () => clearTimeout(t);
    }
    let alive = true;
    fetchRoute(me.location, inc.location, me.mode).then((p) => { if (alive) setPlan({ incidentId: inc.id, p }); });
    return () => { alive = false; };
  }, [me, inc, plan, asg]);

  useEffect(() => {
    if (!me || !inc || !asg?.acknowledgedAt || me.status !== "responding" || trip?.incidentId === inc.id) return;
    const t = setTimeout(() => {
      const p = plan?.incidentId === inc.id
        ? Promise.resolve({ ...plan.p, route: remaining(plan.p.route, me.location) })
        : fetchRoute(me.location, inc.location, me.mode);
      p.then((r) => setTrip({ route: r.route, t0: Date.now(), eta: r.etaSeconds, incidentId: inc.id, done: false }));
    }, 0);
    return () => clearTimeout(t);
  }, [me, inc, asg, trip, plan]);

  useEffect(() => {
    if (!me || !trip || trip.done || me.status !== "responding") return;
    // Prefer real GPS when available; otherwise glide the simulated route so the demo still moves.
    if (geoOk) return;
    const t = setTimeout(() => {
      const k = Math.min(1, (Date.now() - trip.t0) / TRIP_MS);
      act({ type: "OFFICER_LOCATION", at: stamp(), officerId: me.id, location: along(trip.route, k).at, label: "En route (sim GPS)" });
      if (k >= 1) setTrip({ ...trip, done: true });
    }, 300);
    return () => clearTimeout(t);
  }, [me, trip, geoOk]);

  useEffect(() => {
    // Laptop side card starts open; phone stays map-first with a compact peek + CTA.
    if (inc) setSheetOpen(window.matchMedia("(min-width: 720px)").matches);
    setTrip(null);
    setPlan(null);
  }, [inc?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (picked && taken) return <UnitTaken officer={picked} fontClass={fontClass} />;
  if (!me) {
    // Officers another device is using right now (polled in the last 8 s) can't be picked.
    const inUse = new Set(Object.entries(terminals).filter(([, t]) => now > 0 && now - serverToLocal(t) < 8_000).map(([id]) => id));
    return <Picker officers={state.officers} inUse={inUse} fontClass={fontClass} />;
  }

  const assessment = inc ? assessConsole(inc.category, inc.fields) : null;
  const priority: Priority | null = inc ? inc.priorityDecision?.priority ?? assessment!.proposed : null;
  const k = trip && trip.incidentId === inc?.id ? Math.min(1, (now - trip.t0) / TRIP_MS) : 0;
  const etaLeft = trip && trip.incidentId === inc?.id
    ? Math.max(0, Math.round((1 - k) * trip.eta))
    : plan?.p.etaSeconds ?? asg?.etaSeconds ?? null;

  const routes: ConsoleRoute[] = [];
  if (inc && me.status === "responding") {
    const r = trip?.incidentId === inc.id
      ? remaining(trip.route, me.location)
      : plan?.incidentId === inc.id ? plan.p.route : [me.location, inc.location];
    routes.push({ id: me.id, points: r, foot: me.mode === "foot", kind: "assigned" });
  }

  const requestBackup = () => {
    if (!inc || myBackup) return;
    act({
      type: "REQUEST_BACKUP",
      at: stamp(),
      requestId: newId("bak"),
      officerId: me.id,
      incidentId: inc.id,
      note: "Officer requesting additional units",
    });
  };

  const setIdle = (status: "available" | "busy") => {
    if (me.status === "responding" || me.status === "on_scene") return;
    act({ type: "OFFICER_STATUS", at: stamp(), officerId: me.id, status });
  };

  const where = inc
    ? [inc.placeName ?? inc.fields.building.value, inc.fields.floor.value && `Fl ${inc.fields.floor.value}`, inc.fields.room.value]
        .filter(Boolean).join(" · ") || "Confirming location…"
    : me.locationLabel;

  const hits = inc
    ? GLANCE_KEYS.map((key) => inc.fields[key]).filter((f) => f.value)
    : [];

  // Fit campus into the visible map chrome — phone bottom sheet vs laptop side card.
  const mapPad = wide
    ? {
        padLeft: inc ? 400 : 24,
        padRight: 24,
        padTop: 64,
        padBottom: inc ? 24 : 120,
      }
    : {
        padLeft: 16,
        padRight: 16,
        padTop: 56,
        padBottom: inc ? (sheetOpen ? 260 : 128) : 108,
      };

  return (
    <div className={`dc ot ${fontClass}${inc ? " tasked" : ""}${sheetOpen ? " sheet-open" : ""}`} data-theme="dark" data-prio={priority ?? ""}>
      <div className="ot-stage">
        <ConsoleMap
          officers={state.officers}
          incident={inc}
          priority={priority}
          routes={routes}
          teamIds={[me.id]}
          theme="dark"
          fitKey={`patrol-${me.id}-${inc?.id ?? "idle"}-${wide ? "wide" : "phone"}-${sheetOpen ? "open" : "shut"}`}
          selectedOfficerId={me.id}
          incidents={inc ? [inc] : []}
          selectedIncidentId={inc?.id ?? null}
          assignedIncidentIds={inc ? [inc.id] : []}
          {...mapPad}
        />
      </div>

      <header className="ot-top">
        <Link href="/" className="ot-brand"><span>Onscene</span><small>Patrol</small></Link>
        <div className="ot-me">
          <b>{me.callsign}</b>
          <span className="ot-status" data-s={me.status}>{STATUS_LABEL[me.status]}</span>
        </div>
        <div className="ot-meta-row">
          <span className={`ot-pill${online ? " on" : ""}`}>{online ? "HQ" : "Off"}</span>
          <span className={`ot-pill${geoOk ? " on" : ""}`}>{geoOk ? "GPS" : geoOk === false ? "No GPS" : "…"}</span>
          <Link href="/officer" className="ot-pill">Unit</Link>
        </div>
      </header>

      {!inc && (
        <div className="ot-idle" role="group" aria-label="Unit status">
          <div className="ot-idle-main">
            <p className="ot-idle-where">{me.locationLabel}</p>
            <div className="ot-idle-acts">
              <button type="button" className={`ot-chip${me.status === "available" ? " on green" : ""}`} aria-pressed={me.status === "available"} onClick={() => setIdle("available")}>Free</button>
              <button type="button" className={`ot-chip${me.status === "busy" ? " on amber" : ""}`} aria-pressed={me.status === "busy"} onClick={() => setIdle("busy")}>Busy</button>
            </div>
          </div>
        </div>
      )}

      {inc && priority && assessment && asg && (
        <div className={`ot-sheet${sheetOpen ? " open" : ""}`} role="region" aria-label="Assignment">
          <button type="button" className="ot-sheet-handle" onClick={() => setSheetOpen((v) => !v)} aria-expanded={sheetOpen}>
            <i />
            <span className="ot-sheet-summary">
              <b>{PRIORITY_WORD[priority]}</b>
              <em>{inc.title.split(":")[0]}</em>
              <small>
                {!sheetOpen && etaLeft != null && me.status === "responding"
                  ? `ETA ${fmtClock(etaLeft * 1000)}`
                  : where}
              </small>
            </span>
          </button>

          <div className="ot-sheet-body">
            <div className="ot-alert" data-prio={priority}>
              <span className="ot-word">{PRIORITY_WORD[priority]}</span>
              <span className="ot-live"><i />HQ</span>
            </div>

            <div className="ot-glance">
              <h1>{inc.title.split(":")[0]}</h1>
              <p className="ot-where">{where}</p>
              <div className="ot-meta">
                <span>P{priority}</span>
                <span>{URGENCY_LABEL[assessment.urgency]}</span>
                {etaLeft != null && me.status === "responding" && <span>ETA {fmtClock(etaLeft * 1000)}</span>}
                {me.status === "on_scene" && <span>On scene</span>}
                <span className="mute">{inc.number}</span>
              </div>
              {hits.length > 0 && (
                <ul className="ot-hits">
                  {hits.slice(0, wide ? 4 : 3).map((f) => (
                    <li key={f.key} className={f.key === "weapons" || f.key === "hazards" ? "danger" : ""}>
                      <b>{FIELD_LABELS[f.key]}</b> {f.value}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {pendingUpdates.map((u) => (
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

            {(inc.mentionedPlaces ?? []).length > 0 && (
              <section className="ot-sec">
                <h2>Also mentioned (pinned on map)</h2>
                <p>{(inc.mentionedPlaces ?? []).map((p) => p.name).join(", ")}</p>
              </section>
            )}

            {queuedJobs.length > 0 && (
              <p className="ot-queue" role="status">
                Next after clear · {queuedJobs.map((j) => `${j.priorityDecision?.priority != null ? `P${j.priorityDecision.priority} ` : ""}${j.title.split(":")[0]}`).join(" · ")}
              </p>
            )}

            {myBackup && (
              <p className={`ot-backup ${myBackup.status}`} role="status">
                {myBackup.status === "open" ? "Backup request live at HQ." : "HQ acknowledged backup."}
              </p>
            )}
          </div>

          <div className="ot-sheet-foot">
            <Actions
              me={me}
              acknowledged={!!asg.acknowledgedAt}
              arrived={!!trip?.done || me.status === "on_scene"}
              etaLeft={etaLeft}
              backup={myBackup}
              compact={!sheetOpen && !wide}
              onAck={() => act({ type: "ACK_ASSIGNMENT", at: stamp(), assignmentId: asg.id })}
              onArrive={() => act({ type: "OFFICER_STATUS", at: stamp(), officerId: me.id, status: "on_scene" })}
              onClear={() => (inc
                ? act({ type: "CLEAR_SCENE", at: stamp(), incidentId: inc.id, officerId: me.id })
                : act({ type: "OFFICER_STATUS", at: stamp(), officerId: me.id, status: "available" }))}
              onBackup={requestBackup}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function Actions({ me, acknowledged, arrived, etaLeft, backup, compact, onAck, onArrive, onClear, onBackup }: {
  me: Officer;
  acknowledged: boolean;
  arrived: boolean;
  etaLeft: number | null;
  backup: BackupRequest | null;
  compact?: boolean;
  onAck: () => void;
  onArrive: () => void;
  onClear: () => void;
  onBackup: () => void;
}) {
  const backupLabel = !backup ? "Request backup" : backup.status === "open" ? "Backup pending" : "Backup acked";
  const backupBusy = !!backup;

  if (me.status === "on_scene") {
    return (
      <div className="ot-actions">
        {!compact && <button type="button" className="ot-btn danger" onClick={onBackup} disabled={backupBusy}>{backupLabel}</button>}
        <button type="button" className="ot-btn primary" onClick={onClear} title="Resolves the case at HQ and frees every officer on it">
          Scene clear · resolve case
        </button>
      </div>
    );
  }

  if (!acknowledged) {
    return (
      <div className="ot-actions">
        {!compact && (
          <p className="ot-step">
            Acknowledge to start response
            {etaLeft != null ? ` · ~${fmtClock(etaLeft * 1000)}` : ""}
          </p>
        )}
        <button type="button" className="ot-btn primary" onClick={onAck} autoFocus>Acknowledge</button>
        {!compact && <button type="button" className="ot-btn danger" onClick={onBackup} disabled={backupBusy}>{backupLabel}</button>}
      </div>
    );
  }

  return (
    <div className="ot-actions">
      {!compact && (
        <p className="ot-step">
          {arrived ? "At location — mark on scene" : `En route · ETA ${etaLeft != null ? fmtClock(etaLeft * 1000) : "--:--"}`}
        </p>
      )}
      <button type="button" className={`ot-btn${arrived ? " primary" : ""}`} onClick={onArrive}>On scene</button>
      {!compact && <button type="button" className="ot-btn danger" onClick={onBackup} disabled={backupBusy}>{backupLabel}</button>}
    </div>
  );
}

function UnitTaken({ officer, fontClass }: { officer: Officer; fontClass: string }) {
  return (
    <div className={`dc ot ot-pick-screen ${fontClass}`} data-theme="dark">
      <header className="ot-top">
        <Link href="/" className="ot-brand"><span>Onscene</span><small>Patrol</small></Link>
      </header>
      <main className="ot-pick">
        <h1>{officer.callsign} is already signed in</h1>
        <p>
          {officer.name} is in use on another device. Only one device can be a patrol officer at a time.
          This screen takes over on its own if that device closes.
        </p>
        <a href="/officer" className="ot-pick-btn ot-pick-back"><b>Choose another officer</b></a>
      </main>
    </div>
  );
}

function Picker({ officers, inUse, fontClass }: { officers: Officer[]; inUse: Set<string>; fontClass: string }) {
  return (
    <div className={`dc ot ot-pick-screen ${fontClass}`} data-theme="dark">
      <header className="ot-top">
        <Link href="/" className="ot-brand"><span>Onscene</span><small>Patrol</small></Link>
      </header>
      <main className="ot-pick">
        <h1>Select officer</h1>
        <p>Same network as HQ. Status and GPS sync automatically.</p>
        <ul>
          {officers.map((o) => (
            <li key={o.id}>
              {inUse.has(o.id) ? (
                <div className="ot-pick-btn in-use" aria-disabled="true">
                  <b>{o.callsign}</b>
                  <span>{o.name}</span>
                  <small>In use on another device</small>
                </div>
              ) : (
              <a href={`/officer?unit=${encodeURIComponent(o.id)}`} className="ot-pick-btn">
                <b>{o.callsign}</b>
                <span>{o.name}</span>
                <small>
                  #{o.badge}
                  {" · "}
                  {o.mode === "foot" ? "foot" : "car"}
                  {" · "}
                  {STATUS_LABEL[o.status]}
                  {o.locationLabel.includes("HQ") ? " · HQ" : ""}
                </small>
              </a>
              )}
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}
