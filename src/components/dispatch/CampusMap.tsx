"use client";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { useEffect, useMemo } from "react";
import { CircleMarker, MapContainer, Marker, Polyline, Popup, Rectangle, TileLayer, Tooltip, useMap } from "react-leaflet";
import { BUILDINGS, CAMPUS_CENTER, CLOSURES } from "@/lib/campus";
import type { Incident, LatLng, Officer } from "@/lib/types";
import { OFFICER_STATUS_COLOR, OFFICER_STATUS_LABEL } from "../ui";
import { formatEta } from "@/lib/recommend";

function figureHtml(o: Officer, highlighted: boolean) {
  const c = OFFICER_STATUS_COLOR[o.status];
  const ring = highlighted ? `outline:2px solid ${c};outline-offset:1px;background:rgba(11,18,32,.75);` : "";
  return `
  <div style="display:flex;flex-direction:column;align-items:center;transform:translate(-50%,-100%);width:max-content;position:absolute;left:0;top:0">
    <div style="line-height:0;padding:2px;border-radius:3px;${ring}">
      <svg width="24" height="31" viewBox="0 0 30 38" aria-hidden="true">
        <ellipse cx="15" cy="35" rx="10" ry="3" fill="#000" opacity="0.45"/>
        <rect x="6" y="15" width="18" height="18" rx="6" fill="${c}"/>
        <circle cx="15" cy="9" r="7" fill="#e9c9a8"/>
        <path d="M7 7 Q15 -1 23 7 L23 8 L7 8 Z" fill="#1d2a44"/>
        <rect x="7" y="7" width="16" height="2.5" fill="#111a2c"/>
        <path d="M15 19 l1.6 3 3.2.4-2.4 2.2.7 3.2-3.1-1.6-3.1 1.6.7-3.2-2.4-2.2 3.2-.4z" fill="#f3e3b0"/>
      </svg>
    </div>
    <span style="margin-top:1px;white-space:nowrap;font:600 10.5px/1.3 var(--font-mono-face),monospace;color:#e3e8f0;background:#0b1220;border:1px solid ${c};padding:0 4px;border-radius:2px">${o.callsign}</span>
  </div>`;
}

const incidentIcon = L.divIcon({
  className: "incident-marker",
  html: `<div style="position:absolute;left:0;top:0;transform:translate(-50%,-50%);width:30px;height:30px;border-radius:50%;border:2px solid #ef5b52;background:rgba(239,91,82,.22);display:flex;align-items:center;justify-content:center">
           <div style="width:10px;height:10px;border-radius:50%;background:#ef5b52;border:2px solid #fff"></div></div>`,
  iconSize: [0, 0],
});

function FlyTo({ target }: { target: LatLng | null }) {
  const map = useMap();
  useEffect(() => {
    if (target) map.flyTo(target, 17, { duration: 0.6 });
  }, [map, target]);
  return null;
}

export interface MapRoute {
  points: LatLng[];
  kind: "proposed" | "assigned";
}

export default function CampusMap({
  officers,
  incident,
  routes,
  highlightOfficerId,
}: {
  officers: Officer[];
  incident: Incident | null;
  routes: MapRoute[];
  highlightOfficerId: string | null;
}) {
  const icons = useMemo(
    () => new Map(officers.map((o) => [o.id, L.divIcon({ className: "unit-marker", html: figureHtml(o, o.id === highlightOfficerId), iconSize: [0, 0] })])),
    [officers, highlightOfficerId],
  );
  const target = incident ? incident.location : null;

  return (
    <MapContainer center={CAMPUS_CENTER} zoom={16} minZoom={15} maxZoom={19} className="dark-tiles h-full w-full" maxBounds={[[40.3375, -74.6700], [40.3555, -74.6400]]}>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <FlyTo target={target} />

      {CLOSURES.map((c) => (
        <Rectangle key={c.id} bounds={c.bounds} pathOptions={{ color: "#e8913f", weight: 1.5, dashArray: "5 4", fillColor: "#e8913f", fillOpacity: 0.18 }}>
          <Tooltip sticky>{c.label}</Tooltip>
        </Rectangle>
      ))}

      {BUILDINGS.map((b) => (
        <CircleMarker key={b.id} center={b.location} radius={3.5} pathOptions={{ color: "#a3aec0", weight: 1, fillColor: "#a3aec0", fillOpacity: 0.7 }}>
          <Tooltip direction="top" offset={[0, -4]}>{b.name}</Tooltip>
        </CircleMarker>
      ))}

      {routes.map((r, i) => (
        <Polyline
          key={i}
          positions={r.points}
          pathOptions={{ color: r.kind === "assigned" ? "#4a8cf0" : "#43b57f", weight: 4, dashArray: r.kind === "proposed" ? "8 7" : undefined, opacity: 0.95 }}
        />
      ))}

      {incident && (
        <Marker position={incident.location} icon={incidentIcon} zIndexOffset={500}>
          <Popup>
            <strong>Incident {incident.number}</strong>
            <br />
            {incident.title}
          </Popup>
        </Marker>
      )}

      {officers.map((o) => (
        <Marker key={o.id} position={o.location} icon={icons.get(o.id)!} zIndexOffset={o.id === highlightOfficerId ? 1000 : 600}>
          <Popup>
            <div style={{ minWidth: 190 }}>
              <strong>{o.callsign}</strong> · {o.name} <span style={{ color: "#a3aec0" }}>#{o.badge}</span>
              <br />
              <span style={{ color: OFFICER_STATUS_COLOR[o.status], fontWeight: 600 }}>{OFFICER_STATUS_LABEL[o.status]}</span>
              {o.busyWith ? ` — ${o.busyWith}` : ""}
              <br />
              <span style={{ color: "#a3aec0" }}>
                {o.type.toUpperCase()} · {o.mode === "foot" ? "on foot" : "vehicle"} · {o.locationLabel}
              </span>
            </div>
          </Popup>
        </Marker>
      ))}
    </MapContainer>
  );
}

export { formatEta };
