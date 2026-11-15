// Illustrative, human-reviewable P1–P4 demo rules.
// NOT MPDS, not clinically validated, not a universal police standard.
import type { FieldKey, FieldValue, IncidentCategory, PriorityAssessment, Priority, Urgency } from "./types";

const val = (f: Record<FieldKey, FieldValue>, k: FieldKey) => (f[k].value ?? "").toLowerCase();
const known = (f: Record<FieldKey, FieldValue>, k: FieldKey) => f[k].status !== "unknown" && !!f[k].value;

export function assessPriority(category: IncidentCategory, fields: Record<FieldKey, FieldValue>): PriorityAssessment {
  const reasons: string[] = [];
  let p: Priority = 4;
  let u: Urgency = "low";
  const bump = (np: Priority, nu: Urgency, why: string) => {
    reasons.push(why);
    if (np < p) p = np;
    const order: Urgency[] = ["low", "moderate", "high", "immediate"];
    if (order.indexOf(nu) > order.indexOf(u)) u = nu;
  };

  if (known(fields, "description")) bump(3, "moderate", "An incident has been reported");

  if (category === "medical") {
    if (known(fields, "conscious") && /no|not|unresponsive/.test(val(fields, "conscious")))
      bump(1, "immediate", "Patient reported not responding");
    if (known(fields, "breathing") && /no|not|abnormal|gasp/.test(val(fields, "breathing")))
      bump(1, "immediate", "Breathing reported absent or abnormal");
    if (known(fields, "condition") && /bleed|collapsed|unresponsive/.test(val(fields, "condition")))
      bump(2, "high", "Serious condition described");
  }

  if (category === "fire") {
    if (known(fields, "hazards") && /smoke|flame|fire/.test(val(fields, "hazards")))
      bump(2, "high", "Smoke or fire reported");
    if (known(fields, "people_count") && /inside|trapped/.test(val(fields, "people_count")))
      bump(1, "immediate", "Someone may still be inside");
  }

  if (category === "police" || category === "other") {
    if (known(fields, "weapons") && !/^none/.test(val(fields, "weapons")))
      bump(1, "high", "Weapon reported");
    if (known(fields, "condition") && /bleed|injur|hurt/.test(val(fields, "condition")))
      bump(2, "high", "Person injured");
  }

  if (reasons.length === 0) reasons.push("Not enough information yet");
  return { proposed: p, urgency: u, reasons };
}

export const URGENCY_LABEL: Record<Urgency, string> = {
  immediate: "Immediate",
  high: "High",
  moderate: "Moderate",
  low: "Low",
};
