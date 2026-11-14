"use client";
import { Pencil, Quote } from "lucide-react";
import { useState } from "react";
import { FIELD_LABELS } from "@/lib/fields";
import { assessPriority, URGENCY_LABEL } from "@/lib/priority";
import { act } from "@/lib/store";
import type { FieldKey, Incident, Priority } from "@/lib/types";
import { Button, FieldStatusBadge, PriorityChip, cx, fmtTime } from "../ui";

export function FieldRow({ incident, k }: { incident: Incident; k: FieldKey }) {
  const f = incident.fields[k];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [showEvidence, setShowEvidence] = useState(false);
  const evidence = f.evidenceSegmentId ? incident.transcript.find((s) => s.id === f.evidenceSegmentId) : null;

  const save = () => {
    act({ type: "EDIT_FIELD", at: Date.now(), incidentId: incident.id, key: k, value: draft.trim(), status: "confirmed" });
    setEditing(false);
  };

  return (
    <div className="border-b border-line py-1.5">
      <div className="grid grid-cols-[118px_minmax(0,1fr)_auto] items-start gap-2">
        <span className="pt-0.5 text-[12.5px] text-sub">{FIELD_LABELS[k]}</span>
        {editing ? (
          <form
            className="flex gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <label className="sr-only" htmlFor={`f-${k}`}>{FIELD_LABELS[k]}</label>
            <input
              id={`f-${k}`}
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setEditing(false)}
              className="h-7 min-w-0 flex-1 rounded-[2px] border border-line2 bg-bg px-2 text-[13px] text-ink"
            />
            <Button size="sm" variant="primary" type="submit">Save</Button>
          </form>
        ) : (
          <button
            type="button"
            disabled={!evidence}
            onClick={() => setShowEvidence((v) => !v)}
            className={cx("text-left text-[13.5px] leading-snug", f.value ? "text-ink" : "italic text-faint", evidence && "hover:underline decoration-line2 underline-offset-2")}
            title={evidence ? "Show the transcript line behind this value" : undefined}
          >
            {f.value ?? "Unknown"}
            {f.source === "dispatcher" && <span className="ml-1.5 text-[10px] not-italic text-faint">(dispatcher)</span>}
          </button>
        )}
        <div className="flex items-center gap-1">
          <FieldStatusBadge status={f.status} />
          {f.status === "unverified" && !editing && (
            <Button size="sm" variant="ghost" className="h-5 px-1 text-[11px] text-[#8fb6f5]" aria-label={`Confirm ${FIELD_LABELS[k]}`}
              onClick={() => act({ type: "EDIT_FIELD", at: Date.now(), incidentId: incident.id, key: k, value: f.value ?? "", status: "confirmed" })}>
              Confirm
            </Button>
          )}
          {!editing && (
            <Button size="sm" variant="ghost" className="h-5 px-1" aria-label={`Edit ${FIELD_LABELS[k]}`}
              onClick={() => { setDraft(f.value ?? ""); setEditing(true); }}>
              <Pencil size={12} />
            </Button>
          )}
        </div>
      </div>
      {showEvidence && evidence && (
        <p className="ml-[126px] mt-1 flex gap-1.5 text-[12px] leading-snug text-sub">
          <Quote size={12} className="mt-0.5 shrink-0 text-faint" aria-hidden />
          <span>
            <span className="font-semibold">{evidence.speaker === "caller" ? "Caller" : "Dispatcher"}:</span> “{evidence.text}”
            {f.updatedAt && <span className="ml-1 font-mono text-[10.5px] text-faint">{fmtTime(f.updatedAt)}</span>}
          </span>
        </p>
      )}
    </div>
  );
}

export function PriorityBlock({ incident }: { incident: Incident }) {
  const a = assessPriority(incident.category, incident.fields);
  const d = incident.priorityDecision;
  const [overriding, setOverriding] = useState(false);
  const [choice, setChoice] = useState<Priority>(a.proposed);
  const [reason, setReason] = useState("");

  return (
    <div className="border-b border-line bg-panel2/40 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-sub">Proposed priority</span>
          <PriorityChip p={a.proposed} />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-sub">Urgency</span>
          <span className="text-[13px] font-semibold">{URGENCY_LABEL[a.urgency]}</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {d ? (
            <span className="flex items-center gap-2 text-[12.5px]">
              <PriorityChip p={d.priority} />
              <span className="text-sub">{d.overrideReason ? `Overridden: ${d.overrideReason}` : "Confirmed by dispatcher"}</span>
              <Button size="sm" variant="ghost" onClick={() => { setChoice(d.priority); setOverriding(true); }}>Change</Button>
            </span>
          ) : (
            <>
              <Button size="sm" variant="primary" onClick={() => act({ type: "DECIDE_PRIORITY", at: Date.now(), incidentId: incident.id, priority: a.proposed, proposed: a.proposed, overrideReason: null })}>
                Confirm P{a.proposed}
              </Button>
              <Button size="sm" onClick={() => { setChoice(a.proposed); setOverriding(true); }}>Override</Button>
            </>
          )}
        </div>
      </div>
      <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-sub">
        {a.reasons.map((r) => <li key={r}>• {r}</li>)}
      </ul>
      <p className="mt-1 text-[10.5px] text-faint">Provisional assessment from transparent demo rules. Not a certified dispatch protocol; dispatcher decides.</p>

      {overriding && (
        <form
          className="mt-2 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (choice !== a.proposed && !reason.trim()) return;
            act({ type: "DECIDE_PRIORITY", at: Date.now(), incidentId: incident.id, priority: choice, proposed: a.proposed, overrideReason: choice === a.proposed ? null : reason.trim() });
            setOverriding(false);
            setReason("");
          }}
        >
          <div role="radiogroup" aria-label="Priority" className="flex border border-line2">
            {([1, 2, 3, 4] as Priority[]).map((p) => (
              <button key={p} type="button" role="radio" aria-checked={choice === p} onClick={() => setChoice(p)}
                className={cx("h-7 w-9 border-l border-line2 font-mono text-xs first:border-l-0", choice === p ? "bg-accent-strong text-white" : "bg-bg text-sub")}>
                P{p}
              </button>
            ))}
          </div>
          <label className="sr-only" htmlFor="override-reason">Reason</label>
          <input id="override-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={choice === a.proposed ? "Reason (optional)" : "Reason (required)"}
            className="h-7 min-w-[180px] flex-1 rounded-[2px] border border-line2 bg-bg px-2 text-[13px]" />
          <Button size="sm" variant="primary" type="submit" disabled={choice !== a.proposed && !reason.trim()}>Save</Button>
          <Button size="sm" variant="ghost" onClick={() => setOverriding(false)}>Cancel</Button>
        </form>
      )}
    </div>
  );
}

/** Field groups shown in the permanent incident panel, in the order a dispatcher scans them. */
export const PANEL_SECTIONS: { title: string; keys: FieldKey[] }[] = [
  { title: "Caller", keys: ["caller_name", "callback", "caller_location", "caller_safe"] },
  { title: "Patient / victim", keys: ["people_count", "condition", "conscious", "breathing"] },
  { title: "Scene", keys: ["hazards", "weapons", "suspect", "access", "notes"] },
  { title: "Location detail", keys: ["building", "address", "floor", "room", "location_details"] },
  { title: "Incident", keys: ["category", "description"] },
];
