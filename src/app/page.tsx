import { Barlow, Barlow_Condensed } from "next/font/google";
import Link from "next/link";
import "./start.css";

const plex = Barlow({ variable: "--font-plex", subsets: ["latin"], weight: ["400", "500", "600", "700"] });
const cond = Barlow_Condensed({ variable: "--font-cond", subsets: ["latin"], weight: ["600", "700"] });

export const metadata = { title: "PSAFE · Dispatch Copilot" };

export default function Home() {
  return (
    <main className={`st ${plex.variable} ${cond.variable}`}>
      <div className="st-band" aria-hidden="true"><i /><i /><i /><i /></div>
      <div className="st-wrap">
        <header className="st-head">
          <p className="st-org">Princeton University · Public Safety</p>
          <p className="st-sim">Simulation</p>
        </header>

        <div className="st-hero">
          <p className="st-kicker">HackPrinceton Fall 2026</p>
          <h1 className="st-title">Dispatch Copilot</h1>
          <p className="st-lede">AI drafts the sheet and the map. A human sends every unit.</p>
        </div>

        <div className="st-roles">
          <Link href="/console" className="st-role">
            <span className="st-name">HQ desk</span>
            <span className="st-what">Transcript, priority, Clery draft, campus map, and unit recommendations.</span>
            <span className="st-foot">
              <span className="st-where">Dispatcher</span>
              <span className="st-go">Enter</span>
            </span>
          </Link>

          <Link href="/officer" className="st-role">
            <span className="st-name">Patrol</span>
            <span className="st-what">Car terminal: assignment, route, backup, and live link to HQ.</span>
            <span className="st-foot">
              <span className="st-where">Officer</span>
              <span className="st-go">Enter</span>
            </span>
          </Link>
        </div>

        <p className="st-rule">Nothing dispatches without approval.</p>
      </div>
    </main>
  );
}
