/**
 * PARKED — former HQ top chrome (removed from the live console for the demo).
 *
 * What lived here and where it can go later:
 * 1. Brand link → home (`PSAFE` / `Dispatch`) — candidate: left dock header or splash.
 * 2. Call status pill — Live/Ended/Idle + clock + incident number — candidate: cases header.
 * 3. Mode pill — Demo / Gemini / Listening — candidate: tools menu.
 * 4. Load exercise `<select>` — start scenario — now in bottom tools; keep there or cases.
 * 5. Next (E) / End call — advance transcript / end call — now in bottom tools while live.
 * 6. Clery / Clear — post-call actions — still available from case notes when a call ends.
 * 7. Panels / Week log / Patrol — already in bottom-right tools glass.
 *
 * Do not import this module into the live UI until a new placement is decided.
 */
"use client";

import Link from "next/link";

/** Reference markup only — not mounted. */
export function ParkedTopChrome() {
  return (
    <div className="dc-top">
      <Link href="/" className="dc-brand"><span>PSAFE</span><small>Dispatch</small></Link>
      <div className="dc-chrome" role="group" aria-label="Call">
        <span className="dc-chrome-status live"><i className="dot" />Live 00:00 · INC-00000</span>
        <select className="dc-exercise" aria-label="Load exercise" defaultValue="">
          <option value="">Load exercise…</option>
        </select>
        <button type="button" className="dc-btn sm">Next <kbd>E</kbd></button>
        <button type="button" className="dc-btn sm danger">End</button>
      </div>
    </div>
  );
}
