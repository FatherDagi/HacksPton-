"use client";
// Compact Clery draft helper (also used if something links here). Filing goes through SIGN_CLERY → weekly log.
import { useState } from "react";
import { draftClery } from "@/lib/clery";
import { act, stamp } from "@/lib/store";
import type { Incident } from "@/lib/types";

export function CleryPanel({ incident }: { incident: Incident }) {
  const draft = draftClery(incident);
  const signed = incident.clerySignOff;
  const [note, setNote] = useState("");

  const sign = () => {
    const loc = [incident.fields.building.value, incident.fields.room.value].filter(Boolean).join(" · ") || "Unknown";
    act({
      type: "SIGN_CLERY",
      at: stamp(),
      incidentId: incident.id,
      reportable: draft.reportable,
      category: draft.category,
      geographyLabel: draft.geographyLabel,
      nibrs: draft.nibrs,
      dailyLog: draft.dailyLog,
      timelyWarning: draft.timelyWarning,
      note: note.trim() || null,
      location: loc,
      title: incident.title,
      incidentNumber: incident.number,
      eventAt: incident.callStartedAt ?? incident.createdAt,
    });
  };

  return (
    <section aria-label="Clery assist">
      {signed ? (
        <p className="dc-clery-live"><b>Filed</b> · {signed.category}</p>
      ) : (
        <>
          <p className="dc-clery-live">{draft.category} · {draft.geographyLabel}</p>
          <input className="dc-input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional note" />
          <button type="button" className="dc-btn sm primary" style={{ marginTop: 8 }} onClick={sign}>File to week log</button>
        </>
      )}
    </section>
  );
}
