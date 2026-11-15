// Road routing proxy. Browsers on venue Wi-Fi (or with strict CORS) often can't reach the public
// routers directly, but the laptop running the server can. Tries Valhalla, then OSRM mirrors.
import { NextResponse } from "next/server";

const OSRM: Record<string, string[]> = {
  car: ["https://routing.openstreetmap.de/routed-car/route/v1/driving", "https://router.project-osrm.org/route/v1/driving"],
  foot: ["https://routing.openstreetmap.de/routed-foot/route/v1/driving"],
};
const VALHALLA = "https://valhalla1.openstreetmap.de/route";
const num = /^-?\d{1,3}\.\d+,-?\d{1,3}\.\d+$/;

/** Decode Valhalla's polyline6 into GeoJSON [lng, lat][]. */
function decodePolyline6(encoded: string): [number, number][] {
  let index = 0;
  let lat = 0;
  let lng = 0;
  const out: [number, number][] = [];
  const factor = 1e6;
  while (index < encoded.length) {
    let b = 0;
    let shift = 0;
    let result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    out.push([lng / factor, lat / factor]);
  }
  return out;
}

async function fromValhalla(fromLng: number, fromLat: number, toLng: number, toLat: number, mode: "car" | "foot") {
  const res = await fetch(VALHALLA, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(6000),
    body: JSON.stringify({
      locations: [
        { lat: fromLat, lon: fromLng },
        { lat: toLat, lon: toLng },
      ],
      costing: mode === "foot" ? "pedestrian" : "auto",
      directions_options: { units: "kilometers" },
    }),
  });
  if (!res.ok) return null;
  const j = (await res.json()) as {
    trip?: { summary?: { length?: number }; legs?: { shape?: string }[] };
  };
  const shape = j.trip?.legs?.map((l) => l.shape).filter(Boolean).join("") ?? "";
  // Valhalla returns one shape per leg; decode and concat (shared vertices ok).
  const coords: [number, number][] = [];
  for (const leg of j.trip?.legs ?? []) {
    if (!leg.shape) continue;
    const pts = decodePolyline6(leg.shape);
    if (!pts.length) continue;
    if (coords.length && pts[0][0] === coords[coords.length - 1][0] && pts[0][1] === coords[coords.length - 1][1]) {
      coords.push(...pts.slice(1));
    } else {
      coords.push(...pts);
    }
  }
  if (coords.length < 2) return null;
  const km = j.trip?.summary?.length ?? 0;
  return { distance: km * 1000, coordinates: coords };
}

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const mode = q.get("mode") === "foot" ? "foot" : "car";
  const from = q.get("from") ?? "", to = q.get("to") ?? "";
  if (!num.test(from) || !num.test(to)) return NextResponse.json({ error: "from/to must be lng,lat" }, { status: 400 });
  const [fromLng, fromLat] = from.split(",").map(Number) as [number, number];
  const [toLng, toLat] = to.split(",").map(Number) as [number, number];

  try {
    const v = await fromValhalla(fromLng, fromLat, toLng, toLat, mode);
    if (v) return NextResponse.json(v);
  } catch { /* try OSRM */ }

  for (const base of OSRM[mode]) {
    try {
      const res = await fetch(`${base}/${from};${to}?overview=full&geometries=geojson`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) continue;
      const j = (await res.json()) as { routes?: { distance: number; geometry: { coordinates: [number, number][] } }[] };
      const best = j.routes?.[0];
      if (best) return NextResponse.json({ distance: best.distance, coordinates: best.geometry.coordinates });
    } catch { /* try the next server */ }
  }
  return NextResponse.json({ error: "no router reachable" }, { status: 502 });
}
