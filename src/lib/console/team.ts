// How many units a call needs, and which ones. Demo rules for the console,
// shown to the dispatcher with their reasons; the dispatcher approves or swaps.
import { ELIGIBLE } from "../recommend";
import type { FieldKey, FieldValue, Incident, Officer, Priority, ResponderType } from "../types";
import { personHurt, weaponReported } from "./assess";
import type { RoutePlan } from "./routing";

export interface Need {
  type: ResponderType;
  why: string;
}

const has = (f: Record<FieldKey, FieldValue>, k: FieldKey) => f[k].status !== "unknown" && !!f[k].value;
const someoneInside = (f: Record<FieldKey, FieldValue>) => has(f, "people_count") && /inside|trapped/i.test(f.people_count.value ?? "");

export function teamNeeds(inc: Incident, priority: Priority): { needs: Need[]; why: string } {
  const f = inc.fields;
  switch (inc.category) {
    case "police": {
      const needs: Need[] = [];
      if (weaponReported(f)) needs.push({ type: "police", why: "weapon" }, { type: "police", why: "weapon" });
      else needs.push({ type: "police", why: "officer" });
      if (personHurt(f)) needs.push({ type: "ems", why: "injury" });
      const why = weaponReported(f)
        ? `Weapon reported: two officers, never one alone${personHurt(f) ? ", plus EMS for the injured person" : ""}.`
        : personHurt(f)
          ? "Person hurt: one officer plus EMS."
          : "No weapon, no one hurt: one officer.";
      return { needs, why };
    }
    case "medical": {
      const needs: Need[] = [{ type: "ems", why: "patient" }];
      if (priority === 1) needs.push({ type: "police", why: "first on scene" });
      return { needs, why: priority === 1 ? "Life-threatening: EMS, plus the nearest officer in case they arrive first." : "EMS for the patient." };
    }
    case "fire": {
      const needs: Need[] = [{ type: "fire", why: "fire" }, { type: "police", why: "access" }];
      if (someoneInside(f)) needs.push({ type: "ems", why: "possible casualty" });
      return { needs, why: `Fire unit plus an officer for access and evacuation${someoneInside(f) ? ", and EMS: someone may be inside" : ""}.` };
    }
    default:
      return { needs: [{ type: "police", why: "officer" }], why: priority === 4 ? "No danger: the nearest free officer, no lights or siren." : "One officer." };
  }
}

export interface Candidate {
  officer: Officer;
  plan: RoutePlan;
}

/** Fill each need with the fastest free unit of that type (falling back down the eligibility list). */
export function pickTeam(inc: Incident, needs: Need[], candidates: Candidate[]): { team: Candidate[]; missing: Need[] } {
  const used = new Set<string>();
  const team: Candidate[] = [];
  const missing: Need[] = [];
  const byEta = [...candidates].sort((a, b) => a.plan.etaSeconds - b.plan.etaSeconds);
  for (const need of needs) {
    const order = [need.type, ...ELIGIBLE[inc.category].filter((t) => t !== need.type)];
    let pick: Candidate | undefined;
    for (const t of order) {
      pick = byEta.find((c) => c.officer.type === t && !used.has(c.officer.id));
      if (pick) break;
    }
    if (pick) {
      used.add(pick.officer.id);
      team.push(pick);
    } else missing.push(need);
  }
  return { team, missing };
}
