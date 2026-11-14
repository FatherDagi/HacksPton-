"use client";
import Link from "next/link";
import { useAppState } from "@/lib/store";
import { PriorityChip, SimBanner, fmtTime } from "../ui";

export function IncidentList() {
  const { incidents } = useAppState();
  const rows = [...incidents].sort((a, b) => b.createdAt - a.createdAt);
  return (
    <main className="mx-auto max-w-5xl p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">Incidents</h1>
        <SimBanner />
        <Link href="/dispatch" className="ml-auto text-sm text-[#8fb6f5] hover:underline">Back to dispatch</Link>
      </div>
      <div className="mt-4 overflow-x-auto border border-line bg-panel">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="border-b border-line bg-panel2/60 text-[11px] uppercase tracking-wider text-sub">
            <tr><th className="px-3 py-2">Number</th><th className="px-3 py-2">Title</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">Priority</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Created</th></tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((i) => (
              <tr key={i.id} className="hover:bg-panel2">
                <td className="px-3 py-2 font-mono"><Link href={`/incidents/${i.id}`} className="text-[#8fb6f5] hover:underline">{i.number}</Link></td>
                <td className="px-3 py-2">{i.title}</td>
                <td className="px-3 py-2 capitalize text-sub">{i.category}</td>
                <td className="px-3 py-2">{i.priorityDecision ? <PriorityChip p={i.priorityDecision.priority} /> : <span className="text-faint">—</span>}</td>
                <td className="px-3 py-2 capitalize">{i.status.replace("_", " ")}</td>
                <td className="px-3 py-2 font-mono text-sub">{new Date(i.createdAt).toLocaleDateString()} {fmtTime(i.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
