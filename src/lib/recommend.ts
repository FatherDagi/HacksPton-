// Deterministic unit recommendation with SIMULATED travel estimates.
import { CLOSURES } from "./campus";
import type { Incident, IncidentCategory, LatLng, Officer, Recommendation, ResponderType } from "./types";

const R = 6371000;
export function haversine(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Preferred responder types per category, most preferred first. */
export const ELIGIBLE: Record<IncidentCategory, ResponderType[]> = {
  medical: ["ems", "police"],
  fire: ["fire", "police"],
  police: ["police"],
  other: ["police"],
};

const SPEED_MPS = { car: 6.7, foot: 1.4 }; // ~15 mph campus driving, walking pace
const ROAD_FACTOR = 1.3; // straight line -> path network
const CLOSURE_PENALTY_S = 60;

function crossesBox(a: LatLng, b: LatLng, box: [LatLng, LatLng]): boolean {
  const [[s, w], [n, e]] = box;
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    const lat = a[0] + (b[0] - a[0]) * t;
    const lng = a[1] + (b[1] - a[1]) * t;
    if (lat >= s && lat <= n && lng >= w && lng <= e) return true;
  }
  return false;
}

export function planRoute(from: LatLng, to: LatLng, mode: Officer["mode"]) {
  let route: LatLng[] = [from, to];
  let avoidsClosure: string | null = null;
  for (const c of CLOSURES) {
    if (mode === "car" && crossesBox(from, to, c.bounds)) {
      route = [from, c.detour, to];
      avoidsClosure = c.label;
      break;
    }
  }
  let dist = 0;
  for (let i = 1; i < route.length; i++) dist += haversine(route[i - 1], route[i]);
  dist *= ROAD_FACTOR;
  const eta = dist / SPEED_MPS[mode] + (avoidsClosure ? CLOSURE_PENALTY_S : 0);
  return { route, distanceMeters: dist, etaSeconds: Math.round(eta), avoidsClosure };
}

export function rankUnits(incident: Incident, officers: Officer[]): Recommendation[] {
  const types = ELIGIBLE[incident.category];
  const eligible = officers.filter(
    (o) => o.status === "available" && types.includes(o.type) && !incident.declinedOfficerIds.includes(o.id),
  );
  const scored = eligible.map((o) => ({ o, ...planRoute(o.location, incident.location, o.mode) }));
  scored.sort((a, b) => types.indexOf(a.o.type) - types.indexOf(b.o.type) || a.etaSeconds - b.etaSeconds);
  return scored.map((s, i) => {
    const typeName = { police: "officer", ems: "EMS unit", fire: "fire unit" }[s.o.type];
    const parts = [
      `${s.o.callsign} is the ${i === 0 ? "best" : `#${i + 1}`} available ${typeName}`,
      `about ${formatEta(s.etaSeconds)} away ${s.o.mode === "foot" ? "on foot" : "by car"} (simulated)`,
    ];
    if (types.indexOf(s.o.type) > 0) parts.push(`no available ${types[0]} unit ranks ahead`);
    if (s.avoidsClosure) parts.push(`route avoids ${s.avoidsClosure}`);
    return {
      officer: s.o,
      etaSeconds: s.etaSeconds,
      distanceMeters: s.distanceMeters,
      route: s.route,
      avoidsClosure: s.avoidsClosure,
      reason: parts.join("; ") + ".",
    };
  });
}

export function formatEta(sec: number): string {
  if (sec < 60) return "under 1 min";
  return `${Math.round(sec / 60)} min`;
}

export const formatMiles = (m: number) => `${(m / 1609).toFixed(2)} mi`;
