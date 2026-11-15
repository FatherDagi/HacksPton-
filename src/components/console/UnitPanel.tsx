"use client";
// Floating detail for a unit clicked on the map or units table. Send / message ride the sync hub.
import Link from "next/link";
import { useState } from "react";
import { formatEta, formatMiles } from "@/lib/recommend";
import type { RoutePlan } from "@/lib/console/routing";
import { act, newId, stamp } from "@/lib/store";
import type { Incident, Officer, UnitMessage } from "@/lib/types";
import { fmtClock } from "../ui";

const STATUS_LABEL = { available: "Available", busy: "Busy", responding: "Responding", on_scene: "On scene" } as const;

export function UnitPanel({
  officer, incident, plan, linked, onSceneMs, messages, onClose, onSend,
}: {
  officer: Officer;
  incident: Incident | null;
  plan: RoutePlan | null;
  linked: boolean;
  onSceneMs: number | null;
  messages: UnitMessage[];
  onClose: () => void;
  onSend: () => void;
}) {
  const [text, setText] = useState("");
  const thread = messages.filter((m) => m.officerId === officer.id).slice(-8);

  const sendNote = () => {
    const t = text.trim();
    if (!t) return;
    act({
      type: "SEND_MESSAGE",
      at: stamp(),
      messageId: newId("msg"),
      from: "dispatcher",
      officerId: officer.id,
      incidentId: incident?.id ?? officer.currentIncidentId,
      text: t,
    });
    setText("");
  };

  return (
    <div className="dc-unitpanel" role="dialog" aria-label={`${officer.callsign} details`}>
      <header>
        <div>
          <b>{officer.callsign}</b> <span>{officer.name}</span>
          <small>Badge {officer.badge} · {officer.type === "police" ? "Police" : officer.type.toUpperCase()} · {officer.mode === "foot" ? "on foot" : "vehicle"}</small>
        </div>
        <button type="button" className="dc-btn sm ghost" onClick={onClose} aria-label="Close">✕</button>
      </header>

      <div className="dc-unitpanel-body">
        <p className="dc-unitpanel-status" data-s={officer.status}>
          {STATUS_LABEL[officer.status]}
          {linked ? " · terminal live" : " · terminal offline"}
        </p>
        <p>{officer.busyWith ?? officer.locationLabel}</p>
        {onSceneMs != null && officer.status !== "available" && (
          <p className="dc-muted">On task {fmtClock(onSceneMs)}</p>
        )}
        {incident && plan && officer.status === "available" && (
          <p>ETA to this call: <b>{formatEta(plan.etaSeconds)}</b> · {formatMiles(plan.distanceMeters)} {plan.real ? "by road" : "est."}</p>
        )}

        <div className="dc-unitpanel-acts">
          {incident && incident.status !== "closed" && officer.status === "available" && (
            <button type="button" className="dc-btn sm primary" onClick={onSend}>Send to this call</button>
          )}
          <Link href={`/officer?unit=${officer.id}`} className="dc-btn sm">Open terminal</Link>
        </div>

        <h4>Message unit</h4>
        <ul className="dc-unitpanel-msgs">
          {thread.length === 0 && <li className="dc-muted">No messages yet.</li>}
          {thread.map((m) => (
            <li key={m.id} data-from={m.from}>
              <b>{m.from === "dispatcher" ? "HQ" : officer.callsign}</b> {m.text}
            </li>
          ))}
        </ul>
        <form className="dc-unitpanel-form" onSubmit={(e) => { e.preventDefault(); sendNote(); }}>
          <input className="dc-input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Short note to the unit…" />
          <button type="submit" className="dc-btn sm primary" disabled={!text.trim()}>Send</button>
        </form>
      </div>
    </div>
  );
}
