import { IBM_Plex_Sans, IBM_Plex_Sans_Condensed } from "next/font/google";
import { Suspense } from "react";
import { Terminal } from "@/components/officer/Terminal";

const plex = IBM_Plex_Sans({ variable: "--font-plex", subsets: ["latin"], weight: ["400", "500", "600", "700"] });
const cond = IBM_Plex_Sans_Condensed({ variable: "--font-cond", subsets: ["latin"], weight: ["600", "700"] });

export const metadata = { title: "Patrol terminal · Dispatch Copilot (Simulation)" };

export default function OfficerPage() {
  return (
    <Suspense>
      <Terminal fontClass={`${plex.variable} ${cond.variable}`} />
    </Suspense>
  );
}
