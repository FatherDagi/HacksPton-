import { Suspense } from "react";
import { OfficerView } from "@/components/officer/OfficerView";

export const metadata = { title: "Officer · Emergency Dispatch Copilot (Simulation)" };

export default function OfficerPage() {
  return (
    <Suspense fallback={<p className="p-4 text-sm text-faint">Loading…</p>}>
      <OfficerView />
    </Suspense>
  );
}
