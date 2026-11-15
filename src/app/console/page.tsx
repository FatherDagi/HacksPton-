import { Barlow, Barlow_Condensed } from "next/font/google";
import { ConsoleClient } from "@/components/console/ConsoleClient";

const plex = Barlow({ variable: "--font-plex", subsets: ["latin"], weight: ["400", "500", "600", "700"] });
const cond = Barlow_Condensed({ variable: "--font-cond", subsets: ["latin"], weight: ["600", "700"] });

export const metadata = { title: "HQ · PSAFE Dispatch Copilot" };

export default function ConsolePage() {
  return <ConsoleClient fontClass={`${plex.variable} ${cond.variable}`} />;
}
