"use client";
import { MapPin, Navigation } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { buildingById } from "@/lib/campus";
import { FIELD_LABELS } from "@/lib/fields";
import { act, stamp, useAppState } from "@/lib/store";
import type { FieldKey, OfficerStatus } from "@/lib/types";
import { FieldStatusBadge, OFFICER_STATUS_COLOR, OFFICER_STATUS_LABEL, PriorityChip, SimBanner, cx, fmtTime } from "../ui";

const STATUSES: OfficerStatus[] = ["available", "busy", "responding", "on_scene"];
const SUMMARY_KEYS: FieldKey[] = ["description", "floor", "room", "location_details", "conscious", "breathing", "weapons", "hazards", "suspect", "access", "callback"];

export function OfficerView() {
  const params = useSearchParams();
  const unitId = params.get("unit");
  const state = useAppState();
  const officer = state.officers.find((o) => o.id === unitId) ?? null;
  const [geoMsg, setGeoMsg] = useState<string | null>(null);

  if (!officer) {
    return (
      <main className="mx-auto max-w-md p-4">
        <SimBanner />
        <h1 className="mt-3 text-xl font-bold">Officer sign-in (demo)</h1>
        <p className="mt-1 text-sm text-sub">Pick your unit. All units are fictional.</p>
        <ul className="mt-4 divide-y divide-line border border-line bg-panel">
          {state.officers.map((o) => (
            <li key={o.id}>
              <Link href={`/officer?unit=${o.id}`} className="flex items-center justify-between px-4 py-3 hover:bg-panel2">
                <span><span className="font-mono font-semibold">{o.callsign}</span> <span className="text-sub">{o.name}</span></span>
                <span className="text-xs font-semibold" style={{ color: OFFICER_STATUS_COLOR[o.status] }}>{OFFICER_STATUS_LABEL[o.status]}</span>
              </Link>
            </li>
          ))}
        </ul>
      </main>
    );
  }

  const incident = officer.currentIncidentId ? state.incidents.find((i) => i.id === officer.currentIncidentId) ?? null : null;
  const assignment = incident ? state.assignments.find((a) => a.incidentId === incident.id && a.officerId === officer.id && a.status === "active") : null;
  const building = incident ? buildingById(incident.buildingId) : null;
  const myUpdates = assignment ? (state.officerUpdates ?? []).filter((u) => u.assignmentId === assignment.id) : [];
  const unread = myUpdates.filter((u) => u.status === "sent");

  function setStatus(status: OfficerStatus) {
    act({ type: "OFFICER_STATUS", at: stamp(), officerId: officer!.id, status });
  }

  const shareLocation = () => {
    if (!("geolocation" in navigator)) return setGeoMsg("This browser cannot share location.");
    setGeoMsg("Waiting for permission…");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        act({ type: "OFFICER_LOCATION", at: Date.now(), officerId: officer.id, location: [pos.coords.latitude, pos.coords.longitude], label: "Device location (shared)" });
        setGeoMsg(`Shared at ${fmtTime(Date.now())}. Only sent when you press the button.`);
      },
      () => setGeoMsg("Location not shared. Simulated location stays in use."),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-3 p-3">
      <div className="flex items-center justify-between">
        <SimBanner />
        <Link href="/officer" className="text-xs text-sub hover:text-ink">Switch unit</Link>
      </div>

      <header className="border border-line bg-panel p-3">
        <p className="font-mono text-2xl font-bold">{officer.callsign}</p>
        <p className="text-sm text-sub">{officer.name} · Badge #{officer.badge}</p>
        <p className="mt-2 flex items-center gap-2 text-base font-semibold" style={{ color: OFFICER_STATUS_COLOR[officer.status] }}>
          <span className="h-3 w-3 rounded-[2px]" style={{ background: OFFICER_STATUS_COLOR[officer.status] }} aria-hidden />
          {OFFICER_STATUS_LABEL[officer.status]}
        </p>
      </header>

      <section aria-label="Current assignment" className={cx("border p-3", incident ? "border-accent/60 bg-accent/10" : "border-line bg-panel")}>
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-sub">Current assignment</h2>
        {!incident ? (
          <p className="mt-1 text-sm text-faint">No assignment. New calls appear here in real time.</p>
        ) : (
          <>
            <div className="mt-1 flex items-center gap-2">
              <span className="font-mono text-sm text-sub">{incident.number}</span>
              {incident.priorityDecision && <PriorityChip p={incident.priorityDecision.priority} />}
            </div>
            <p className="mt-1 text-lg font-semibold leading-snug">{incident.title}</p>
            <p className="mt-1 flex items-start gap-1.5 text-sm"><MapPin size={16} className="mt-0.5 shrink-0" /> {building?.name}{incident.fields.floor.value ? `, ${/floor/i.test(incident.fields.floor.value) ? "" : "floor "}${incident.fields.floor.value}` : ""}{incident.fields.room.value ? `, ${incident.fields.room.value}` : ""}</p>
            {assignment && <p className="mt-1 text-xs text-sub">Assigned {fmtTime(assignment.approvedAt)} · simulated ETA {Math.round(assignment.etaSeconds / 60)} min</p>}
            {assignment && !assignment.acknowledgedAt && (
              <button
                type="button"
                onClick={() => act({ type: "ACK_ASSIGNMENT", at: stamp(), assignmentId: assignment.id })}
                className="mt-2 h-12 w-full rounded-[3px] border-2 border-accent bg-accent-strong text-base font-semibold text-white"
              >
                Acknowledge assignment
              </button>
            )}
            {unread.map((u) => (
              <div key={u.id} role="alert" className="mt-3 border-2 border-warn bg-warn/10 p-3">
                <p className="text-[11px] font-bold uppercase tracking-wider text-[#f2b67a]">Update from dispatch · {fmtTime(u.sentAt)}</p>
                <ul className="mt-1 flex flex-col gap-1">
                  {u.changes.map((c) => (
                    <li key={c.key} className="text-[15px] leading-snug">
                      <span className="font-semibold">{c.label}:</span> {c.to}
                      {c.from && <span className="ml-1 text-xs text-faint line-through">{c.from}</span>}
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  onClick={() => act({ type: "ACK_OFFICER_UPDATE", at: stamp(), updateId: u.id })}
                  className="mt-2 h-12 w-full rounded-[3px] border-2 border-warn bg-warn text-base font-semibold text-bg"
                >
                  Acknowledge update
                </button>
              </div>
            ))}
            {myUpdates.length > unread.length && (
              <p className="mt-2 text-xs text-sub">{myUpdates.length - unread.length} earlier update{myUpdates.length - unread.length > 1 ? "s" : ""} acknowledged.</p>
            )}
            <a
              className="mt-2 inline-flex h-10 items-center gap-1.5 rounded-[3px] border border-line2 bg-panel2 px-3 text-sm"
              href={`https://www.openstreetmap.org/?mlat=${incident.location[0]}&mlon=${incident.location[1]}#map=18/${incident.location[0]}/${incident.location[1]}`}
              target="_blank" rel="noreferrer"
            >
              <Navigation size={15} /> Open map
            </a>
            <dl className="mt-3 divide-y divide-line border-t border-line">
              {SUMMARY_KEYS.filter((k) => incident.fields[k].value).map((k) => (
                <div key={k} className="flex items-start justify-between gap-2 py-1.5">
                  <dt className="w-28 shrink-0 text-xs text-sub">{FIELD_LABELS[k]}</dt>
                  <dd className="flex-1 text-sm">{incident.fields[k].value}</dd>
                  <FieldStatusBadge status={incident.fields[k].status} />
                </div>
              ))}
            </dl>
          </>
        )}
      </section>

      <section aria-label="Status" className="grid grid-cols-2 gap-2">
        {STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={officer.status === s}
            onClick={() => setStatus(s)}
            className={cx("h-14 rounded-[3px] border-2 text-base font-semibold", officer.status === s ? "text-bg" : "bg-panel text-ink")}
            style={{ borderColor: OFFICER_STATUS_COLOR[s], background: officer.status === s ? OFFICER_STATUS_COLOR[s] : undefined }}
          >
            {OFFICER_STATUS_LABEL[s]}
          </button>
        ))}
      </section>

      <section aria-label="Location" className="border border-line bg-panel p-3 text-sm">
        <p><span className="text-sub">Location:</span> {officer.locationLabel} <span className="text-faint">(simulated unless shared)</span></p>
        <button type="button" onClick={shareLocation} className="mt-2 h-10 rounded-[3px] border border-line2 bg-panel2 px-3 text-sm">
          Share my device location once
        </button>
        {geoMsg && <p className="mt-1 text-xs text-sub">{geoMsg}</p>}
      </section>
      <p className="text-center text-[11px] text-faint">Syncs with the dispatcher tab in this browser. Cross-device sync arrives with Supabase.</p>
    </main>
  );
}
