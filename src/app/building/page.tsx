import Link from "next/link";
import { SimBanner } from "@/components/ui";

export const metadata = { title: "Building intelligence · Emergency Dispatch Copilot (Simulation)" };

const PANELS = [
  {
    name: "Matterport 3D interior",
    status: "Placeholder",
    needs: "A Matterport model ID for the sponsor property (NEXT_PUBLIC_MATTERPORT_MODEL_ID). Room labels and measurements are shown only if the dataset includes them.",
  },
  {
    name: "Vexcel aerial imagery",
    status: "Placeholder",
    needs: "Sponsor-provided Vexcel imagery access for the same address. Access points are shown only where the data supports them.",
  },
  {
    name: "CoStar building facts",
    status: "Placeholder",
    needs: "The CoStar record (property ID or verified address) for the same property.",
  },
];

export default function BuildingPage() {
  return (
    <main className="mx-auto max-w-5xl p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">Building intelligence</h1>
        <SimBanner />
        <Link href="/dispatch" className="ml-auto text-sm text-[#8fb6f5] hover:underline">Back to dispatch</Link>
      </div>
      <p className="mt-2 max-w-3xl text-sm text-sub">
        Sponsor-data demonstration for one Houston or Los Angeles property, kept separate from the Princeton campus simulation.
        No building measurements, layouts, access points or sponsor data are shown until the real datasets are connected.
      </p>
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        {PANELS.map((p) => (
          <section key={p.name} className="border border-line bg-panel p-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">{p.name}</h2>
              <span className="rounded-[2px] border border-warn/60 px-1.5 text-[10px] font-bold uppercase text-[#f2b67a]">{p.status}</span>
            </div>
            <div className="mt-3 grid h-40 place-items-center border border-dashed border-line2 text-xs text-faint">Not connected</div>
            <p className="mt-2 text-xs text-sub"><span className="font-semibold text-ink">To activate:</span> {p.needs}</p>
          </section>
        ))}
      </div>
    </main>
  );
}
