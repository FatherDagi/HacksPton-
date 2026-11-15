import { Barlow, Barlow_Condensed } from "next/font/google";
import { Suspense } from "react";
import { OfficerClient } from "@/components/officer/OfficerClient";

const plex = Barlow({ variable: "--font-plex", subsets: ["latin"], weight: ["400", "500", "600", "700"] });
const cond = Barlow_Condensed({ variable: "--font-cond", subsets: ["latin"], weight: ["600", "700"] });

export const metadata = { title: "Patrol · PSAFE Dispatch Copilot" };

export default function OfficerPage() {
  return (
    <Suspense fallback={null}>
      <OfficerClient fontClass={`${plex.variable} ${cond.variable}`} />
    </Suspense>
  );
}
