// How many officers a call needs, and who to pick given the whole open board.
// PSAFE is police-only — no separate EMS/fire fleet.
import type { FieldKey, FieldValue, Incident, Officer, Priority } from "../types";
import { personHurt, weaponReported } from "./assess";
import type { RoutePlan } from "./routing";

export interface Need {
  type: "police";
  why: string;
}

const has = (f: Record<FieldKey, FieldValue>, k: FieldKey) => f[k].status !== "unknown" && !!f[k].value;
const someoneInside = (f: Record<FieldKey, FieldValue>) => has(f, "people_count") && /inside|trapped/i.test(f.people_count.value ?? "");

export function teamNeeds(inc: Incident, priority: Priority): { needs: Need[]; why: string } {
  const f = inc.fields;
  switch (inc.category) {
    case "police": {
      if (weaponReported(f)) {
        return {
          needs: [{ type: "police", why: "weapon" }, { type: "police", why: "cover" }],
          why: personHurt(f)
            ? "Weapon reported: two officers. Request Princeton First Aid if injuries confirmed."
            : "Weapon reported: two officers, never one alone.",
        };
      }
      if (personHurt(f)) {
        return {
          needs: [{ type: "police", why: "injury" }, { type: "police", why: "cover" }],
          why: "Person hurt: two officers. Coordinate First Aid / EMS as needed.",
        };
      }
      return { needs: [{ type: "police", why: "officer" }], why: "No weapon, no one hurt: nearest free officer." };
    }
    case "medical": {
      const needs: Need[] = [{ type: "police", why: "first on scene" }];
      if (priority <= 2) needs.push({ type: "police", why: "cover" });
      return {
        needs,
        why: priority <= 2
          ? "Medical emergency: nearest officers first on scene while First Aid is notified."
          : "Medical assist: nearest officer to check on the patient.",
      };
    }
    case "fire": {
      const desc = `${f.description.value ?? ""} ${f.hazards.value ?? ""}`.toLowerCase();
      const burntFood = /burnt|popcorn|toast|microwave|cooking|food/.test(desc) && !/flame|flames/.test(desc);
      if (burntFood && !someoneInside(f)) {
        return {
          needs: [{ type: "police", why: "check" }],
          why: "Burnt food / smoke alarm: one officer to check the kitchen.",
        };
      }
      const needs: Need[] = [{ type: "police", why: "access" }, { type: "police", why: "evac" }];
      if (someoneInside(f)) needs.push({ type: "police", why: "search" });
      return {
        needs,
        why: `Fire / smoke: officers for access and evacuation${someoneInside(f) ? "; someone may be inside" : ""}. Coordinate Princeton Fire.`,
      };
    }
    default:
      return {
        needs: [{ type: "police", why: "officer" }],
        why: priority === 4 ? "Routine: nearest free officer, no lights or siren." : "One officer.",
      };
  }
}

export interface Candidate {
  officer: Officer;
  plan: RoutePlan;
  /** Seconds until this unit can leave their current post (0 if free now). */
  freeInSeconds: number;
  /** freeIn + drive/walk time to the call. */
  effectiveEtaSeconds: number;
}

/** Fill each need with the fastest officer by effective ETA (includes wrapping-up busy units). */
export function pickTeam(_inc: Incident, needs: Need[], candidates: Candidate[], reservedIds: Set<string> = new Set()): { team: Candidate[]; missing: Need[] } {
  const used = new Set<string>(reservedIds);
  const team: Candidate[] = [];
  const missing: Need[] = [];
  const byEta = [...candidates]
    .filter((c) => !used.has(c.officer.id))
    .sort((a, b) => a.effectiveEtaSeconds - b.effectiveEtaSeconds || a.freeInSeconds - b.freeInSeconds);
  for (const need of needs) {
    const pick = byEta.find((c) => c.officer.type === "police" && !used.has(c.officer.id));
    if (pick) {
      used.add(pick.officer.id);
      team.push(pick);
    } else missing.push(need);
  }
  return { team, missing };
}

export interface BoardCase {
  incident: Incident;
  priority: Priority;
  /** How many more officers this case still needs (needs.length - active assignments). */
  slots: number;
  needs: Need[];
}

/**
 * Globally reserve officers across open cases so one unit isn't recommended for two calls.
 * Higher priority (lower P number) and live calls win first.
 */
export function reserveAcrossBoard(
  cases: BoardCase[],
  candidatesFor: (inc: Incident) => Candidate[],
): Map<string, Candidate[]> {
  const reserved = new Set<string>();
  const out = new Map<string, Candidate[]>();
  const ordered = [...cases].sort((a, b) => {
    const liveA = a.incident.callEndedAt ? 1 : 0;
    const liveB = b.incident.callEndedAt ? 1 : 0;
    return liveA - liveB || a.priority - b.priority || a.incident.createdAt - b.incident.createdAt;
  });
  for (const c of ordered) {
    if (c.slots <= 0) {
      out.set(c.incident.id, []);
      continue;
    }
    const needs = c.needs.slice(0, c.slots);
    const { team } = pickTeam(c.incident, needs, candidatesFor(c.incident), reserved);
    for (const t of team) reserved.add(t.officer.id);
    out.set(c.incident.id, team);
  }
  return out;
}
