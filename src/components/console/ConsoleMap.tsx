"use client";
// MapLibre campus map for /console: light/dark vector streets, 2025 satellite, 2020 NJ leaf-off
// imagery, 3D buildings, real routes, officer figures with GPS accuracy rings.
import "maplibre-gl/dist/maplibre-gl.css";
import maplibregl from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { PSAFE_HQ } from "@/lib/campus";
import type { Incident, LatLng, Officer, OfficerAvatar, OfficerStatus, Priority } from "@/lib/types";

const isHqStandby = (o: Officer) => /HQ/i.test(o.locationLabel) && o.status === "available";

export { PSAFE_HQ };

export interface ConsoleRoute {
  id: string;
  points: LatLng[];
  foot: boolean;
  /** proposed = AI pick · assigned = en route · patrol = free beat · history = completed trip · dest = busy/standby target */
  kind: "proposed" | "assigned" | "patrol" | "history" | "dest";
}

type Base = "street" | "sat" | "aerial";
/** Offset a call pin away from HQ so Whitman/HQ don't stack. */
const nearHq = (at: LatLng) => Math.abs(at[0] - PSAFE_HQ[0]) + Math.abs(at[1] - PSAFE_HQ[1]) < 0.0022;
const nudgeCall = (at: LatLng): LatLng =>
  nearHq(at) ? [at[0] + 0.00055, at[1] - 0.00045] : at;
/** Free-unit count badge — offset clear of the HQ building pin/label. */
const HQ_CLUSTER: LatLng = [PSAFE_HQ[0] - 0.00105, PSAFE_HQ[1] + 0.00085];
const STYLE = { dark: "https://tiles.openfreemap.org/styles/dark", light: "https://tiles.openfreemap.org/styles/liberty" };
/** Full campus frame — Nassau → Stadium → Whitman → EQuad. Always top-down overview. */
export const CAMPUS_BOUNDS: [[number, number], [number, number]] = [
  [-74.6632, 40.3410], // SW lng,lat
  [-74.6458, 40.3528], // NE
];
/** Free = green · busy / standby = amber · committed to a call = red */
const STATUS_VAR: Record<OfficerStatus, string> = { available: "--available", busy: "--busy", responding: "--committed", on_scene: "--committed" };
const ll = ([lat, lng]: LatLng): [number, number] => [lng, lat];

const DEFAULT_AVATAR: OfficerAvatar = { skin: "#E9C9A8", hair: "#2A1A12", hat: "#1A2234" };
/** Compact named officer figure — distinct face, status ring color. */
const figure = (status: string, av: OfficerAvatar = DEFAULT_AVATAR) => `<svg width="22" height="28" viewBox="0 0 30 38" aria-hidden="true">
  <ellipse cx="15" cy="35" rx="9" ry="2.5" fill="#000" opacity="0.3"/>
  <rect x="7" y="16" width="16" height="16" rx="5" fill="${status}"/>
  <circle cx="15" cy="9" r="6.5" fill="${av.skin}"/>
  <path d="M8 7 Q15 0 22 7 L22 8.5 L8 8.5 Z" fill="${av.hair}"/>
  <rect x="8" y="7" width="14" height="2" fill="${av.hat}"/>
</svg>`;
const ICON = {
  car: '<svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5 11l1.5-4.5A2 2 0 0 1 8.4 5h7.2a2 2 0 0 1 1.9 1.5L19 11v6a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-1H8v1a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1zm2.2-1h9.6l-1-3H8.2zM7.5 14a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5m9 0a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5"/></svg>',
  foot: '<svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="13" cy="4" r="2"/><path d="M9.8 8.9L7 20h2.1l1.8-8 2.1 2v6h2v-7.5l-2.1-2 .6-3A7.3 7.3 0 0 0 19 12v-2a5 5 0 0 1-4.3-2.4l-1-1.6a2 2 0 0 0-2.5-.8L6 7.3V12h2V8.6z"/></svg>',
};
// Position updates arrive every ~300-500 ms (trip ticks, patrol car GPS). Glide linearly to each new point,
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

function incidentTone(inc: Incident, hasUnit: boolean): "open" | "active" | "done" {
  if (inc.status === "closed") return "done";
  if (hasUnit || inc.status === "dispatched" || inc.status === "on_scene") return "active";
  return "open";
}

export default function ConsoleMap({
  officers, incident, priority, routes, teamIds, theme, fitKey, lostIds = [],
  selectedOfficerId = null, onSelectOfficer,
  incidents = [], selectedIncidentId = null, onSelectIncident, assignedIncidentIds = [],
  padLeft = 328,
  padRight = 280,
  padTop = 56,
  padBottom = 72,
}: {
  officers: Officer[];
  incident: Incident | null;
  priority: Priority | null;
  routes: ConsoleRoute[];
  teamIds: string[];
  theme: "dark" | "light";
  fitKey: string;
  lostIds?: string[];
  selectedOfficerId?: string | null;
  onSelectOfficer?: (officerId: string) => void;
  /** All campus calls drawn as status dots (red unassigned · amber active · green closed). */
  incidents?: Incident[];
  selectedIncidentId?: string | null;
  onSelectIncident?: (incidentId: string) => void;
  /** Incident ids that already have an active unit. */
  assignedIncidentIds?: string[];
  /** Map fit padding so campus sits in the visible lane beside UI chrome. */
  padLeft?: number;
  padRight?: number;
  padTop?: number;
  padBottom?: number;
}) {
  const trails = useRef(new Map<string, LatLng[]>());
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markers = useRef(new Map<string, maplibregl.Marker>());
  const callMarkers = useRef(new Map<string, maplibregl.Marker>());
  const mentionMarkers = useRef(new Map<string, maplibregl.Marker>());
  const incidentMarker = useRef<maplibregl.Marker | null>(null);
  const latest = useRef({ routes, incident, teamIds, onSelectOfficer, onSelectIncident, incidents, officers });
  const [base, setBase] = useState<Base>("street");
  const [tilted, setTilted] = useState(false);
  const [ready, setReady] = useState(0);
  const baseRef = useRef<Base>("street");
  const didCampusFit = useRef(false);
  const padRef = useRef({ left: padLeft, right: padRight, top: padTop, bottom: padBottom });
  padRef.current = { left: padLeft, right: padRight, top: padTop, bottom: padBottom };

  useEffect(() => {
    latest.current = { routes, incident, teamIds, onSelectOfficer, onSelectIncident, incidents, officers };
  });

  const cssVar = (name: string) => (box.current ? getComputedStyle(box.current).getPropertyValue(name).trim() : "#888");

  // ---- create / destroy ----
  useEffect(() => {
    const map = new maplibregl.Map({
      container: box.current!.querySelector<HTMLDivElement>(".dc-map-gl")!,
      style: STYLE.dark, // HQ always starts on the dark campus basemap
      center: [-74.6545, 40.3468],
      zoom: 14.6,
      maxPitch: 60,
      attributionControl: { compact: true },
      canvasContextAttributes: { preserveDrawingBuffer: true },
    });
    mapRef.current = map;
    const markerMap = markers.current;
    const mentionMap = mentionMarkers.current;

    const pin = (html: string, at: LatLng, z: number) => {
      const el = document.createElement("div");
      el.className = "dc-pin";
      el.style.zIndex = String(z);
      el.innerHTML = html;
      return new maplibregl.Marker({ element: el }).setLngLat(ll(at)).addTo(map);
    };
    const mark = '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" fill="#E77500"/><rect x="9" y="9" width="6" height="6" fill="#140F0A"/></svg>';
    pin(`<div class="dc-station"><span title="Headquarters">${mark}</span><b>HQ</b></div>`, PSAFE_HQ, 2);
    incidentMarker.current = pin("", [40.3465, -74.6555], 3);
    incidentMarker.current.getElement().style.display = "none";

    map.on("style.load", () => {
      const firstLabel = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
      const dark = box.current?.closest(".dc")?.getAttribute("data-theme") !== "light";
      if (dark) tuneDark(map, firstLabel);
      // Washed satellite (keeps docks readable) + true aerial (full-color, no gray wash).
      map.addSource("sat", { type: "raster", tileSize: 128, maxzoom: 19, attribution: "Imagery &copy; Esri / Vantor, Apr 2025",
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"] });
      map.addLayer({
        id: "sat", type: "raster", source: "sat", layout: { visibility: "none" },
        paint: { "raster-opacity": 0.55, "raster-saturation": -0.4, "raster-brightness-min": 0.15, "raster-brightness-max": 0.7 },
      }, firstLabel);
      map.addLayer({
        id: "aerial", type: "raster", source: "sat", layout: { visibility: "none" },
        paint: { "raster-opacity": 1, "raster-saturation": 0, "raster-brightness-min": 0, "raster-brightness-max": 1 },
      }, firstLabel);
      map.addSource("wash", { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]] } } });
      map.addLayer({ id: "wash", type: "fill", source: "wash", layout: { visibility: "none" }, paint: { "fill-color": "#0a0e14", "fill-opacity": 0.35 } }, firstLabel);

      map.addSource("inc-bldg", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: "inc-bldg-fill", type: "fill", source: "inc-bldg", paint: { "fill-color": cssVar("--p1"), "fill-opacity": 0.12 } }, firstLabel);
      map.addLayer({ id: "inc-bldg-line", type: "line", source: "inc-bldg", paint: { "line-color": cssVar("--p1"), "line-width": 1.5, "line-opacity": 0.7 } }, firstLabel);

      map.addSource("trails", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: "trails", type: "line", source: "trails", layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": cssVar("--onscene"), "line-width": 2, "line-opacity": 0.55, "line-dasharray": [1, 2] } });
      map.addSource("routes", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      const color = ["match", ["get", "kind"],
        "assigned", cssVar("--sent"),
        "history", cssVar("--sent"),
        "dest", cssVar("--busy"),
        "patrol", "#6b7382",
        cssVar("--available"),
      ] as unknown as string;
      map.addLayer({ id: "routes-casing", type: "line", source: "routes", filter: ["in", ["get", "kind"], ["literal", ["proposed", "assigned", "history"]]], layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#000", "line-width": 4, "line-opacity": 0.35 } });
      map.addLayer({ id: "routes-car", type: "line", source: "routes", filter: ["all", ["!", ["get", "foot"]], ["in", ["get", "kind"], ["literal", ["proposed", "assigned"]]]], layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": color, "line-width": 2.5, "line-opacity": 0.9 } });
      map.addLayer({ id: "routes-foot", type: "line", source: "routes", filter: ["all", ["get", "foot"], ["in", ["get", "kind"], ["literal", ["proposed", "assigned"]]]], layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": color, "line-width": 2.5, "line-opacity": 0.9, "line-dasharray": [0.6, 1.6] } });
      map.addLayer({ id: "routes-history", type: "line", source: "routes", filter: ["==", ["get", "kind"], "history"], layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": color, "line-width": 2.5, "line-opacity": 0.7, "line-dasharray": [2, 1.2] } });
      map.addLayer({ id: "routes-dest", type: "line", source: "routes", filter: ["==", ["get", "kind"], "dest"], layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": color, "line-width": 2, "line-opacity": 0.85, "line-dasharray": [0.4, 1.4] } });
      map.addLayer({ id: "routes-patrol", type: "line", source: "routes", filter: ["==", ["get", "kind"], "patrol"], layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#7a8494", "line-width": 1.5, "line-opacity": 0.35, "line-dasharray": [1.2, 1.6] } });
      applyBase(map, baseRef.current);
      setReady((r) => r + 1);
    });
    map.on("zoom", () => sizeHalos(map));
    // Panels sliding in/out change the map's size — resize only; never re-zoom into a call.
    let resizeT = 0;
    const ro = new ResizeObserver(() => {
      map.resize();
      clearTimeout(resizeT);
      resizeT = window.setTimeout(() => {
        if (!didCampusFit.current) fitCampus(map, padRef.current);
      }, 120);
    });
    ro.observe(box.current!);

    return () => {
      ro.disconnect();
      clearTimeout(resizeT);
      markerMap.forEach((m) => m.remove());
      markerMap.clear();
      callMarkers.current.forEach((m) => m.remove());
      callMarkers.current.clear();
      mentionMap.forEach((m) => m.remove());
      mentionMap.clear();
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- create once; theme changes swap the style below
  }, []);

  // Theme prop kept for API compat — HQ map stays on the dark basemap.
  void theme;

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

  // ---- officers (HQ standbys collapse to one count badge) ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const seen = new Set<string>();
    const hqStandby = officers.filter(isHqStandby);
    const field = officers.filter((o) => !isHqStandby(o));

    // Single HQ cluster: show how many free units are at desk.
    if (hqStandby.length > 0) {
      const id = "hq-cluster";
      seen.add(id);
      let m = markers.current.get(id);
      if (!m) {
        const el = document.createElement("div");
        el.className = "dc-pin";
        m = new maplibregl.Marker({ element: el, subpixelPositioning: true }).setLngLat(ll(PSAFE_HQ)).addTo(map);
        markers.current.set(id, m);
      }
      glide(m, ll(HQ_CLUSTER));
      const el = m.getElement();
      const color = cssVar("--available");
      const names = hqStandby.map((o) => o.callsign).join(", ");
      el.style.zIndex = "5";
      el.style.opacity = "1";
      el.style.cursor = "pointer";
      el.title = `HQ · ${hqStandby.length} available · ${names}`;
      el.onclick = (ev) => {
        ev.stopPropagation();
        latest.current.onSelectOfficer?.(hqStandby[0].id);
      };
      el.innerHTML = `<div class="dc-hq-cluster" style="border-color:${color}">
          <b>${hqStandby.length}</b>
          <span>free at HQ</span>
        </div>`;
    }

    field.forEach((o, n) => {
      seen.add(o.id);
      // Breadcrumb only while committed to a call — available units stay put with no trail.
      if (o.status === "responding" || o.status === "on_scene") {
        const tr = trails.current.get(o.id) ?? [];
        const last = tr[tr.length - 1];
        if (!last || Math.abs(last[0] - o.location[0]) + Math.abs(last[1] - o.location[1]) > 0.00003) trails.current.set(o.id, [...tr, o.location].slice(-400));
      } else trails.current.delete(o.id);
      let m = markers.current.get(o.id);
      if (!m) {
        const el = document.createElement("div");
        el.className = "dc-pin";
        m = new maplibregl.Marker({ element: el, subpixelPositioning: true }).setLngLat(ll(o.location)).addTo(map);
        markers.current.set(o.id, m);
      }
      const color = cssVar(STATUS_VAR[o.status]);
      const rec = teamIds.includes(o.id) && o.status !== "on_scene";
      const selected = selectedOfficerId === o.id;
      const at: LatLng = o.status === "on_scene" ? [o.location[0], o.location[1] + n * 0.00011] : o.location;
      glide(m, ll(at));
      const el = m.getElement();
      el.style.zIndex = selected ? "7" : rec ? "6" : "4";
      el.classList.toggle("lost", lostIds.includes(o.id));
      el.classList.toggle("selected", selected);
      el.style.opacity = selectedOfficerId && !selected ? "0.45" : "1";
      el.style.cursor = "pointer";
      el.title = `${o.callsign} · ${o.name} · ${o.status}`;
      el.onclick = (ev) => {
        ev.stopPropagation();
        latest.current.onSelectOfficer?.(o.id);
      };
      const acc = o.mode === "foot" ? 6 : 4;
      const label = esc(o.callsign);
      el.innerHTML = `<span class="dc-halo" data-acc="${acc}" style="background:${color}18;border:1px solid ${color}55"></span>
        <div class="dc-officer${rec ? " rec" : ""}${selected ? " sel" : ""}">
          <div class="fig" style="border-color:${color}">${figure(color, o.avatar ?? DEFAULT_AVATAR)}<i class="mode" title="${o.mode === "foot" ? "On foot" : "Vehicle"}">${ICON[o.mode]}</i></div>
          <span class="tag" style="border-color:${color}">${label}</span>
        </div>`;
    });
    markers.current.forEach((m, id) => { if (!seen.has(id)) { m.remove(); markers.current.delete(id); } });
    sizeHalos(map);
    (map.getSource("trails") as maplibregl.GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: [...trails.current.values()].filter((tr) => tr.length > 1).map((tr) => ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: tr.map(ll) } })),
    });
  }, [officers, teamIds, theme, ready, lostIds, selectedOfficerId]);

  // ---- all call markers (status dots) ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const assigned = new Set(assignedIncidentIds);
    const seen = new Set<string>();
    for (const inc of incidents) {
      seen.add(inc.id);
      const tone = incidentTone(inc, assigned.has(inc.id));
      let m = callMarkers.current.get(inc.id);
      if (!m) {
        const el = document.createElement("div");
        el.className = "dc-pin";
        m = new maplibregl.Marker({ element: el }).setLngLat(ll(inc.location)).addTo(map);
        callMarkers.current.set(inc.id, m);
      }
      const el = m.getElement();
      const selected = selectedIncidentId === inc.id;
      const label = inc.placeName || inc.title.split(":")[0];
      el.style.zIndex = selected ? "8" : tone === "open" ? "5" : tone === "done" ? "2" : "3";
      el.style.cursor = "pointer";
      el.classList.toggle("selected", selected);
      el.onclick = (ev) => {
        ev.stopPropagation();
        latest.current.onSelectIncident?.(inc.id);
      };
      // Square call pins; nudge away from HQ; label only when selected to avoid Whitman/HQ pile-ups.
      el.innerHTML = `<div class="dc-call dc-call-${tone}${selected ? " sel" : ""}" title="${esc(inc.number)} · ${esc(label)}"></div>${selected ? `<b class="dc-call-name">${esc(label)}</b>` : ""}`;
      m.setLngLat(ll(nudgeCall(inc.location)));
      el.style.opacity = selectedIncidentId && !selected && tone !== "done" ? "0.35" : tone === "done" ? "0.3" : "1";
    }
    callMarkers.current.forEach((m, id) => {
      if (!seen.has(id)) { m.remove(); callMarkers.current.delete(id); }
    });
  }, [incidents, selectedIncidentId, assignedIncidentIds, ready]);

  // ---- other places the caller named (skip ones that duplicate the incident pin) ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const incLoc = incident?.location;
    const want = new Map(
      (incident?.mentionedPlaces ?? []).filter((p) => {
        if (!incLoc) return true;
        return Math.abs(p.location[0] - incLoc[0]) + Math.abs(p.location[1] - incLoc[1]) > 0.0008;
      }).map((p) => [p.id, p]),
    );
    mentionMarkers.current.forEach((m, id) => { if (!want.has(id)) { m.remove(); mentionMarkers.current.delete(id); } });
    want.forEach((p, id) => {
      if (mentionMarkers.current.has(id)) return;
      const el = document.createElement("div");
      el.className = "dc-pin";
      el.style.zIndex = "3";
      el.innerHTML = `<div class="dc-mention"><span></span><b>${esc(p.name)}</b></div>`;
      el.title = `Mentioned by the caller: ${p.name}`;
      mentionMarkers.current.set(id, new maplibregl.Marker({ element: el }).setLngLat(ll(p.location)).addTo(map));
    });
  }, [incident, ready]);

  // ---- selected call building outline ----
  useEffect(() => {
    const map = mapRef.current;
    const m = incidentMarker.current;
    if (!map || !m) return;
    m.getElement().style.display = "none";
    if (!incident) {
      (map.getSource("inc-bldg") as maplibregl.GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: [] });
      return;
    }
    const outline = () => highlightBuilding(map, incident.location);
    if (map.loaded()) outline();
    map.once("idle", outline);
  }, [incident, priority, ready]);

  // Campus overview once tiles settle. Selecting a call/unit only highlights — no dive zoom.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const run = () => {
      fitCampus(map, padRef.current);
      didCampusFit.current = true;
    };
    if (map.loaded()) {
      const t = window.setTimeout(run, 80);
      return () => clearTimeout(t);
    }
    map.once("idle", run);
  }, [fitKey, ready, padLeft, padRight, padTop, padBottom]);

  return (
    <div className={`dc-map dc-map-${base}`} ref={box} data-base={base}>
      <div className="dc-map-gl" />
      <div className="dc-map-tools" role="toolbar" aria-label="Map controls">
        <div className="dc-map-bases" role="group" aria-label="Map style">
          {([
            ["street", "Dark streets", MAP_ICON.street],
            ["sat", "Satellite", MAP_ICON.sat],
            ["aerial", "Aerial", MAP_ICON.aerial],
          ] as const).map(([k, label, icon]) => (
            <button key={k} type="button" className="dc-map-base" aria-label={label} title={label} aria-pressed={base === k} onClick={() => setBase(k)}
              dangerouslySetInnerHTML={{ __html: icon }}
            />
          ))}
        </div>
        <div className="dc-map-zoom" role="group" aria-label="Zoom">
          <button type="button" aria-label="Zoom in" onClick={() => mapRef.current?.zoomIn()}>+</button>
          <button type="button" aria-label="Zoom out" onClick={() => mapRef.current?.zoomOut()}>−</button>
        </div>
        <div className="dc-map-view" role="group" aria-label="View">
          <button type="button" aria-label="Tilt to 3D" aria-pressed={tilted}
            onClick={() => { const t = !tilted; setTilted(t); mapRef.current?.easeTo({ pitch: t ? 45 : 0, bearing: t ? -15 : 0 }); }}>3D</button>
          <button type="button" aria-label="Campus overview" onClick={() => { didCampusFit.current = true; fitCampus(mapRef.current, padRef.current); }}>◎</button>
        </div>
      </div>
    </div>
  );
}

const MAP_ICON = {
  street: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 7l9-4 9 4v11l-9 4-9-4V7z"/><path d="M12 3v18M3 7l9 4 9-4"/></svg>`,
  sat: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.8 3.8 5.8 3.8 9S14.5 18.2 12 21c-2.5-2.8-3.8-5.8-3.8-9S9.5 5.8 12 3z"/></svg>`,
  aerial: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 17l6-7 4 4 3-3 5 6H3z"/><circle cx="8.5" cy="7.5" r="1.5"/></svg>`,
};

// ---- helpers ----
/** Always show the whole campus top-down — officers + calls stay in frame together. */
function fitCampus(
  map: maplibregl.Map | null,
  pad: { left: number; right: number; top: number; bottom: number } = { left: 328, right: 280, top: 56, bottom: 72 },
) {
  if (!map) return;
  map.resize();
  const b = new maplibregl.LngLatBounds(CAMPUS_BOUNDS[0], CAMPUS_BOUNDS[1]);
  const w = map.getContainer().clientWidth;
  const narrow = w < 720;
  map.fitBounds(b, {
    padding: {
      top: narrow ? Math.min(pad.top, 64) : pad.top,
      left: narrow ? Math.min(pad.left, 24) : pad.left,
      right: narrow ? Math.min(pad.right, 24) : pad.right,
      bottom: narrow ? Math.min(pad.bottom, 200) : pad.bottom,
    },
    maxZoom: 14.85,
    pitch: 0,
    bearing: 0,
    duration: 400,
  });
}

function applyBase(map: maplibregl.Map, base: Base) {
  if (map.getLayer("sat")) map.setLayoutProperty("sat", "visibility", base === "sat" ? "visible" : "none");
  if (map.getLayer("aerial")) map.setLayoutProperty("aerial", "visibility", base === "aerial" ? "visible" : "none");
  // Only the washed Satellite mode gets the dark overlay — Aerial is true imagery.
  if (map.getLayer("wash")) map.setLayoutProperty("wash", "visibility", base === "sat" ? "visible" : "none");
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
