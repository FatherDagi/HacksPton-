"use client";
// Officer communication for the combined console: what each sent unit has been told.
// New critical details are pushed to the unit's patrol terminal automatically (see autoSendUpdates
// in the reducer); the officer acknowledges each update.
import { SAFETY_KEYS } from "@/lib/officerComms";
import type { DispatchAssignment, Officer, OfficerUpdate } from "@/lib/types";
import { fmtTime } from "../ui";

const STATUS: Record<Officer["status"], string> = { available: "Available", busy: "Busy", responding: "Responding", on_scene: "On scene" };

function UnitComms({ assignment, officer, updates }: { assignment: DispatchAssignment; officer: Officer; updates: OfficerUpdate[] }) {
  const unread = updates.filter((u) => u.status === "sent").length;
  const recent = [...updates].reverse().slice(0, 4);

  return (
    <div className="dc-comms" aria-label={`Communication with ${officer.callsign}`}>
      <h3>Officer communication · {officer.callsign}</h3>
      <dl>
        <dt>Assigned unit</dt><dd><b>{officer.callsign}</b> {officer.name} #{officer.badge}</dd>
        <dt>Officer status</dt><dd>{STATUS[officer.status]}</dd>
        <dt>Dispatched</dt><dd>{fmtTime(assignment.approvedAt)}</dd>
        <dt>Acknowledged</dt>
        <dd>{assignment.acknowledgedAt ? <span className="ok">Yes, {fmtTime(assignment.acknowledgedAt)}</span> : <span className="wait">Awaiting officer</span>}</dd>
        <dt>Updates sent</dt>
        <dd>
          {updates.length === 0 ? <span style={{ color: "var(--faint)" }}>None since dispatch</span>
            : unread ? <span className="wait">{updates.length} sent · {unread} not yet acknowledged</span>
            : <span className="ok">{updates.length} sent · all acknowledged</span>}
        </dd>
      </dl>

      <div className={`dc-pending${unread ? " has" : ""}`}>
        <div className="dc-pending-head"><span>Live updates to terminal</span><span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>sent automatically</span></div>
        {recent.length === 0 ? (
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--faint)" }}>New critical details are sent to {officer.callsign} as soon as they come in.</p>
        ) : (
          <ul>
            {recent.map((u) => (
              <li key={u.id}>
                <span style={{ color: "var(--faint)" }}>{fmtTime(u.sentAt)}</span>{" "}
                {u.changes.map((c, i) => (
                  <span key={c.key}>
                    {i > 0 && "; "}
                    <span className={`k${SAFETY_KEYS.has(c.key) ? " safe" : ""}`}>{c.label}:</span> {c.to}
                  </span>
                ))}{" "}
                <span className={u.status === "acknowledged" ? "ok" : "wait"}>· {u.status === "acknowledged" ? "acknowledged" : "unread"}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function OfficerUpdates({ assigned, updates }: { assigned: { a: DispatchAssignment; o: Officer }[]; updates: OfficerUpdate[] }) {
  return (
    <>
      {assigned.map(({ a, o }) => (
        <UnitComms key={a.id} assignment={a} officer={o} updates={updates.filter((u) => u.assignmentId === a.id)} />
      ))}
    </>
  );
}
