"use client";
// MapLibre campus map for /console: light/dark vector streets, 2025 satellite, 2020 NJ leaf-off
// imagery, 3D buildings, real routes, officer figures with GPS accuracy rings.
import "maplibre-gl/dist/maplibre-gl.css";
import maplibregl from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { CLOSURES } from "@/lib/campus";
import type { Incident, LatLng, Officer, OfficerStatus, Priority } from "@/lib/types";

export interface ConsoleRoute {
  id: string;
  points: LatLng[];
  foot: boolean;
  kind: "proposed" | "assigned";
}

type Base = "street" | "sat" | "nj";
const STYLE = { dark: "https://tiles.openfreemap.org/styles/dark", light: "https://tiles.openfreemap.org/styles/liberty" };
/** Princeton Public Safety HQ, across Baker Lane from Hobey Baker Rink (confirmed by the team on site). */
export const PSAFE_HQ: LatLng = [40.34368, -74.65727];
const STATUS_VAR: Record<OfficerStatus, string> = { available: "--available", responding: "--sent", on_scene: "--onscene", busy: "--busy" };
const ll = ([lat, lng]: LatLng): [number, number] => [lng, lat];

const figure = (c: string) => `<svg width="26" height="34" viewBox="0 0 30 38" aria-hidden="true">
  <ellipse cx="15" cy="35" rx="10" ry="3" fill="#000" opacity="0.2"/><rect x="6" y="15" width="18" height="18" rx="6" fill="${c}"/>
  <circle cx="15" cy="9" r="7" fill="#E9C9A8"/><path d="M7 7 Q15 -1 23 7 L23 8 L7 8 Z" fill="#26324A"/>
  <rect x="7" y="7" width="16" height="2.5" fill="#1A2234"/>
  <path d="M15 19 l1.6 3 3.2.4-2.4 2.2.7 3.2-3.1-1.6-3.1 1.6.7-3.2-2.4-2.2 3.2-.4z" fill="#F3E3B0"/></svg>`;
const ICON = {
  car: '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5 11l1.5-4.5A2 2 0 0 1 8.4 5h7.2a2 2 0 0 1 1.9 1.5L19 11v6a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-1H8v1a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1zm2.2-1h9.6l-1-3H8.2zM7.5 14a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5m9 0a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5"/></svg>',
  foot: '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="13" cy="4" r="2"/><path d="M9.8 8.9L7 20h2.1l1.8-8 2.1 2v6h2v-7.5l-2.1-2 .6-3A7.3 7.3 0 0 0 19 12v-2a5 5 0 0 1-4.3-2.4l-1-1.6a2 2 0 0 0-2.5-.8L6 7.3V12h2V8.6z"/></svg>',
};
const TYPE_TAG = { police: "", ems: " EMS", fire: " FIRE" };
// Position updates arrive every ~300-500 ms (trip ticks, phone GPS). Glide linearly to each new point,
// taking as long as the gap since the previous update, so units move at a steady pace with no pauses.
// A new target mid-glide starts from where the marker is.
const glides = new WeakMap<maplibregl.Marker, { raf: number; target: string; last: number }>();
function glide(m: maplibregl.Marker, to: [number, number]) {
  const g = glides.get(m);
  const key = to.join();
  if (g?.target === key) return; // same point re-rendered: let the current glide finish
  if (g) cancelAnimationFrame(g.raf);
  const now = performance.now();
  const from = m.getLngLat();
  const dx = to[0] - from.lng, dy = to[1] - from.lat;
  if (!g || Math.abs(dx) + Math.abs(dy) > 0.02) { m.setLngLat(to); glides.set(m, { raf: 0, target: key, last: now }); return; } // first fix, or a teleport (reset)
  const gap = now - g.last;
  const ms = gap > 1000 ? 400 : Math.max(150, gap); // first move after a rest: assume the usual tick
  const state = { raf: 0, target: key, last: now };
  glides.set(m, state);
  const step = (t: number) => {
    const k = Math.min(1, (t - now) / ms);
    m.setLngLat([from.lng + dx * k, from.lat + dy * k]);
    if (k < 1) state.raf = requestAnimationFrame(step);
  };
  state.raf = requestAnimationFrame(step);
}
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export default function ConsoleMap({
  officers, incident, priority, routes, teamIds, theme, fitKey,
}: {
  officers: Officer[];
  incident: Incident | null;
  priority: Priority | null;
  routes: ConsoleRoute[];
  teamIds: string[];
  theme: "dark" | "light";
  fitKey: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markers = useRef(new Map<string, maplibregl.Marker>());
  const incidentMarker = useRef<maplibregl.Marker | null>(null);
  const latest = useRef({ routes, incident, teamIds });
  const [base, setBase] = useState<Base>("street");
  const [tilted, setTilted] = useState(false);
  const [ready, setReady] = useState(0); // bumps on every (re)loaded style
  const baseRef = useRef<Base>("street");

  useEffect(() => {
    latest.current = { routes, incident, teamIds };
  });

  const cssVar = (name: string) => (box.current ? getComputedStyle(box.current).getPropertyValue(name).trim() : "#888");

  // ---- create / destroy ----
  useEffect(() => {
    const map = new maplibregl.Map({
      container: box.current!.querySelector<HTMLDivElement>(".dc-map-gl")!,
      style: STYLE[theme],
      center: [-74.6555, 40.3465],
      zoom: 15.6,
      attributionControl: { compact: true },
      canvasContextAttributes: { preserveDrawingBuffer: true }, // map stays visible in screen recordings
    });
    mapRef.current = map;
    const markerMap = markers.current;

    const pin = (html: string, at: LatLng, z: number) => {
      const el = document.createElement("div");
      el.className = "dc-pin";
      el.style.zIndex = String(z);
      el.innerHTML = html;
      return new maplibregl.Marker({ element: el }).setLngLat(ll(at)).addTo(map);
    };
    const star = '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l2.9 6.6 7.1.6-5.4 4.7 1.6 7L12 17.3 5.8 21l1.6-7L2 9.2l7.1-.6z" fill="#F2C230" stroke="#7A5A00" stroke-width="1"/></svg>';
    pin(`<div class="dc-station"><span title="Headquarters">${star}</span><b>HQ · Princeton Public Safety</b></div>`, PSAFE_HQ, 2);
    for (const c of CLOSURES) {
      const [[s, w], [n, e]] = c.bounds;
      pin(`<div class="dc-zone">${esc(c.label.replace(" (simulated)", ""))}</div>`, [(s + n) / 2, (w + e) / 2], 1);
    }
    incidentMarker.current = pin("", [40.3465, -74.6555], 3);
    incidentMarker.current.getElement().style.display = "none";

    map.on("style.load", () => {
      const firstLabel = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
      const dark = box.current?.closest(".dc")?.getAttribute("data-theme") !== "light";
      if (dark) tuneDark(map, firstLabel);
      map.addSource("sat", { type: "raster", tileSize: 128, maxzoom: 19, attribution: "Imagery &copy; Esri / Vantor, Apr 2025",
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"] });
      map.addLayer({ id: "sat", type: "raster", source: "sat", layout: { visibility: "none" } }, firstLabel);
      map.addSource("nj", { type: "raster", tileSize: 128, maxzoom: 20, attribution: "Imagery &copy; NJ Office of GIS 2020",
        tiles: ["https://maps.nj.gov/arcgis/rest/services/Basemap/Orthos_Natural_2020_NJ_WM/MapServer/tile/{z}/{y}/{x}"] });
      map.addLayer({ id: "nj", type: "raster", source: "nj", layout: { visibility: "none" } }, firstLabel);

      map.addSource("closures", { type: "geojson", data: {
        type: "FeatureCollection",
        features: CLOSURES.map((c) => {
          const [[s, w], [n, e]] = c.bounds;
          return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] } };
        }),
      } });
      map.addLayer({ id: "closures-fill", type: "fill", source: "closures", paint: { "fill-color": "#F4B860", "fill-opacity": 0.35 } });
      map.addLayer({ id: "closures-line", type: "line", source: "closures", paint: { "line-color": "#B26A28", "line-width": 1.5, "line-dasharray": [3, 2] } });

      map.addSource("inc-bldg", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: "inc-bldg-fill", type: "fill", source: "inc-bldg", paint: { "fill-color": cssVar("--p1"), "fill-opacity": 0.2 } }, firstLabel);
      map.addLayer({ id: "inc-bldg-line", type: "line", source: "inc-bldg", paint: { "line-color": cssVar("--p1"), "line-width": 2.5 } }, firstLabel);

      map.addSource("routes", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      const color = ["match", ["get", "kind"], "assigned", cssVar("--sent"), cssVar("--available")] as unknown as string;
      map.addLayer({ id: "routes-casing", type: "line", source: "routes", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": cssVar("--casing"), "line-width": 9 } });
      map.addLayer({ id: "routes-car", type: "line", source: "routes", filter: ["!", ["get", "foot"]], layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": color, "line-width": 5 } });
      map.addLayer({ id: "routes-foot", type: "line", source: "routes", filter: ["get", "foot"], layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": color, "line-width": 5, "line-dasharray": [0.5, 2] } });
      applyBase(map, baseRef.current);
      setReady((r) => r + 1);
    });
    map.on("zoom", () => sizeHalos(map));

    return () => {
      markerMap.forEach((m) => m.remove());
      markerMap.clear();
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- create once; theme changes swap the style below
  }, []);

  // ---- theme: reload the base style (style.load re-adds our layers) ----
  const firstTheme = useRef(theme);
  useEffect(() => {
    if (firstTheme.current === theme) return;
    firstTheme.current = theme;
    mapRef.current?.setStyle(STYLE[theme], { diff: false });
  }, [theme]);

  // ---- base layer ----
  useEffect(() => {
    baseRef.current = base;
    if (mapRef.current?.getLayer("sat")) applyBase(mapRef.current, base);
  }, [base, ready]);

  // ---- routes ----
  useEffect(() => {
    const src = mapRef.current?.getSource("routes") as maplibregl.GeoJSONSource | undefined;
    src?.setData({
      type: "FeatureCollection",
      features: routes.filter((r) => r.points.length > 1).map((r) => ({
        type: "Feature", properties: { foot: r.foot, kind: r.kind }, geometry: { type: "LineString", coordinates: r.points.map(ll) },
      })),
    });
  }, [routes, ready]);

  // ---- officers ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const seen = new Set<string>();
    officers.forEach((o, n) => {
      seen.add(o.id);
      let m = markers.current.get(o.id);
      if (!m) {
        const el = document.createElement("div");
        el.className = "dc-pin";
        m = new maplibregl.Marker({ element: el, subpixelPositioning: true }).setLngLat(ll(o.location)).addTo(map);
        markers.current.set(o.id, m);
      }
      const color = cssVar(STATUS_VAR[o.status]);
      const rec = teamIds.includes(o.id) && o.status !== "on_scene";
      const at: LatLng = o.status === "on_scene" ? [o.location[0], o.location[1] + n * 0.00011] : o.location;
      glide(m, ll(at));
      const el = m.getElement();
      el.style.zIndex = rec ? "6" : "4";
      const acc = o.mode === "foot" ? 8 : 5; // simulated GPS accuracy (m); phone GPS outdoors is ~3-10 m
      el.innerHTML = `<span class="dc-halo" data-acc="${acc}" style="background:${color}22;border:1px solid ${color}88"></span>
        <div class="dc-officer${rec ? " rec" : ""}"><div class="fig" style="border-color:${color}">${figure(color)}<i class="mode" title="${o.mode === "foot" ? "On foot" : "Vehicle"}">${ICON[o.mode]}</i></div>
        <span class="tag" style="border-color:${color}">${esc(o.callsign)}${TYPE_TAG[o.type]}</span></div>`;
    });
    markers.current.forEach((m, id) => { if (!seen.has(id)) { m.remove(); markers.current.delete(id); } });
    sizeHalos(map);
  }, [officers, teamIds, theme, ready]);

  // ---- incident pin + building outline ----
  useEffect(() => {
    const map = mapRef.current;
    const m = incidentMarker.current;
    if (!map || !m) return;
    const el = m.getElement();
    if (!incident) {
      el.style.display = "none";
      (map.getSource("inc-bldg") as maplibregl.GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: [] });
      return;
    }
    const pc = priority ? `var(--p${priority})` : "var(--faint)";
    el.style.display = "";
    m.setLngLat(ll(incident.location));
    el.innerHTML = `<div class="dc-incident">
      <span style="width:36px;height:36px;background:color-mix(in srgb, ${pc} 22%, transparent);border:1px solid ${pc}"></span>
      <span style="width:14px;height:14px;background:${pc};border:2px solid var(--panel)"></span>
      <b style="border-color:${pc}">${priority ? `P${priority} · ` : ""}${esc(incident.title.split(":")[0])}</b></div>`;
    const outline = () => highlightBuilding(map, incident.location);
    if (map.loaded()) outline();
    map.once("idle", outline);
  }, [incident, priority, ready]);

  // ---- fit to incident + routes when the plan changes ----
  const fit = () => {
    const map = mapRef.current;
    const { incident: inc, routes: rs } = latest.current;
    if (!map || !inc) return;
    const pts: LatLng[] = [inc.location, ...rs.flatMap((r) => r.points)];
    const b = new maplibregl.LngLatBounds(ll(pts[0]), ll(pts[0]));
    pts.forEach((p) => b.extend(ll(p)));
    map.resize();
    map.fitBounds(b, { padding: { top: 70, left: 60, right: 70, bottom: 40 }, maxZoom: 17.4, pitch: map.getPitch(), duration: 600 });
  };
  useEffect(() => {
    if (fitKey) fit(); // refit only when the plan identity changes
  }, [fitKey, ready]);

  return (
    <div className="dc-map" ref={box}>
      <div className="dc-map-gl" />
      <div className="dc-layers dc-seg" role="group" aria-label="Map style">
        {([["street", "Map"], ["sat", "Satellite 2025"], ["nj", "NJ leaf-off 2020"]] as const).map(([k, label]) => (
          <button key={k} type="button" aria-pressed={base === k} onClick={() => setBase(k)}
            title={k === "sat" ? "Esri / Vantor satellite, April 2025" : k === "nj" ? "NJ state aerial 2020, no leaves: paths under trees are visible" : undefined}>
            {label}
          </button>
        ))}
      </div>
      <div className="dc-zoom">
        <button type="button" aria-label="Zoom in" onClick={() => mapRef.current?.zoomIn()}>+</button>
        <button type="button" aria-label="Zoom out" onClick={() => mapRef.current?.zoomOut()}>−</button>
        <button type="button" aria-label="Tilt to 3D" aria-pressed={tilted}
          onClick={() => { const t = !tilted; setTilted(t); mapRef.current?.easeTo({ pitch: t ? 55 : 0, bearing: t ? -20 : 0 }); }}>3D</button>
        <button type="button" aria-label="Show incident and units" onClick={fit}>◎</button>
      </div>
    </div>
  );
}

// ---- helpers ----
function applyBase(map: maplibregl.Map, base: Base) {
  (["sat", "nj"] as const).forEach((id) => map.getLayer(id) && map.setLayoutProperty(id, "visibility", base === id ? "visible" : "none"));
  // 3D blocks would hide rooftops in the photos, so they only show on the street map.
  if (map.getLayer("building-3d")) map.setLayoutProperty("building-3d", "visibility", base === "street" ? "visible" : "none");
}

/** The stock dark style is too dim to dispatch from: lift roads, paths, buildings and labels; add names + 3D. */
function tuneDark(map: maplibregl.Map, firstLabel?: string) {
  const set = (id: string, prop: string, v: string) => map.getLayer(id) && map.setPaintProperty(id, prop, v);
  set("building", "fill-color", "#2A3646");
  set("landuse_park", "fill-color", "#16271F");
  set("landcover_wood", "fill-color", "#16271F");
  set("water", "fill-color", "#0E2236");
  set("highway_path", "line-color", "#6B7C92");
  set("highway_minor", "line-color", "#4A5A6E");
  set("highway_major_inner", "line-color", "#5D6E84");
  set("highway_major_casing", "line-color", "#2B3747");
  for (const id of ["highway_name_other", "highway_name_motorway"]) { set(id, "text-color", "#B9C4D2"); set(id, "text-halo-color", "#121922"); }
  map.addLayer({ id: "building-3d", type: "fill-extrusion", source: "openmaptiles", "source-layer": "building", minzoom: 15,
    paint: { "fill-extrusion-color": "#2E3B4D", "fill-extrusion-opacity": 0.92,
      "fill-extrusion-height": ["coalesce", ["get", "render_height"], 8], "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0] } }, firstLabel);
  map.addLayer({ id: "poi-names", type: "symbol", source: "openmaptiles", "source-layer": "poi", minzoom: 15.5,
    layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"], "text-size": 11, "text-max-width": 8 },
    paint: { "text-color": "#AEBACB", "text-halo-color": "#121922", "text-halo-width": 1.4 } });
}

function sizeHalos(map: maplibregl.Map) {
  const mpp = (156543.034 * Math.cos((map.getCenter().lat * Math.PI) / 180)) / 2 ** map.getZoom();
  map.getContainer().parentElement?.querySelectorAll<HTMLElement>(".dc-halo").forEach((h) => {
    h.style.width = h.style.height = `${(2 * Number(h.dataset.acc)) / mpp}px`;
  });
}

/** Outline the building the caller is in (footprint from the OpenStreetMap tiles). */
function highlightBuilding(map: maplibregl.Map, at: LatLng) {
  const src = map.getSource("inc-bldg") as maplibregl.GeoJSONSource | undefined;
  if (!src) return;
  const layers = map.getStyle().layers.filter((l) => "source-layer" in l && l["source-layer"] === "building").map((l) => l.id);
  const hit = map.queryRenderedFeatures(map.project(ll(at)), { layers })[0];
  if (!hit || (hit.geometry.type !== "Polygon" && hit.geometry.type !== "MultiPolygon")) return src.setData({ type: "FeatureCollection", features: [] });
  // Tiles merge many buildings into one MultiPolygon; keep only the one containing the caller.
  const [x, y] = ll(at);
  const inside = (ring: number[][]) => ring.reduce((c, [xi, yi], i) => {
    const [xj, yj] = ring[(i || ring.length) - 1];
    return (yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi ? !c : c;
  }, false);
  const polys = hit.geometry.type === "Polygon" ? [hit.geometry.coordinates] : hit.geometry.coordinates;
  const mine = polys.find((p) => inside(p[0]));
  src.setData(mine ? { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: mine } } : { type: "FeatureCollection", features: [] });
}
