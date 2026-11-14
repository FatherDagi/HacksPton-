"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { buildingById } from "@/lib/campus";
import { FIELD_LABELS, SECTIONS } from "@/lib/fields";
import { useAppState } from "@/lib/store";
import { Button, FieldStatusBadge, PriorityChip, SimBanner, fmtTime } from "../ui";

export function IncidentDetail() {
  const { id } = useParams<{ id: string }>();
  const state = useAppState();
  const inc = state.incidents.find((i) => i.id === id);
  const [exportMsg, setExportMsg] = useState<string | null>(null);

  if (!inc) {
    return (
      <main className="p-6">
        <p className="text-sub">Incident not found in this browser.</p>
        <Link href="/incidents" className="text-[#8fb6f5] hover:underline">All incidents</Link>
      </main>
    );
  }
  const events = state.events.filter((e) => e.incidentId === inc.id).sort((a, b) => a.at - b.at);
  const assignments = state.assignments.filter((a) => a.incidentId === inc.id);

  const exportToSheets = async () => {
    setExportMsg("Exporting…");
    const res = await fetch("/api/export/sheets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ incident: inc, events, assignments }),
    });
    const j = (await res.json()) as { ok: boolean; message: string };
    setExportMsg(j.message);
  };

  return (
    <main className="mx-auto max-w-6xl p-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/incidents" className="text-sm text-[#8fb6f5] hover:underline">← Incidents</Link>
        <SimBanner />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="font-mono text-xl font-bold">{inc.number}</h1>
        {inc.priorityDecision && <PriorityChip p={inc.priorityDecision.priority} />}
        <span className="rounded-[2px] border border-line2 px-1.5 text-xs uppercase text-sub">{inc.status.replace("_", " ")}</span>
        <div className="ml-auto flex items-center gap-2">
          {exportMsg && <span className="text-xs text-sub">{exportMsg}</span>}
          <Button onClick={exportToSheets}>Export to Google Sheets</Button>
        </div>
      </div>
      <p className="mt-1 text-sub">{inc.title} · {buildingById(inc.buildingId)?.name}</p>
      {inc.priorityDecision?.overrideReason && <p className="mt-1 text-sm">Priority override reason: {inc.priorityDecision.overrideReason}</p>}

      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_1fr]">
        <section className="border border-line bg-panel p-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-sub">Incident information</h2>
          {SECTIONS.map((s) => (
            <div key={s.title} className="mt-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[#8fb6f5]">{s.title}</h3>
              {s.keys.map((k) => (
                <div key={k} className="grid grid-cols-[130px_1fr_auto] gap-2 border-b border-line py-1 text-sm">
                  <span className="text-sub">{FIELD_LABELS[k]}</span>
                  <span className={inc.fields[k].value ? "" : "italic text-faint"}>{inc.fields[k].value ?? "Unknown"}</span>
                  <FieldStatusBadge status={inc.fields[k].status} />
                </div>
              ))}
            </div>
          ))}
        </section>

        <div className="flex flex-col gap-4">
          <section className="border border-line bg-panel p-3">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-sub">Timeline</h2>
            {events.length === 0 && <p className="mt-2 text-sm text-faint">No events recorded in this browser.</p>}
            <ol className="mt-2 flex flex-col gap-1.5">
              {events.map((e) => (
                <li key={e.id} className="grid grid-cols-[72px_80px_1fr] gap-2 text-[13px]">
                  <span className="font-mono text-faint">{fmtTime(e.at)}</span>
                  <span className="text-[11px] uppercase tracking-wide text-sub">{e.actor}</span>
                  <span>{e.message}</span>
                </li>
              ))}
            </ol>
          </section>
          <section className="border border-line bg-panel p-3">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-sub">Transcript</h2>
            {inc.transcript.length === 0 && <p className="mt-2 text-sm text-faint">No transcript stored.</p>}
            <ol className="mt-2 flex flex-col gap-1.5 text-[13px]">
              {inc.transcript.map((s) => (
                <li key={s.id}><span className="font-semibold text-sub">{s.speaker === "caller" ? "Caller" : "Dispatcher"}:</span> {s.text}</li>
              ))}
            </ol>
          </section>
        </div>
      </div>
    </main>
  );
}
