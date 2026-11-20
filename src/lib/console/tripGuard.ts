// A simulated HQ drive is local to the screen that dispatched the unit. It must stop as soon as that
// unit is no longer responding to that case — otherwise the timer keeps moving them and, at the end
// of the drive, marks them on scene for whatever job they hold now (or for none).

export interface TripOfficer {
  status: string;
  currentIncidentId: string | null;
}

export interface TripAssignment {
  officerId: string;
  incidentId: string;
  status: string;
}

export function simulatedTripActive(
  officer: TripOfficer | undefined,
  incidentId: string,
  assignments: TripAssignment[],
  officerId: string,
): boolean {
  if (!officer || officer.status !== "responding" || officer.currentIncidentId !== incidentId) return false;
  return assignments.some(
    (a) => a.officerId === officerId && a.incidentId === incidentId && a.status === "active",
  );
}
