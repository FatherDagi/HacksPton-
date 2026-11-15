"use client";

import "./terminal.css";
import "../console/console.css";
import dynamic from "next/dynamic";

const Terminal = dynamic(
  () => import("./Terminal").then((m) => m.Terminal),
  {
    ssr: false,
    loading: () => (
      <div className="dc ot ot-pick-screen" data-theme="dark">
        <main className="ot-pick">
          <h1>Select officer</h1>
          <p>Loading units…</p>
        </main>
      </div>
    ),
  },
);

export function OfficerClient({ fontClass }: { fontClass: string }) {
  return <Terminal fontClass={fontClass} />;
}
