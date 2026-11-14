"use client";
import { AlertTriangle, MapPin } from "lucide-react";
import { CHECKLISTS, FIELD_LABELS } from "@/lib/fields";
import type { DispatchAssignment, FieldKey, Incident, Officer, OfficerUpdate, Recommendation } from "@/lib/types";
import { cx } from "../ui";
import { FieldRow, PANEL_SECTIONS, PriorityBlock } from "./IncidentSheet";
import { OfficerComms } from "./OfficerComms";
import { RecommendationCard, UnitsList } from "./UnitsPanel";

function Section({ title, right, children, className }: { title: string; right?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cx("border-b border-line px-3 py-2.5", className)}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8fb6f5]">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

function confirmedLocation(i: Incident) {
  const parts: { text: string; confirmed: boolean }[] = [];
  const add = (k: FieldKey, prefix = "") => {
    const f = i.fields[k];
    if (f.value) parts.push({ text: /floor/i.test(f.value) ? f.value : prefix + f.value, confirmed: f.status === "confirmed" });
  };
  add("building");
  add("floor", "Floor ");
  add("room");
  add("location_details");
  return parts;
}

/** Permanent right-hand panel: everything a dispatcher must see without opening anything. */
export function IncidentPanel({
  incident,
  live,
  clock,
  recs,
  assignment,
  assignedOfficer,
  officers,
  officerUpdates,
  highlightId,
  onOpenQuestions,
}: {
  incident: Incident | null;
  live: boolean;
  clock: string;
  recs: Recommendation[];
  assignment: DispatchAssignment | null;
  assignedOfficer: Officer | null;
  officers: Officer[];
  officerUpdates: OfficerUpdate[];
  highlightId: string | null;
  onOpenQuestions: () => void;
}) {
  if (!incident) {
    return (
      <aside aria-label="Incident" className="flex min-h-0 flex-col border-l border-line bg-panel">
        <div className="flex h-9 shrink-0 items-center border-b border-line bg-panel2/60 px-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-sub">Incident</h2>
        </div>
        <p className="px-4 py-8 text-center text-sm text-faint">No active incident. Choose a scenario and press Run demo scenario.</p>
        <div className="panel-scroll min-h-0 flex-1 overflow-y-auto border-t border-line px-3 py-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-sub">Units</h3>
          <UnitsList incident={null} officers={officers} highlightId={null} assignment={null} />
        </div>
      </aside>
    );
  }

  const loc = confirmedLocation(incident);
  const locConfirmed = loc.length > 0 && loc.every((p) => p.confirmed);
  const missing = CHECKLISTS[incident.category].map((q) => q.fieldKey).filter((k) => incident.fields[k].status === "unknown");
  const typeLabel = incident.fields.category.value ?? incident.category[0].toUpperCase() + incident.category.slice(1);

  return (
    <aside aria-label="Critical incident information" className="flex min-h-0 flex-col border-l border-line bg-panel">
      {/* Identity strip (fixed) */}
      <div className="shrink-0 border-b border-line bg-panel2/60 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[13px] font-semibold">{incident.number}</span>
          <span className="rounded-[2px] border border-line2 px-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-sub">
            {incident.status.replace("_", " ")}
          </span>
          <span className={cx("ml-auto font-mono text-[12px]", live ? "text-[#ffb3ad]" : "text-faint")}>{live ? `● ${clock}` : clock}</span>
        </div>
        <p className="mt-0.5 truncate text-[13.5px] font-semibold">{typeLabel}<span className="font-normal text-sub"> · {incident.fields.description.value ?? incident.title}</span></p>
        <p className="mt-0.5 flex items-start gap-1.5 text-[12.5px]">
          <MapPin size={13} className="mt-0.5 shrink-0 text-faint" aria-hidden />
          {loc.length ? (
            <span>
              {loc.map((p) => p.text).join(", ")}{" "}
              <span className={locConfirmed ? "text-[#7fd7aa]" : "text-[#f2b67a]"}>({locConfirmed ? "confirmed" : "not yet confirmed"})</span>
            </span>
          ) : (
            <span className="italic text-faint">Location unknown</span>
          )}
        </p>
      </div>

      <div className="panel-scroll min-h-0 flex-1 overflow-y-auto">
        <PriorityBlock incident={incident} />

        {/* Missing critical information */}
        <button
          type="button"
          onClick={onOpenQuestions}
          className={cx(
            "flex w-full items-start gap-2 border-b border-line px-3 py-2 text-left hover:bg-panel2/50",
            missing.length ? "bg-warn/5" : "",
          )}
        >
          <AlertTriangle size={14} className={cx("mt-0.5 shrink-0", missing.length ? "text-warn" : "text-ok")} aria-hidden />
          <span className="min-w-0">
            <span className="text-[12.5px] font-semibold">
              {missing.length ? `${missing.length} critical item${missing.length > 1 ? "s" : ""} missing` : "All critical items answered"}
            </span>
            {missing.length > 0 && (
              <span className="mt-0.5 block text-[12px] leading-snug text-sub">{missing.map((k) => FIELD_LABELS[k]).join(" · ")}</span>
            )}
          </span>
          {missing.length > 0 && <span className="ml-auto shrink-0 text-[11px] text-[#8fb6f5]">Questions →</span>}
        </button>

        {/* Dispatch: recommendation, then officer communication once assigned */}
        {incident.status !== "closed" && (
          assignment && assignedOfficer ? (
            <Section title="Officer communication">
              <OfficerComms incident={incident} assignment={assignment} officer={assignedOfficer} updates={officerUpdates} />
            </Section>
          ) : (
            <Section title="Recommended unit" right={<span className="text-[10px] text-faint">ETAs simulated</span>}>
              <RecommendationCard incident={incident} recs={recs} />
            </Section>
          )
        )}

        {PANEL_SECTIONS.map((sec) => (
          <Section key={sec.title} title={sec.title}>
            {sec.keys.map((k) => <FieldRow key={k} incident={incident} k={k} />)}
          </Section>
        ))}

        <details className="border-b border-line px-3 py-2.5">
          <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-[0.08em] text-sub">All units ({officers.length})</summary>
          <UnitsList incident={incident} officers={officers} highlightId={highlightId} assignment={assignment} />
        </details>

        <p className="px-3 py-3 text-[11px] leading-relaxed text-faint">
          Unverified values were heard on the call but not confirmed. Click a value to see the transcript line behind it.
          Values you edit or confirm are locked and never overwritten by AI.
        </p>
      </div>
    </aside>
  );
}
