import assert from "node:assert/strict";
import test from "node:test";
import { simulatedTripActive, type TripAssignment, type TripOfficer } from "./tripGuard.ts";

const officer = (status: string, currentIncidentId: string | null): TripOfficer => ({ status, currentIncidentId });
const active = (incidentId: string): TripAssignment => ({ officerId: "U4", incidentId, status: "active" });

test("keeps a drive only while the unit is still responding to that case", () => {
  assert.equal(simulatedTripActive(officer("responding", "inc-a"), "inc-a", [active("inc-a")], "U4"), true);
});

test("drops the drive after the case is closed and the unit is free", () => {
  assert.equal(simulatedTripActive(officer("available", null), "inc-a", [], "U4"), false);
});

test("drops the drive when the unit was promoted onto a different case", () => {
  assert.equal(
    simulatedTripActive(officer("responding", "inc-b"), "inc-a", [active("inc-b")], "U4"),
    false,
  );
});

test("drops the drive once the assignment is no longer active", () => {
  assert.equal(
    simulatedTripActive(
      officer("responding", "inc-a"),
      "inc-a",
      [{ officerId: "U4", incidentId: "inc-a", status: "cleared" }],
      "U4",
    ),
    false,
  );
});
