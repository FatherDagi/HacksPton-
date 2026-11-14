import { IBM_Plex_Sans, IBM_Plex_Sans_Condensed } from "next/font/google";
import Link from "next/link";
import "./start.css";

const plex = IBM_Plex_Sans({ variable: "--font-plex", subsets: ["latin"], weight: ["400", "500", "600"] });
const cond = IBM_Plex_Sans_Condensed({ variable: "--font-cond", subsets: ["latin"], weight: ["600", "700"] });

export const metadata = { title: "Dispatch Copilot (Simulation)" };

// Start screen: pick a role. Dispatchers work at a desk console; officers use the terminal in their patrol car.
// No sign-in for the demo.
export default function Home() {
  return (
    <main className={`st ${plex.variable} ${cond.variable}`}>
      <div className="st-band" aria-hidden="true"><i /><i /><i /><i /></div>
      <div className="st-wrap">
        <header className="st-head">
          <p className="st-org">Princeton University Department of Public Safety</p>
          <p className="st-sim">Simulation. Calls and units are scripted.</p>
        </header>

        <h1 className="st-title">Dispatch Copilot</h1>
        <p className="st-lede">Choose where you are working this shift.</p>

        <div className="st-roles">
          <Link href="/console" className="st-role">
            <ConsoleSketch />
            <span className="st-name">Dispatcher</span>
            <span className="st-what">Answer calls with the AI filling in the incident sheet beside you. It recommends units; you approve every dispatch.</span>
            <span className="st-foot">
              <span className="st-where">Dispatch desk console</span>
              <span className="st-go">Open console</span>
            </span>
          </Link>

          <Link href="/officer" className="st-role">
            <TerminalSketch />
            <span className="st-name">Patrol officer</span>
            <span className="st-what">Receive dispatches on the car terminal with the live incident notes and the fastest route. Dispatch sees where you are.</span>
            <span className="st-foot">
              <span className="st-where">Patrol car terminal</span>
              <span className="st-go">Open terminal</span>
            </span>
          </Link>
        </div>

        <p className="st-rule">The AI drafts and maps. A human approves every dispatch.</p>
      </div>
    </main>
  );
}

/** Three-pane dispatch console: transcript, map with a route, incident sheet. */
function ConsoleSketch() {
  return (
    <svg className="st-sketch" viewBox="0 0 240 132" aria-hidden="true">
      <rect x="1" y="1" width="238" height="130" rx="4" className="frame" />
      <rect x="1" y="1" width="238" height="5" className="p1" />
      <g className="ink">
        <rect x="8" y="14" width="44" height="3" /><rect x="8" y="22" width="36" height="3" /><rect x="8" y="30" width="40" height="3" />
        <rect x="8" y="42" width="30" height="3" /><rect x="8" y="50" width="42" height="3" />
        <rect x="190" y="14" width="42" height="3" /><rect x="190" y="24" width="30" height="3" /><rect x="190" y="34" width="38" height="3" />
        <rect x="190" y="44" width="26" height="3" /><rect x="190" y="54" width="34" height="3" />
      </g>
      <rect x="58" y="12" width="126" height="112" className="map" />
      <path d="M72 108 L96 88 L118 92 L140 64 L158 46" className="route" />
      <circle cx="72" cy="108" r="4" className="unit" />
      <circle cx="158" cy="46" r="6" className="inc" />
      <rect x="64" y="16" width="64" height="12" rx="2" className="card" />
    </svg>
  );
}

/** In-car terminal: status buttons, map, incident card. */
function TerminalSketch() {
  return (
    <svg className="st-sketch" viewBox="0 0 240 132" aria-hidden="true">
      <rect x="1" y="1" width="238" height="130" rx="4" className="frame" />
      <rect x="8" y="10" width="70" height="40" rx="2" className="card" />
      <g className="ink"><rect x="14" y="17" width="40" height="3" /><rect x="14" y="26" width="54" height="3" /><rect x="14" y="35" width="30" height="3" /></g>
      <rect x="84" y="10" width="148" height="88" className="map" />
      <path d="M100 86 L128 70 L150 74 L176 40" className="route" />
      <circle cx="100" cy="86" r="4" className="unit" />
      <circle cx="176" cy="40" r="6" className="inc" />
      <rect x="8" y="104" width="72" height="20" rx="2" className="btn a" />
      <rect x="84" y="104" width="72" height="20" rx="2" className="btn" />
      <rect x="160" y="104" width="72" height="20" rx="2" className="btn" />
    </svg>
  );
}
