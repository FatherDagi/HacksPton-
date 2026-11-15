// Clery Act assist: drafts a crime category, geography check, daily-log / NIBRS hint,
// and timely-warning flag from the call sheet. Human must sign off — never auto-files.
import type { FieldKey, FieldValue, Incident, IncidentCategory } from "./types";

export type CleryGeography = "on_campus" | "public_property" | "noncampus" | "outside" | "unknown";

export interface CleryDraft {
  reportable: boolean;
  category: string;
  geography: CleryGeography;
  geographyLabel: string;
  nibrs: string;
  dailyLog: boolean;
  timelyWarning: boolean;
  reasons: string[];
}

const text = (f: Record<FieldKey, FieldValue>, k: FieldKey) => (f[k].value ?? "").toLowerCase();
const has = (f: Record<FieldKey, FieldValue>, k: FieldKey) => f[k].status !== "unknown" && !!f[k].value;

/** Approximate Clery geography from building id / address text. Label as approximate unless PSAFE confirms the ASR map. */
export function cleryGeography(inc: Incident): { geography: CleryGeography; label: string; reasons: string[] } {
  const addr = text(inc.fields, "address") + " " + text(inc.fields, "building") + " " + text(inc.fields, "location_details");
  if (/nassau\s*st|witherspoon|university\s*pl/.test(addr)) {
    return {
      geography: "public_property",
      label: "Adjacent public property (approximate)",
      reasons: ["Location text mentions a public street abutting campus — Clery can include adjacent public property."],
    };
  }
  // Seeded campus buildings are treated as on-campus for the demo.
  if (inc.buildingId && inc.buildingId !== "dps") {
    return {
      geography: "on_campus",
      label: "On campus (approximate)",
      reasons: ["Building is on the Princeton campus map used in this simulation."],
    };
  }
  if (has(inc.fields, "building") || has(inc.fields, "address")) {
    return { geography: "unknown", label: "Geography needs review", reasons: ["Location present but outside the demo campus layer."] };
  }
  return { geography: "unknown", label: "Location not yet known", reasons: ["No building or address on the sheet yet."] };
}

export function draftClery(inc: Incident): CleryDraft {
  const f = inc.fields;
  const geo = cleryGeography(inc);
  const desc = text(f, "description") + " " + text(f, "category");
  const weapon = has(f, "weapons") && !/^none/.test(text(f, "weapons"));
  const hurt = has(f, "condition") && /bleed|injur|hurt|unresponsive|collapsed/.test(text(f, "condition"));
  const atLarge = /fled|ran|left|at large|got away|drove off/.test(text(f, "suspect") + " " + desc);
  const theft = /theft|steal|stolen|bike/.test(desc);
  const fire = inc.category === "fire" || /fire|smoke|alarm/.test(desc);
  const medicalOnly = inc.category === "medical" && !weapon && !theft;

  let reportable = false;
  let category = "Not a Clery crime";
  let nibrs = "N/A — daily crime log only if documented locally";
  let dailyLog = true;
  let timelyWarning = false;
  const reasons = [...geo.reasons];

  if (weapon && (hurt || /fight|assault|stab|knife|gun/.test(desc + " " + text(f, "weapons")))) {
    reportable = true;
    category = "Aggravated assault";
    nibrs = "13A — Aggravated Assault";
    reasons.push("Weapon + violence / injury pattern matches a Clery Part I crime.");
    if (atLarge || has(f, "suspect")) {
      timelyWarning = true;
      reasons.push("Suspect may still be at large — consider a timely warning.");
    }
  } else if (/robbery|force|threatened/.test(desc) && theft) {
    reportable = true;
    category = "Robbery";
    nibrs = "120 — Robbery";
    reasons.push("Theft with force or threat.");
  } else if (theft) {
    reportable = false;
    category = "Not Clery-reportable (property theft)";
    nibrs = "23H — All Other Larceny (suggested)";
    dailyLog = true;
    reasons.push("Bike / property theft still belongs in the daily crime log, but is not a Clery crime.");
  } else if (fire && !/toast|burnt food|false alarm|accidental/.test(desc)) {
    reportable = false;
    category = "Fire incident (review)";
    nibrs = "90Z — All Other Offenses (review)";
    dailyLog = true;
    reasons.push("Fire/smoke call — document for campus log; Clery fire stats are separate from crime stats.");
  } else if (medicalOnly || /lock(ed)? out|lockout/.test(desc)) {
    reportable = false;
    category = "Not a Clery crime";
    nibrs = "N/A";
    dailyLog = /lock(ed)? out|lockout/.test(desc) ? false : false;
    reasons.push(medicalOnly ? "Medical assist only — no Clery crime." : "Service call — no crime log entry required.");
  } else if (inc.category === "police") {
    reportable = false;
    category = "Police incident — category pending review";
    nibrs = "Review for NIBRS code";
    dailyLog = true;
    reasons.push("Police call without a clear Clery Part I match — human review required.");
  }

  if (geo.geography === "outside") {
    reportable = false;
    reasons.push("Outside Clery geography — do not count in ASR crime stats.");
  }

  return {
    reportable,
    category,
    geography: geo.geography,
    geographyLabel: geo.label,
    nibrs,
    dailyLog,
    timelyWarning,
    reasons,
  };
}

export function cleryCategoryHint(category: IncidentCategory): string {
  if (category === "medical") return "Medical assists are usually not Clery crimes.";
  if (category === "fire") return "Fires have separate Clery fire statistics.";
  return "Map the call facts to a Clery crime category, then sign off.";
}
