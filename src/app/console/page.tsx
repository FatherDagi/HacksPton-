import { IBM_Plex_Sans, IBM_Plex_Sans_Condensed } from "next/font/google";
import { ConsoleApp } from "@/components/console/ConsoleApp";

const plex = IBM_Plex_Sans({ variable: "--font-plex", subsets: ["latin"], weight: ["400", "500", "600", "700"] });
const cond = IBM_Plex_Sans_Condensed({ variable: "--font-cond", subsets: ["latin"], weight: ["700"] });

export const metadata = { title: "Console · Emergency Dispatch Copilot (Simulation)" };

export default function ConsolePage() {
  return <ConsoleApp fontClass={`${plex.variable} ${cond.variable}`} />;
}
