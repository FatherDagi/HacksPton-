"use client";

import dynamic from "next/dynamic";

const ConsoleApp = dynamic(
  () => import("./ConsoleApp").then((m) => m.ConsoleApp),
  {
    ssr: false,
    loading: () => <div className="dc" data-theme="dark" style={{ height: "100dvh", background: "#0a0e14" }} />,
  },
);

export function ConsoleClient({ fontClass }: { fontClass: string }) {
  return <ConsoleApp fontClass={fontClass} />;
}
