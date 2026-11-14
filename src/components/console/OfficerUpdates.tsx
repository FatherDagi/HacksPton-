"use client";
// Officer communication for the combined console: what each sent unit knows, what changed since,
// and dispatcher-approved updates. Nothing is sent automatically.
import { useState } from "react";
import { officerSnapshot, pendingChanges, SAFETY_KEYS } from "@/lib/officerComms";
import { act, newId, stamp } from "@/lib/store";
import type { DispatchAssignment, Incident, Officer, OfficerUpdate } from "@/lib/types";
import { fmtTime } from "../ui";

const STATUS: Record<Officer["status"], string> = { available: "Available", busy: "Busy", responding: "Responding", on_scene: "On scene" };

function UnitComms({ incident, assignment, officer, updates }: { incident: Incident; assignment: DispatchAssignment; officer: Officer; updates: OfficerUpdate[] }) {
  const [confirming, setConfirming] = useState(false);
  const changes = pendingChanges(incident, assignment.sentSnapshot);
  const safety = changes.some((c) => SAFETY_KEYS.has(c.key));
  const last = updates.at(-1) ?? null;

  const send = () => {
    act({ type: "SEND_OFFICER_UPDATE", at: stamp(), assignmentId: assignment.id, updateId: newId("upd"), changes, snapshot: officerSnapshot(incident) });
    setConfirming(false);
  };

  return (
    <div className="dc-comms" aria-label={`Communication with ${officer.callsign}`}>
      <h3>Officer communication · {officer.callsign}</h3>
      <dl>
        <dt>Assigned unit</dt><dd><b>{officer.callsign}</b> {officer.name} #{officer.badge}</dd>
        <dt>Officer status</dt><dd>{STATUS[officer.status]}</dd>
        <dt>Dispatched</dt><dd>{fmtTime(assignment.approvedAt)}</dd>
        <dt>Acknowledged</dt>
        <dd>{assignment.acknowledgedAt ? <span className="ok">Yes, {fmtTime(assignment.acknowledgedAt)}</span> : <span className="wait">Awaiting officer</span>}</dd>
        <dt>Last update sent</dt>
        <dd>
          {last ? (
            <>{fmtTime(last.sentAt)} {last.status === "acknowledged" ? <span className="ok">· acknowledged</span> : <span className="wait">· not yet acknowledged</span>}</>
          ) : (
            <span style={{ color: "var(--faint)" }}>None since dispatch</span>
          )}
        </dd>
      </dl>

      <div className={`dc-pending${changes.length ? (safety ? " has safety" : " has") : ""}`}>
        <div className="dc-pending-head">
          <span>Pending updates{changes.length ? ` (${changes.length})` : ""}</span>
          {changes.length > 0 && !confirming && (
            <button type="button" className="dc-btn sm primary" onClick={() => setConfirming(true)}>Review &amp; send</button>
          )}
        </div>
        {changes.length === 0 ? (
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--faint)" }}>The officer has the latest details.</p>
        ) : (
          <ul>
            {changes.map((c) => (
              <li key={c.key}>
                <span className={`k${SAFETY_KEYS.has(c.key) ? " safe" : ""}`}>{c.label}:</span> {c.from && <s>{c.from}</s>}{c.to}
              </li>
            ))}
          </ul>
        )}
        {confirming && (
          <div className="dc-confirm">
            <span>Send {changes.length} change{changes.length > 1 ? "s" : ""} to {officer.callsign}&apos;s terminal?</span>
            <button type="button" className="dc-btn sm primary" onClick={send}>Yes, send</button>
            <button type="button" className="dc-btn sm ghost" onClick={() => setConfirming(false)}>Cancel</button>
          </div>
        )}
      </div>
    </div>
  );
}

export function OfficerUpdates({ incident, assigned, updates }: { incident: Incident; assigned: { a: DispatchAssignment; o: Officer }[]; updates: OfficerUpdate[] }) {
  return (
    <>
      {assigned.map(({ a, o }) => (
        <UnitComms key={a.id} incident={incident} assignment={a} officer={o} updates={updates.filter((u) => u.assignmentId === a.id)} />
      ))}
    </>
  );
}
