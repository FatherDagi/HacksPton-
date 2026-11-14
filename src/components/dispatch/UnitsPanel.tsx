"use client";
import { useState } from "react";
import { formatEta, formatMiles, planRoute } from "@/lib/recommend";
import { act, newId, stamp } from "@/lib/store";
import type { DispatchAssignment, Incident, Officer, Recommendation } from "@/lib/types";
import { Button, OfficerStatusBadge, cx } from "../ui";

/** Top-ranked eligible unit with dispatcher approval controls. The AI never assigns on its own. */
export function RecommendationCard({ incident, recs }: { incident: Incident; recs: Recommendation[] }) {
  const [confirming, setConfirming] = useState(false);
  const top = recs[0] ?? null;

  if (!top) {
    return (
      <div>
        <p className="text-[13px]">No eligible available units.</p>
        {incident.declinedOfficerIds.length > 0 && (
          <Button size="sm" className="mt-1.5" onClick={() => act({ type: "RESET_DECLINES", at: stamp(), incidentId: incident.id })}>
            Reconsider {incident.declinedOfficerIds.length} declined unit{incident.declinedOfficerIds.length > 1 ? "s" : ""}
          </Button>
        )}
      </div>
    );
  }
  return (
    <div>
      <p className="text-[14px] font-semibold leading-snug">
        {top.officer.callsign} is available, {formatEta(top.etaSeconds)} away. Recommend assignment?
      </p>
      <p className="mt-0.5 text-[12px] leading-snug text-sub">{top.reason}</p>
      <p className="mt-0.5 text-[11px] text-faint">{recs.length} eligible · option {incident.declinedOfficerIds.length + 1}</p>
      {confirming ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-[2px] border border-accent/50 bg-accent/10 p-2">
          <span className="text-[12.5px]">Assign {top.officer.callsign} to {incident.number}?</span>
          <Button size="sm" variant="primary"
            onClick={() => {
              act({ type: "APPROVE_ASSIGNMENT", at: stamp(), incidentId: incident.id, officerId: top.officer.id, assignmentId: newId("asg"), etaSeconds: top.etaSeconds });
              setConfirming(false);
            }}>
            Yes, assign
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
        </div>
      ) : (
        <div className="mt-2 flex gap-2">
          <Button variant="primary" onClick={() => setConfirming(true)}>Approve assignment</Button>
          <Button onClick={() => act({ type: "DECLINE_UNIT", at: stamp(), incidentId: incident.id, officerId: top.officer.id })}>Decline</Button>
        </div>
      )}
    </div>
  );
}

/** Compact list of all units, nearest first. */
export function UnitsList({
  incident,
  officers,
  highlightId,
  assignment,
}: {
  incident: Incident | null;
  officers: Officer[];
  highlightId: string | null;
  assignment: DispatchAssignment | null;
}) {
  const rows = incident
    ? officers.map((o) => ({ o, plan: planRoute(o.location, incident.location, o.mode) })).sort((a, b) => a.plan.etaSeconds - b.plan.etaSeconds)
    : officers.map((o) => ({ o, plan: null }));
  return (
    <ul className="divide-y divide-line">
      {rows.map(({ o, plan }) => (
        <li key={o.id} className={cx("grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 py-1.5", highlightId === o.id && !assignment && "bg-accent/10")}>
          <div className="min-w-0">
            <p className="truncate text-[12.5px]">
              <span className="font-mono font-semibold">{o.callsign}</span> <span className="text-sub">{o.name}</span>
            </p>
            <p className="truncate text-[11px] text-faint">{o.type.toUpperCase()} · {o.busyWith ?? o.locationLabel}</p>
          </div>
          <div className="text-right">
            <OfficerStatusBadge status={o.status} />
            {plan && o.status === "available" && (
              <p className="font-mono text-[10.5px] text-sub">{formatEta(plan.etaSeconds)} · {formatMiles(plan.distanceMeters)}</p>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
