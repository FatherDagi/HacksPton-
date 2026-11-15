// Floating console widgets: positions + visibility live in localStorage so each
// dispatcher (rookie vs experienced) can keep their own map desk layout.

export type WidgetId = "transcript" | "questions" | "sheet" | "units";

export interface WidgetLayout {
  id: WidgetId;
  x: number; // % of viewport
  y: number;
  w: number; // px hint
  open: boolean;
}

export type DeskPreset = "rookie" | "experienced" | "custom";

const ROOKIE: WidgetLayout[] = [
  { id: "transcript", x: 1.5, y: 10, w: 340, open: true },
  { id: "questions", x: 1.5, y: 52, w: 300, open: true },
  { id: "sheet", x: 74, y: 10, w: 360, open: true },
  { id: "units", x: 74, y: 58, w: 340, open: false },
];

const EXPERIENCED: WidgetLayout[] = [
  { id: "transcript", x: 1.5, y: 10, w: 320, open: false },
  { id: "questions", x: 1.5, y: 48, w: 300, open: false },
  { id: "sheet", x: 76, y: 10, w: 340, open: true },
  { id: "units", x: 76, y: 55, w: 320, open: false },
];

const KEY = "psafe-desk-v2";
const PRESET_KEY = "psafe-desk-preset";

export function defaultLayouts(preset: DeskPreset): WidgetLayout[] {
  return (preset === "experienced" ? EXPERIENCED : ROOKIE).map((w) => ({ ...w }));
}

export function loadLayouts(): { preset: DeskPreset; layouts: WidgetLayout[] } {
  try {
    const preset = (localStorage.getItem(PRESET_KEY) as DeskPreset | null) ?? "rookie";
    const raw = localStorage.getItem(KEY);
    if (!raw) return { preset, layouts: defaultLayouts(preset === "experienced" ? "experienced" : "rookie") };
    const parsed = JSON.parse(raw) as WidgetLayout[];
    if (!Array.isArray(parsed) || parsed.length < 3) return { preset, layouts: defaultLayouts(preset === "experienced" ? "experienced" : "rookie") };
    return { preset: preset === "experienced" || preset === "rookie" ? preset : "custom", layouts: parsed };
  } catch {
    return { preset: "rookie", layouts: defaultLayouts("rookie") };
  }
}

export function saveLayouts(layouts: WidgetLayout[], preset: DeskPreset) {
  try {
    localStorage.setItem(KEY, JSON.stringify(layouts));
    localStorage.setItem(PRESET_KEY, preset);
  } catch { /* private mode */ }
}

export const WIDGET_LABEL: Record<WidgetId, string> = {
  transcript: "Transcript",
  questions: "Ask next",
  sheet: "Incident",
  units: "Units",
};
