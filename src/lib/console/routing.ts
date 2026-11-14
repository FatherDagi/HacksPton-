// Real road / footpath routes from OpenStreetMap (FOSSGIS public OSRM servers).
// Falls back to the simulated straight-line planner when offline.
import { CLOSURES } from "../campus";
import { haversine, planRoute } from "../recommend";
import type { LatLng, TravelMode } from "../types";

export interface RoutePlan {
  route: LatLng[];
  distanceMeters: number;
  etaSeconds: number;
  avoidsClosure: string | null;
  /** true = real OpenStreetMap route; false = simulated estimate. */
  real: boolean;
}

const ROUTER: Record<TravelMode, string> = {
  car: "https://routing.openstreetmap.de/routed-car",
  foot: "https://routing.openstreetmap.de/routed-foot",
};
const SPEED_MPS: Record<TravelMode, number> = { car: 6.7, foot: 1.4 }; // same campus speeds as lib/recommend
const CLOSURE_PENALTY_S = 60;

const cache = new Map<string, Promise<RoutePlan>>();
const key = (a: LatLng, b: LatLng, m: TravelMode) => `${m}:${a[0].toFixed(5)},${a[1].toFixed(5)}>${b[0].toFixed(5)},${b[1].toFixed(5)}`;

function closureOn(route: LatLng[]): string | null {
  for (const c of CLOSURES) {
    const [[s, w], [n, e]] = c.bounds;
    if (route.some(([lat, lng]) => lat >= s && lat <= n && lng >= w && lng <= e)) return c.label;
  }
  return null;
}

/** Estimate synchronously (used until the real route arrives). */
export function estimate(from: LatLng, to: LatLng, mode: TravelMode): RoutePlan {
  return { ...planRoute(from, to, mode), real: false };
}

export function fetchRoute(from: LatLng, to: LatLng, mode: TravelMode): Promise<RoutePlan> {
  const k = key(from, to, mode);
  const hit = cache.get(k);
  if (hit) return hit;
  const p = (async () => {
    try {
      const url = `${ROUTER[mode]}/route/v1/driving/${from[1]},${from[0]};${to[1]},${to[0]}?overview=full&geometries=geojson`;
      const res = await fetch(url);
      const j = (await res.json()) as { routes?: { distance: number; geometry: { coordinates: [number, number][] } }[] };
      const best = j.routes?.[0];
      if (!best) throw new Error("no route");
      const route = best.geometry.coordinates.map(([lng, lat]) => [lat, lng] as LatLng);
      // Simulated closures are not in OpenStreetMap: flag them and add the same penalty the simulator uses.
      const avoidsClosure = mode === "car" ? closureOn(route) : null;
      return {
        route,
        distanceMeters: best.distance,
        etaSeconds: Math.round(best.distance / SPEED_MPS[mode] + (avoidsClosure ? CLOSURE_PENALTY_S : 0)),
        avoidsClosure,
        real: true,
      };
    } catch {
      cache.delete(k); // allow a retry later
      return estimate(from, to, mode);
    }
  })();
  cache.set(k, p);
  return p;
}

/** Point a fraction `k` (0..1) of the way along a route, plus the index of the next vertex. */
export function along(route: LatLng[], k: number): { at: LatLng; next: number } {
  if (route.length < 2) return { at: route[0], next: 1 };
  const cum = [0];
  for (let i = 1; i < route.length; i++) cum.push(cum[i - 1] + haversine(route[i - 1], route[i]));
  const d = Math.min(1, Math.max(0, k)) * cum[cum.length - 1];
  let i = cum.findIndex((c) => c >= d);
  if (i < 1) i = 1;
  const f = (d - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
  return { at: [route[i - 1][0] + (route[i][0] - route[i - 1][0]) * f, route[i - 1][1] + (route[i][1] - route[i - 1][1]) * f], next: i };
}
