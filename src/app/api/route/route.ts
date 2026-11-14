// Road routing proxy. Browsers on venue Wi-Fi (or with strict CORS) often can't reach the public
// OSRM servers directly, but the laptop running the server can. Tries two servers in turn.
import { NextResponse } from "next/server";

const SERVERS: Record<string, string[]> = {
  car: ["https://routing.openstreetmap.de/routed-car/route/v1/driving", "https://router.project-osrm.org/route/v1/driving"],
  foot: ["https://routing.openstreetmap.de/routed-foot/route/v1/driving"],
};
const num = /^-?\d{1,3}\.\d+,-?\d{1,3}\.\d+$/;

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const mode = q.get("mode") === "foot" ? "foot" : "car";
  const from = q.get("from") ?? "", to = q.get("to") ?? "";
  if (!num.test(from) || !num.test(to)) return NextResponse.json({ error: "from/to must be lng,lat" }, { status: 400 });
  for (const base of SERVERS[mode]) {
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
