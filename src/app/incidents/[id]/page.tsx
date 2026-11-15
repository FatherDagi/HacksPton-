import { Suspense } from "react";
import { IncidentDetail } from "@/components/incidents/IncidentDetail";

export default function IncidentPage() {
  return (
    <Suspense fallback={<p className="p-4 text-sm text-faint">Loading incident…</p>}>
      <IncidentDetail />
    </Suspense>
  );
}
