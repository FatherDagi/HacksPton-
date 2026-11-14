"use client";
import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { formatEta, formatMiles, planRoute } from "@/lib/recommend";
import { act, newId } from "@/lib/store";
import type { DispatchAssignment, Incident, Officer, Recommendation } from "@/lib/types";
import { Button, OfficerStatusBadge, PanelHeader, cx } from "../ui";

export function UnitsPanel({
  incident,
  officers,
  recs,
  assignment,
}: {
  incident: Incident | null;
  officers: Officer[];
  recs: Recommendation[];
  assignment: DispatchAssignment | null;
}) {
  const [confirming, setConfirming] = useState(false);
  const top = recs[0] ?? null;
  const assignedOfficer = assignment ? officers.find((o) => o.id === assignment.officerId) ?? null : null;
  const rows = incident
    ? officers
        .map((o) => ({ o, plan: planRoute(o.location, incident.location, o.mode) }))
        .sort((a, b) => a.plan.etaSeconds - b.plan.etaSeconds)
    : officers.map((o) => ({ o, plan: null }));

  return (
    <section aria-label="Response units" className="flex min-h-0 flex-1 flex-col">
      {/* Recommendation */}
      <div className="shrink-0 border-b border-line px-3 py-2.5">
        {!incident ? (
          <p className="text-[13px] text-faint">Unit recommendations appear once a call starts.</p>
        ) : assignedOfficer && assignment ? (
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-[#8fb6f5]">Assigned</p>
            <p className="mt-0.5 text-[14px] font-semibold">
              {assignedOfficer.callsign} · {assignedOfficer.name} <span className="font-normal text-sub">#{assignedOfficer.badge}</span>
            </p>
            <div className="mt-1 flex items-center gap-3 text-[12.5px]">
              <OfficerStatusBadge status={assignedOfficer.status} />
              <span className="text-sub">{assignment.acknowledgedAt ? "Acknowledged on officer page" : "Waiting for officer to acknowledge"}</span>
            </div>
            <Link href={`/officer?unit=${assignedOfficer.id}`} target="_blank" className="mt-1.5 inline-flex items-center gap-1 text-[12.5px] text-[#8fb6f5] hover:underline">
              Open {assignedOfficer.callsign} officer page <ExternalLink size={12} />
            </Link>
          </div>
        ) : top ? (
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-sub">Recommended unit · {recs.length} eligible</p>
            <p className="mt-0.5 text-[14px] font-semibold">
              {top.officer.callsign} is available, {formatEta(top.etaSeconds)} away. Recommend assignment?
            </p>
            <p className="mt-0.5 text-[12px] leading-snug text-sub">{top.reason}</p>
            {confirming ? (
              <div className="mt-2 flex flex-wrap items-center gap-2 rounded-[2px] border border-accent/50 bg-accent/10 p-2">
                <span className="text-[12.5px]">Assign {top.officer.callsign} to incident {incident.number}?</span>
                <Button size="sm" variant="primary"
                  onClick={() => {
                    act({ type: "APPROVE_ASSIGNMENT", at: Date.now(), incidentId: incident.id, officerId: top.officer.id, assignmentId: newId("asg"), etaSeconds: top.etaSeconds });
                    setConfirming(false);
                  }}>
                  Yes, assign
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
              </div>
            ) : (
              <div className="mt-2 flex gap-2">
                <Button variant="primary" onClick={() => setConfirming(true)}>Approve assignment</Button>
                <Button onClick={() => act({ type: "DECLINE_UNIT", at: Date.now(), incidentId: incident.id, officerId: top.officer.id })}>Decline</Button>
              </div>
            )}
          </div>
        ) : (
          <div>
            <p className="text-[13px]">No eligible available units.</p>
            {incident.declinedOfficerIds.length > 0 && (
              <Button size="sm" className="mt-1.5" onClick={() => act({ type: "RESET_DECLINES", at: Date.now(), incidentId: incident.id })}>
                Reconsider {incident.declinedOfficerIds.length} declined unit{incident.declinedOfficerIds.length > 1 ? "s" : ""}
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Unit list */}
      <PanelHeader title="Units" right={<span className="text-[10px] text-faint">ETAs simulated</span>} />
      <ul className="panel-scroll min-h-0 flex-1 divide-y divide-line overflow-y-auto">
        {rows.map(({ o, plan }) => (
          <li key={o.id} className={cx("grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 px-3 py-1.5", top?.officer.id === o.id && !assignment && "bg-accent/10")}>
            <div className="min-w-0">
              <p className="truncate text-[13px]">
                <span className="font-mono font-semibold">{o.callsign}</span> <span className="text-sub">{o.name}</span>
              </p>
              <p className="truncate text-[11.5px] text-faint">
                {o.type.toUpperCase()} · {o.busyWith ?? o.locationLabel}
              </p>
            </div>
            <div className="text-right">
              <OfficerStatusBadge status={o.status} />
              {plan && (o.status === "available") && (
                <p className="font-mono text-[11px] text-sub">{formatEta(plan.etaSeconds)} · {formatMiles(plan.distanceMeters)}</p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
