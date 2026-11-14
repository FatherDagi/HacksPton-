"use client";
import { AlertTriangle, Send } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { officerSnapshot, pendingChanges, SAFETY_KEYS } from "@/lib/officerComms";
import { act, newId, stamp } from "@/lib/store";
import type { DispatchAssignment, Incident, Officer, OfficerUpdate } from "@/lib/types";
import { Button, OfficerStatusBadge, cx, fmtTime } from "../ui";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[112px_minmax(0,1fr)] items-baseline gap-2 py-1">
      <span className="text-[12px] text-sub">{label}</span>
      <span className="text-[13px]">{children}</span>
    </div>
  );
}

/**
 * What the assigned officer knows, and what changed since. Changes are only ever
 * sent after the dispatcher reviews and approves them.
 */
export function OfficerComms({
  incident,
  assignment,
  officer,
  updates,
}: {
  incident: Incident;
  assignment: DispatchAssignment;
  officer: Officer;
  updates: OfficerUpdate[];
}) {
  const [confirming, setConfirming] = useState(false);
  const changes = pendingChanges(incident, assignment.sentSnapshot);
  const lastSent = updates.at(-1) ?? null;
  const safety = changes.some((c) => SAFETY_KEYS.has(c.key));

  const send = () => {
    act({ type: "SEND_OFFICER_UPDATE", at: stamp(), assignmentId: assignment.id, updateId: newId("upd"), changes, snapshot: officerSnapshot(incident) });
    setConfirming(false);
  };

  return (
    <div>
      <Row label="Assigned unit">
        <span className="font-mono font-semibold">{officer.callsign}</span> <span className="text-sub">{officer.name} #{officer.badge}</span>
      </Row>
      <Row label="Officer status"><OfficerStatusBadge status={officer.status} /></Row>
      <Row label="Dispatched"><span className="font-mono text-[12.5px]">{fmtTime(assignment.approvedAt)}</span></Row>
      <Row label="Acknowledged">
        {assignment.acknowledgedAt ? (
          <span className="text-[#7fd7aa]">Yes, <span className="font-mono text-[12.5px]">{fmtTime(assignment.acknowledgedAt)}</span></span>
        ) : (
          <span className="text-[#f2b67a]">Awaiting officer</span>
        )}
      </Row>
      <Row label="Last update sent">
        {lastSent ? (
          <span>
            <span className="font-mono text-[12.5px]">{fmtTime(lastSent.sentAt)}</span>{" "}
            {lastSent.status === "acknowledged" ? <span className="text-[#7fd7aa]">· acknowledged</span> : <span className="text-[#f2b67a]">· not yet acknowledged</span>}
          </span>
        ) : (
          <span className="text-faint">None since dispatch</span>
        )}
      </Row>

      {/* Pending updates: prepared automatically, sent only on dispatcher approval. */}
      <div className={cx("mt-2 rounded-[2px] border p-2", changes.length ? (safety ? "border-alert/50 bg-alert/10" : "border-warn/40 bg-warn/5") : "border-line")}>
        <div className="flex items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-sub">
            {safety && <AlertTriangle size={13} className="text-alert" aria-hidden />}
            Pending updates {changes.length > 0 && <span className="font-mono text-ink">({changes.length})</span>}
          </p>
          {changes.length > 0 && !confirming && (
            <Button size="sm" variant="primary" onClick={() => setConfirming(true)}>
              <Send size={12} /> Review &amp; send
            </Button>
          )}
        </div>
        {changes.length === 0 ? (
          <p className="mt-1 text-[12.5px] text-faint">The officer has the latest details.</p>
        ) : (
          <ul className="mt-1.5 flex flex-col gap-1">
            {changes.map((c) => (
              <li key={c.key} className="text-[12.5px] leading-snug">
                <span className={cx("font-semibold", SAFETY_KEYS.has(c.key) && "text-[#ffb3ad]")}>{c.label}:</span>{" "}
                {c.from && <span className="text-faint line-through">{c.from}</span>} <span>{c.to}</span>
              </li>
            ))}
          </ul>
        )}
        {confirming && (
          <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-line pt-2">
            <span className="text-[12.5px]">Send {changes.length} change{changes.length > 1 ? "s" : ""} to {officer.callsign}?</span>
            <Button size="sm" variant="primary" onClick={send}>Yes, send</Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
          </div>
        )}
      </div>

      {updates.length > 0 && (
        <details className="mt-2 text-[12px]">
          <summary className="cursor-pointer text-sub">Sent updates ({updates.length})</summary>
          <ol className="mt-1 flex flex-col gap-1">
            {[...updates].reverse().map((u) => (
              <li key={u.id} className="flex justify-between gap-2">
                <span className="truncate">
                  <span className="font-mono text-faint">{fmtTime(u.sentAt)}</span> {u.changes.map((c) => c.label).join(", ")}
                </span>
                <span className={u.status === "acknowledged" ? "shrink-0 text-[#7fd7aa]" : "shrink-0 text-[#f2b67a]"}>
                  {u.status === "acknowledged" ? "Ack'd" : "Unread"}
                </span>
              </li>
            ))}
          </ol>
        </details>
      )}
      <Link href={`/officer?unit=${officer.id}`} target="_blank" className="mt-2 inline-block text-[12px] text-[#8fb6f5] hover:underline">
        Open {officer.callsign} officer page ↗
      </Link>
    </div>
  );
}
