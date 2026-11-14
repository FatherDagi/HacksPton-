// Small shared UI primitives (kept local instead of a full component library).
import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { FieldStatus, OfficerStatus, Priority } from "@/lib/types";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "default" | "danger" | "ghost"; size?: "sm" | "md" };
export function Button({ variant = "default", size = "md", className, ...rest }: BtnProps) {
  return (
    <button
      type="button"
      {...rest}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-[3px] border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45",
        size === "sm" ? "h-7 px-2 text-xs" : "h-9 px-3 text-sm",
        variant === "primary" && "border-accent-strong bg-accent-strong text-white hover:bg-accent",
        variant === "danger" && "border-alert/70 bg-alert/15 text-[#ffb3ad] hover:bg-alert/25",
        variant === "default" && "border-line2 bg-panel2 text-ink hover:border-faint",
        variant === "ghost" && "border-transparent bg-transparent text-sub hover:text-ink",
        className,
      )}
    />
  );
}

export function PanelHeader({ title, right, className }: { title: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <div className={cx("flex h-9 shrink-0 items-center justify-between gap-2 border-b border-line bg-panel2/60 px-3", className)}>
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-sub">{title}</h2>
      {right}
    </div>
  );
}

const FIELD_STATUS_STYLE: Record<FieldStatus, string> = {
  confirmed: "border-ok/50 text-[#7fd7aa]",
  unverified: "border-warn/50 text-[#f2b67a]",
  unknown: "border-line2 text-faint",
};
const FIELD_STATUS_LABEL: Record<FieldStatus, string> = { confirmed: "Confirmed", unverified: "Unverified", unknown: "Unknown" };

export function FieldStatusBadge({ status }: { status: FieldStatus }) {
  return (
    <span className={cx("inline-flex h-5 shrink-0 items-center rounded-[2px] border px-1.5 text-[10px] font-semibold uppercase tracking-wide", FIELD_STATUS_STYLE[status])}>
      {FIELD_STATUS_LABEL[status]}
    </span>
  );
}

export const OFFICER_STATUS_LABEL: Record<OfficerStatus, string> = {
  available: "Available",
  busy: "Busy",
  responding: "Responding",
  on_scene: "On scene",
};
export const OFFICER_STATUS_COLOR: Record<OfficerStatus, string> = {
  available: "#43b57f",
  busy: "#8e98aa",
  responding: "#4a8cf0",
  on_scene: "#e8913f",
};

export function OfficerStatusBadge({ status }: { status: OfficerStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-semibold" style={{ color: OFFICER_STATUS_COLOR[status] }}>
      <span className="h-2 w-2 rounded-[1px]" style={{ background: OFFICER_STATUS_COLOR[status] }} aria-hidden />
      {OFFICER_STATUS_LABEL[status]}
    </span>
  );
}

export const PRIORITY_COLOR: Record<Priority, string> = { 1: "#ef5b52", 2: "#e8913f", 3: "#d8c25a", 4: "#8e98aa" };

export function PriorityChip({ p, muted }: { p: Priority; muted?: boolean }) {
  return (
    <span
      className="inline-flex h-6 items-center rounded-[2px] border px-2 font-mono text-xs font-bold"
      style={{ borderColor: PRIORITY_COLOR[p], color: muted ? "#a3aec0" : PRIORITY_COLOR[p] }}
    >
      P{p}
    </span>
  );
}

export function SimBanner() {
  return (
    <span className="rounded-[2px] border border-warn/60 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#f2b67a]">
      Simulation only — not for operational use
    </span>
  );
}

export function fmtClock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function fmtTime(at: number) {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
