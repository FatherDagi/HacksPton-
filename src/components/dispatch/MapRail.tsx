"use client";
import { History, MessageSquareText, ListTodo, X } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { cx } from "../ui";

export type DrawerTab = "transcript" | "questions" | "activity";

const TABS: { id: DrawerTab; label: string; title: string; icon: typeof History }[] = [
  { id: "transcript", label: "Transcript", title: "Live transcript", icon: MessageSquareText },
  { id: "questions", label: "Questions", title: "AI questions", icon: ListTodo },
  { id: "activity", label: "Activity", title: "Activity log", icon: History },
];

export const DRAWER_WIDTH = 380;

/** Vertical tab rail on the far left of the map. */
export function MapRail({
  active,
  onToggle,
  badges,
}: {
  active: DrawerTab | null;
  onToggle: (t: DrawerTab) => void;
  badges: Partial<Record<DrawerTab, number>>;
}) {
  return (
    <nav aria-label="Call tools" className="z-[1200] flex w-14 shrink-0 flex-col items-stretch border-r border-line bg-panel">
      {TABS.map(({ id, label, icon: Icon }) => {
        const on = active === id;
        const badge = badges[id];
        return (
          <button
            key={id}
            type="button"
            aria-pressed={on}
            aria-controls="map-drawer"
            onClick={() => onToggle(id)}
            className={cx(
              "relative flex h-16 flex-col items-center justify-center gap-1 border-b border-line text-[10px] font-medium transition-colors",
              on ? "bg-panel2 text-ink" : "text-sub hover:bg-panel2/60 hover:text-ink",
            )}
          >
            {on && <span className="absolute inset-y-0 left-0 w-[3px] bg-accent" aria-hidden />}
            <Icon size={18} aria-hidden />
            {label}
            {!!badge && (
              <span className="absolute right-1.5 top-1.5 min-w-4 rounded-[2px] bg-warn/90 px-1 font-mono text-[10px] font-bold leading-4 text-bg">
                {badge}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

/** Drawer that slides over the map from the left; it stays mounted so its content keeps updating. */
export function MapDrawer({ tab, onClose, children }: { tab: DrawerTab | null; onClose: () => void; children: Record<DrawerTab, ReactNode> }) {
  const open = tab !== null;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <aside
      id="map-drawer"
      aria-label={tab ? TABS.find((t) => t.id === tab)!.title : "Drawer"}
      aria-hidden={!open}
      inert={!open}
      style={{ width: DRAWER_WIDTH }}
      className={cx(
        "absolute inset-y-0 left-0 z-[1100] flex max-w-[calc(100%-16px)] flex-col border-r border-line2 bg-panel/97 shadow-[8px_0_24px_rgba(0,0,0,0.35)] backdrop-blur-sm",
        "transition-[transform,visibility] duration-200 ease-out motion-reduce:transition-none",
        open ? "visible translate-x-0" : "invisible -translate-x-full",
      )}
    >
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-line bg-panel2/60 px-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-sub">{tab ? TABS.find((t) => t.id === tab)!.title : ""}</h2>
        <button type="button" onClick={onClose} aria-label="Close drawer" className="grid h-7 w-7 place-items-center rounded-[2px] text-sub hover:bg-panel2 hover:text-ink">
          <X size={15} />
        </button>
      </div>
      {/* Every tab stays mounted and laid out (so auto-scroll keeps working); only the selected one is visible. */}
      <div className="relative min-h-0 flex-1">
        {(Object.keys(children) as DrawerTab[]).map((t) => (
          <div key={t} className={cx("absolute inset-0", t === tab ? "visible" : "invisible")} aria-hidden={t !== tab}>
            {children[t]}
          </div>
        ))}
      </div>
    </aside>
  );
}
