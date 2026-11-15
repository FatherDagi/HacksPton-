// Real road / footpath routes from OpenStreetMap (via /api/route → Valhalla/OSRM).
// Offline fallback walks the dense CAMPUS_WAYS grid so yellow busy legs still hug streets.
import { CAMPUS_WAYS, CLOSURES } from "../campus";
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
const SNAP_M = 90;
const JUNCTION_M = 55;

const cache = new Map<string, Promise<RoutePlan>>();
const key = (a: LatLng, b: LatLng, m: TravelMode) => `${m}:${a[0].toFixed(5)},${a[1].toFixed(5)}>${b[0].toFixed(5)},${b[1].toFixed(5)}`;

function closureOn(route: LatLng[]): string | null {
  for (const c of CLOSURES) {
    const [[s, w], [n, e]] = c.bounds;
    if (route.some(([lat, lng]) => lat >= s && lat <= n && lng >= w && lng <= e)) return c.label;
  }
  return null;
}

type NetNode = { id: number; at: LatLng; edges: { to: number; dist: number; via: LatLng[] }[] };

/** Densify a way so offline polylines hug the street instead of long chords. */
function densifyWay(way: LatLng[], stepM = 22): LatLng[] {
  const out: LatLng[] = [way[0]];
  for (let i = 1; i < way.length; i++) {
    const a = way[i - 1], b = way[i];
    const d = haversine(a, b);
    const n = Math.max(1, Math.ceil(d / stepM));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

/** Build a walkable graph from campus way polylines (shared near-junctions link ways). */
function buildCampusGraph(): NetNode[] {
  const nodes: NetNode[] = [];
  const add = (at: LatLng) => {
    const id = nodes.length;
    nodes.push({ id, at, edges: [] });
    return id;
  };
  const link = (a: number, b: number, via: LatLng[]) => {
    let dist = 0;
    for (let i = 1; i < via.length; i++) dist += haversine(via[i - 1], via[i]);
    if (dist < 1) dist = haversine(nodes[a].at, nodes[b].at);
    nodes[a].edges.push({ to: b, dist, via });
    nodes[b].edges.push({ to: a, dist, via: [...via].reverse() });
  };
  for (const raw of CAMPUS_WAYS) {
    const way = densifyWay(raw);
    const ids: number[] = [];
    for (const p of way) ids.push(add(p));
    for (let i = 0; i < ids.length - 1; i++) {
      link(ids[i], ids[i + 1], [way[i], way[i + 1]]);
    }
  }
  // Connect nearby nodes across different ways so the grid is fully traversable.
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const d = haversine(nodes[i].at, nodes[j].at);
      if (d > 0 && d < JUNCTION_M && !nodes[i].edges.some((e) => e.to === j)) {
        link(i, j, [nodes[i].at, nodes[j].at]);
      }
    }
  }
  return nodes;
}

let GRAPH: NetNode[] | null = null;
const graph = () => (GRAPH ??= buildCampusGraph());

function nearestNode(at: LatLng): { id: number; dist: number } {
  let best = 0;
  let bd = Infinity;
  for (const n of graph()) {
    const d = haversine(at, n.at);
    if (d < bd) { bd = d; best = n.id; }
  }
  return { id: best, dist: bd };
}

/** Offline fallback: snap to campus ways and Dijkstra along the street grid (not a straight cut). */
function campusRoadRoute(from: LatLng, to: LatLng, mode: TravelMode): RoutePlan {
  const g = graph();
  const a = nearestNode(from);
  const b = nearestNode(to);
  const dist = new Array(g.length).fill(Infinity);
  const prev = new Array<number | null>(g.length).fill(null);
  const prevVia = new Array<LatLng[] | null>(g.length).fill(null);
  dist[a.id] = 0;
  const pq: { id: number; d: number }[] = [{ id: a.id, d: 0 }];
  while (pq.length) {
    pq.sort((x, y) => x.d - y.d);
    const cur = pq.shift()!;
    if (cur.d !== dist[cur.id]) continue;
    if (cur.id === b.id) break;
    for (const e of g[cur.id].edges) {
      const nd = cur.d + e.dist;
      if (nd < dist[e.to]) {
        dist[e.to] = nd;
        prev[e.to] = cur.id;
        prevVia[e.to] = e.via;
        pq.push({ id: e.to, d: nd });
      }
    }
  }
  const route: LatLng[] = [];
  if (a.dist > 8) route.push(from);
  if (Number.isFinite(dist[b.id])) {
    const chain: LatLng[][] = [];
    for (let cur = b.id; cur !== a.id && prev[cur] != null; cur = prev[cur]!) {
      chain.push(prevVia[cur] ?? [g[prev[cur]!].at, g[cur].at]);
    }
    chain.reverse();
    route.push(g[a.id].at);
    for (const via of chain) {
      for (const p of via.slice(1)) route.push(p);
    }
  } else {
    route.push(g[a.id].at, g[b.id].at);
  }
  if (b.dist > 8) route.push(to);
  // Dedup consecutive duplicates
  const clean: LatLng[] = [];
  for (const p of route) {
    const last = clean[clean.length - 1];
    if (!last || Math.abs(last[0] - p[0]) + Math.abs(last[1] - p[1]) > 1e-7) clean.push(p);
  }
  if (clean.length < 2) clean.push(from, to);
  let meters = 0;
  for (let i = 1; i < clean.length; i++) meters += haversine(clean[i - 1], clean[i]);
  // If snap was absurdly far, fall back to recommend's detour estimate.
  if (a.dist > SNAP_M * 2 && b.dist > SNAP_M * 2) {
    return { ...planRoute(from, to, mode), real: false };
  }
  const avoidsClosure = mode === "car" ? closureOn(clean) : null;
  return {
    route: clean,
    distanceMeters: meters,
    etaSeconds: Math.round(meters / SPEED_MPS[mode] + (avoidsClosure ? CLOSURE_PENALTY_S : 0)),
    avoidsClosure,
    real: false,
  };
}

/** Estimate synchronously (used until the real route arrives). */
export function estimate(from: LatLng, to: LatLng, mode: TravelMode): RoutePlan {
  const road = campusRoadRoute(from, to, mode);
  if (road.route.length > 2) return road;
  return { ...planRoute(from, to, mode), real: false };
}

function planFromGeometry(distance: number, coordinates: [number, number][], mode: TravelMode): RoutePlan {
  const route = coordinates.map(([lng, lat]) => [lat, lng] as LatLng);
  // Simulated closures are not in OpenStreetMap: flag them and add the same penalty the simulator uses.
  const avoidsClosure = mode === "car" ? closureOn(route) : null;
  return {
    route,
    distanceMeters: distance,
    etaSeconds: Math.round(distance / SPEED_MPS[mode] + (avoidsClosure ? CLOSURE_PENALTY_S : 0)),
    avoidsClosure,
    real: true,
  };
}

export function fetchRoute(from: LatLng, to: LatLng, mode: TravelMode): Promise<RoutePlan> {
  const k = key(from, to, mode);
  const hit = cache.get(k);
  if (hit) return hit;
  const p = (async () => {
    try {
      // Through our server (/api/route), which can reach the routers even when the browser can't.
      const res = await fetch(`/api/route?mode=${mode}&from=${from[1]},${from[0]}&to=${to[1]},${to[0]}`);
      if (res.ok) {
        const j = (await res.json()) as { distance?: number; coordinates?: [number, number][] };
        if (j.coordinates?.length && typeof j.distance === "number") return planFromGeometry(j.distance, j.coordinates, mode);
      }
    } catch { /* proxy unreachable: try the public router directly */ }
    try {
      // FOSSGIS profile servers still use /driving/ in the path; the server itself is car or foot.
      const url = `${ROUTER[mode]}/route/v1/driving/${from[1]},${from[0]};${to[1]},${to[0]}?overview=full&geometries=geojson`;
      const res = await fetch(url);
      const j = (await res.json()) as { routes?: { distance: number; geometry: { coordinates: [number, number][] } }[] };
      const best = j.routes?.[0];
      if (best) return planFromGeometry(best.distance, best.geometry.coordinates, mode);
    } catch { /* offline: campus roads / straight-line estimate */ }
    cache.delete(k); // allow a retry later
    return estimate(from, to, mode);
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

/** The part of a planned route still ahead of a unit at `at` (nearest vertex onward). */
export function remaining(route: LatLng[], at: LatLng): LatLng[] {
  let best = 0, bd = Infinity;
  route.forEach(([la, ln], i) => { const d = (la - at[0]) ** 2 + (ln - at[1]) ** 2; if (d < bd) { bd = d; best = i; } });
  const rest = route.slice(best + 1);
  return [at, ...(rest.length ? rest : route.slice(-1))]; // always keep the destination
}
