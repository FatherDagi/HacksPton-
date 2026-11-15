"use client";
import { Check, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { act } from "@/lib/store";
import type { Incident, TranscriptSegment } from "@/lib/types";
import { Button, PanelHeader, cx } from "../ui";

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

export function CallPanel({
  incident,
  live,
  extractionLabel,
  geminiQuestions,
}: {
  incident: Incident | null;
  live: boolean;
  extractionLabel: string;
  geminiQuestions: string[];
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const count = incident?.transcript.length ?? 0;
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [count]);

  const open = incident ? incident.questions.filter((q) => q.state === "open" && incident.fields[q.fieldKey].status === "unknown") : [];
  const handled = incident ? incident.questions.filter((q) => q.state !== "open").length : 0;

  return (
    <section aria-label="Active call" className="flex min-h-0 flex-col border-r border-line bg-panel">
      <div className="flex min-h-0 flex-[3_1_0] flex-col">
        <PanelHeader
          title="Live transcript"
          right={
            live ? (
              <span className="flex items-center gap-2 text-[11px] font-semibold text-[#ffb3ad]">
                <span className="flex h-3 items-center gap-[2px]" aria-hidden>
                  {[0, 1, 2, 3, 4].map((i) => (
                    <span key={i} className="wave-bar h-3 w-[2px] rounded-full bg-alert" style={{ animationDelay: `${i * 0.12}s` }} />
                  ))}
                </span>
                Recording
              </span>
            ) : (
              <span className="text-[11px] text-faint">{incident ? "Call ended" : "No active call"}</span>
            )
          }
        />
        <div className="panel-scroll min-h-0 flex-1 overflow-y-auto px-3 py-2" aria-live="polite">
          {!incident && <p className="py-6 text-center text-sm text-faint">Choose a scenario and press Run demo scenario.</p>}
          <ol className="flex flex-col gap-2.5">
            {incident?.transcript.map((s) => (
              <li key={s.id} id={`seg-${s.id}`} className="scroll-mt-2">
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
          <div ref={endRef} />
        </div>
      </div>

      <div className="flex min-h-0 flex-[2_1_0] flex-col border-t border-line">
        <PanelHeader title="Ask next" right={<span className="text-[10px] text-faint">{extractionLabel}</span>} />
        <div className="panel-scroll min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {incident && open.length === 0 && geminiQuestions.length === 0 && (
            <p className="text-sm text-faint">No open questions on the checklist.</p>
          )}
          <ul className="flex flex-col divide-y divide-line">
            {open.map((q) => (
              <li key={q.id} className="flex items-start gap-2 py-1.5">
                <span className="flex-1 text-[13.5px] leading-snug">{q.text}</span>
                <Button size="sm" variant="ghost" aria-label={`Mark answered: ${q.text}`} title="Answered"
                  onClick={() => act({ type: "SET_QUESTION", at: Date.now(), incidentId: incident!.id, questionId: q.id, state: "answered" })}>
                  <Check size={14} />
                </Button>
                <Button size="sm" variant="ghost" aria-label={`Dismiss: ${q.text}`} title="Dismiss"
                  onClick={() => act({ type: "SET_QUESTION", at: Date.now(), incidentId: incident!.id, questionId: q.id, state: "dismissed" })}>
                  <X size={14} />
                </Button>
              </li>
            ))}
          </ul>
          {geminiQuestions.length > 0 && (
            <div className="mt-2">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[#8fb6f5]">Gemini suggested (AI-generated)</p>
              <ul className="flex flex-col gap-1">
                {geminiQuestions.map((q) => (
                  <li key={q} className="text-[13px] leading-snug text-sub">• {q}</li>
                ))}
              </ul>
            </div>
          )}
          {handled > 0 && <p className="mt-2 text-[11px] text-faint">{handled} answered or dismissed</p>}
        </div>
      </div>
    </section>
  );
}
