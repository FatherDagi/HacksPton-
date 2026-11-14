import { IBM_Plex_Sans } from "next/font/google";
import { ConsoleApp } from "@/components/console/ConsoleApp";

const plex = IBM_Plex_Sans({ variable: "--font-plex", subsets: ["latin"], weight: ["400", "500", "600", "700"] });

export const metadata = { title: "Console · Emergency Dispatch Copilot (Simulation)" };

export default function ConsolePage() {
  return <ConsoleApp fontClass={plex.variable} />;
}
