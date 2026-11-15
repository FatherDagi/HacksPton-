// Compact snap panels. HQ keeps what they need; defaults leave the map open.

export type PanelId = "board" | "detail" | "roster" | "tools";

export type PanelState = Record<PanelId, boolean>;

export const PANEL_LABEL: Record<PanelId, string> = {
  board: "Cases",
  detail: "Dispatch",
  roster: "Roster",
  tools: "Tools",
};

const KEY = "psafe-panels-v5";

export const DEFAULT_PANELS: PanelState = {
  board: true,
  detail: true,
  roster: true,
  tools: false,
};

export function loadPanels(): PanelState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_PANELS };
    const parsed = JSON.parse(raw) as Partial<PanelState>;
    return { ...DEFAULT_PANELS, ...parsed };
  } catch {
    return { ...DEFAULT_PANELS };
  }
}

export function savePanels(state: PanelState) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch { /* private mode */ }
}
