"use client";
import { Check, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { FIELD_LABELS } from "@/lib/fields";
import { act, stamp } from "@/lib/store";
import type { Incident, IncidentEvent, TranscriptSegment } from "@/lib/types";
import { Button, cx, fmtTime } from "../ui";

function Highlighted({ seg }: { seg: TranscriptSegment }) {
  if (!seg.highlight || !seg.text.includes(seg.highlight)) return <>{seg.text}</>;
  const [a, b] = seg.text.split(seg.highlight);
  return (
    <>
      {a}
      <mark className="rounded-[2px] bg-warn/20 px-0.5 text-[#ffd3a8]">{seg.highlight}</mark>
      {b}
    </>
  );
}

/** Keeps a scroll container pinned to the bottom when new items arrive. */
function useStickToBottom(count: number) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count]);
  return ref;
}

export function TranscriptDrawer({ incident, live }: { incident: Incident | null; live: boolean }) {
  const ref = useStickToBottom(incident?.transcript.length ?? 0);
  return (
    <div ref={ref} className="panel-scroll h-full overflow-y-auto px-3 py-2" aria-live="polite">
      {!incident && <p className="py-6 text-center text-sm text-faint">No active call.</p>}
      <ol className="flex flex-col gap-2.5">
        {incident?.transcript.map((s) => (
          <li key={s.id}>
            <div className="flex items-baseline gap-2">
              <span className={cx("text-[11px] font-semibold uppercase tracking-wide", s.speaker === "caller" ? "text-[#f2c27a]" : "text-[#8fb6f5]")}>
                {s.speaker === "caller" ? "Caller" : "Dispatcher"}
              </span>
              <span className="font-mono text-[11px] text-faint">{`00:${String(s.t).padStart(2, "0")}`}</span>
            </div>
            <p className="text-[13.5px] leading-snug text-ink">
              <Highlighted seg={s} />
            </p>
          </li>
        ))}
      </ol>
      {incident && (
        <p className="mt-3 text-[12px] italic text-faint">{live ? "Listening…" : "Call ended."}</p>
      )}
    </div>
  );
}

export function QuestionsDrawer({
  incident,
  sourceLabel,
  geminiQuestions,
}: {
  incident: Incident | null;
  sourceLabel: string;
  geminiQuestions: string[];
}) {
  if (!incident) return <p className="py-6 text-center text-sm text-faint">Questions appear once a call starts.</p>;
  const open = incident.questions.filter((q) => q.state === "open" && incident.fields[q.fieldKey].status === "unknown");
  const handled = incident.questions.filter((q) => q.state !== "open");
  return (
    <div className="panel-scroll h-full overflow-y-auto px-3 py-2">
      <p className="mb-1 text-[10.5px] text-faint">{sourceLabel}. Ordered by importance. Suggestions only; follow your call-taking protocol.</p>
      {open.length === 0 && geminiQuestions.length === 0 && <p className="py-2 text-sm text-faint">No open questions on the checklist.</p>}
      <ol className="flex flex-col divide-y divide-line">
        {open.map((q, i) => (
          <li key={q.id} className="flex items-start gap-2 py-2">
            <span className="w-5 shrink-0 pt-px font-mono text-[11px] text-[#f2c27a]">{String(i + 1).padStart(2, "0")}</span>
            <div className="min-w-0 flex-1">
              <p className="text-[13.5px] leading-snug">{q.text}</p>
              <p className="text-[11px] text-faint">Missing: {FIELD_LABELS[q.fieldKey]}</p>
            </div>
            <Button size="sm" variant="ghost" aria-label={`Mark answered: ${q.text}`} title="Answered"
              onClick={() => act({ type: "SET_QUESTION", at: stamp(), incidentId: incident.id, questionId: q.id, state: "answered" })}>
              <Check size={14} />
            </Button>
            <Button size="sm" variant="ghost" aria-label={`Dismiss: ${q.text}`} title="Dismiss"
              onClick={() => act({ type: "SET_QUESTION", at: stamp(), incidentId: incident.id, questionId: q.id, state: "dismissed" })}>
              <X size={14} />
            </Button>
          </li>
        ))}
      </ol>
      {geminiQuestions.length > 0 && (
        <div className="mt-3 border-t border-line pt-2">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[#8fb6f5]">Gemini suggested (AI-generated)</p>
          <ul className="flex flex-col gap-1">
            {geminiQuestions.map((q) => <li key={q} className="text-[13px] leading-snug text-sub">• {q}</li>)}
          </ul>
        </div>
      )}
      {handled.length > 0 && (
        <details className="mt-3 border-t border-line pt-2 text-[12px] text-faint">
          <summary className="cursor-pointer">{handled.length} answered or dismissed</summary>
          <ul className="mt-1 flex flex-col gap-0.5">
            {handled.map((q) => (
              <li key={q.id} className="flex justify-between gap-2">
                <span className="line-through decoration-faint/60">{q.text}</span>
                <span className="shrink-0 capitalize">{q.state}</span>
                {q.state === "dismissed" && (
                  <button type="button" className="shrink-0 text-[#8fb6f5] hover:underline"
                    onClick={() => act({ type: "SET_QUESTION", at: stamp(), incidentId: incident.id, questionId: q.id, state: "open" })}>
                    Restore
                  </button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

const ACTOR_STYLE: Record<IncidentEvent["actor"], string> = {
  system: "text-sub",
  demo: "text-faint",
  ai: "text-[#8fb6f5]",
  dispatcher: "text-[#7fd7aa]",
  officer: "text-[#f2b67a]",
};

export function ActivityDrawer({ events }: { events: IncidentEvent[] }) {
  const ref = useStickToBottom(events.length);
  return (
    <div ref={ref} className="panel-scroll h-full overflow-y-auto px-3 py-2">
      {events.length === 0 && <p className="py-6 text-center text-sm text-faint">No activity yet.</p>}
      <ol className="flex flex-col gap-2">
        {events.map((e) => (
          <li key={e.id} className="grid grid-cols-[62px_minmax(0,1fr)] gap-2 text-[12.5px] leading-snug">
            <span className="font-mono text-[11px] text-faint">{fmtTime(e.at).replace(/\s?[AP]M$/, "")}</span>
            <span>
              <span className={cx("mr-1.5 text-[10px] font-semibold uppercase tracking-wide", ACTOR_STYLE[e.actor])}>{e.actor}</span>
              {e.message}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
