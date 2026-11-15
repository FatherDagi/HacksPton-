// Console priority: the shared demo rules (lib/priority.ts) plus two refinements
// so the four danger levels separate cleanly. Still illustrative, not a protocol.
import { assessPriority } from "../priority";
import type { FieldKey, FieldValue, IncidentCategory, PriorityAssessment } from "../types";

const text = (f: Record<FieldKey, FieldValue>, k: FieldKey) => (f[k].value ?? "").toLowerCase();
const has = (f: Record<FieldKey, FieldValue>, k: FieldKey) => f[k].status !== "unknown" && !!f[k].value;

export const weaponReported = (f: Record<FieldKey, FieldValue>) => has(f, "weapons") && !/^none/.test(text(f, "weapons"));
export const personHurt = (f: Record<FieldKey, FieldValue>) =>
  (has(f, "condition") && /bleed|injur|hurt|can.?t stand|collapsed|unresponsive/.test(text(f, "condition"))) ||
  (has(f, "people_count") && /injur|hurt/.test(text(f, "people_count")));

export function assessConsole(category: IncidentCategory, fields: Record<FieldKey, FieldValue>): PriorityAssessment {
  const a = assessPriority(category, fields);
  const desc = text(fields, "description");

  // Service calls with no danger (lockouts, lost keys/ID) are P4, not P3.
  if (/lock(ed)? out|lockout|lost (id|key|card)/.test(desc) && !weaponReported(fields) && !personHurt(fields) && !has(fields, "hazards")) {
    return { proposed: 4, urgency: "low", reasons: ["Service request, no danger reported"] };
  }
  // Property crime without a weapon stays P3, and says why.
  if (/theft|steal|stolen/.test(desc) && !weaponReported(fields) && !personHurt(fields) && a.proposed >= 3) {
    return { proposed: 3, urgency: "moderate", reasons: ["Property crime in progress", "No weapon or injury reported"] };
  }
  // Typical college intoxication / eating-club pass-out: urgent check, not a lethal call.
  if (category === "medical" && /intoxicat|passed out|alcohol|drunk|eating club|cottage|tiger/.test(desc + " " + text(fields, "condition") + " " + text(fields, "building"))) {
    return { proposed: 2, urgency: "high", reasons: ["Possible alcohol intoxication", "Welfare check"] };
  }
  if (/noise|music|porch/.test(desc) && !weaponReported(fields) && !personHurt(fields)) {
    return { proposed: 4, urgency: "low", reasons: ["Noise complaint", "No danger reported"] };
  }
  // Loud shoving / party disturbance with no weapon stays routine campus security.
  if (category === "police" && /shov|loud|party|drunk/.test(desc) && !weaponReported(fields) && !personHurt(fields)) {
    return { proposed: 3, urgency: "moderate", reasons: ["Campus disturbance", "No weapon reported"] };
  }
  return a;
}
