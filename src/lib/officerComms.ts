// What an assigned officer should know, and what has changed since they were last told.
// Nothing here sends anything: the dispatcher reviews and approves every update.
import { FIELD_LABELS } from "./fields";
import { assessPriority } from "./priority";
import type { FieldKey, Incident, UpdateChange } from "./types";

/** Fields that matter to a responding officer, most operationally important first. */
export const OFFICER_FIELDS: FieldKey[] = [
  "weapons",
  "hazards",
  "suspect",
  "conscious",
  "breathing",
  "condition",
  "people_count",
  "building",
  "floor",
  "room",
  "location_details",
  "access",
  "description",
  "caller_safe",
  "callback",
];

/** Changes that could affect officer safety or tactics are flagged so the dispatcher sees them first. */
export const SAFETY_KEYS = new Set<string>(["weapons", "hazards", "suspect", "priority", "conscious", "breathing"]);

/** The currently effective priority: the dispatcher's decision, else the rule-based proposal. */
export function effectivePriority(incident: Incident): string {
  const p = incident.priorityDecision?.priority ?? assessPriority(incident.category, incident.fields).proposed;
  return `P${p}${incident.priorityDecision ? "" : " (proposed)"}`;
}

export function officerSnapshot(incident: Incident): Record<string, string | null> {
  const snap: Record<string, string | null> = { priority: effectivePriority(incident) };
  for (const k of OFFICER_FIELDS) snap[k] = incident.fields[k].value;
  return snap;
}

/** Differences between the last snapshot sent to the officer and the incident now. */
export function pendingChanges(incident: Incident, sent: Record<string, string | null> | undefined): UpdateChange[] {
  if (!sent) return [];
  const now = officerSnapshot(incident);
  const changes: UpdateChange[] = [];
  for (const key of ["priority", ...OFFICER_FIELDS]) {
    const from = sent[key] ?? null;
    const to = now[key] ?? null;
    const norm = (v: string | null) => (v ?? "").trim().replace(/\s+/g, " ").toLowerCase();
    // Ignore case/spacing-only rewrites (common when the AI re-extracts the same fact).
    if (norm(from) !== norm(to) && to !== null) {
      changes.push({ key, label: key === "priority" ? "Priority" : FIELD_LABELS[key as FieldKey], from, to });
    }
  }
  // Safety-relevant changes first.
  return changes.sort((a, b) => Number(SAFETY_KEYS.has(b.key)) - Number(SAFETY_KEYS.has(a.key)));
}
