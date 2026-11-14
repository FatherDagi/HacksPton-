// Shared data models for Emergency Dispatch Copilot.
// Everything here describes SIMULATED data only.

export type LatLng = [number, number];

export type IncidentCategory = "medical" | "fire" | "police" | "other";

/** How much we trust a field's value. */
export type FieldStatus = "confirmed" | "unverified" | "unknown";

/** Who last wrote a field. Dispatcher-confirmed values are never overwritten by AI/demo updates. */
export type FieldSource = "ai" | "demo" | "dispatcher";

export type FieldKey =
  | "caller_name"
  | "callback"
  | "caller_location"
  | "caller_safe"
  | "building"
  | "address"
  | "floor"
  | "room"
  | "location_details"
  | "category"
  | "description"
  | "people_count"
  | "condition"
  | "conscious"
  | "breathing"
  | "suspect"
  | "hazards"
  | "weapons"
  | "access"
  | "notes";

export interface FieldValue {
  key: FieldKey;
  value: string | null;
  status: FieldStatus;
  source: FieldSource | null;
  /** Transcript segment that supports this value. */
  evidenceSegmentId: string | null;
  updatedAt: number | null;
}

export type Speaker = "caller" | "dispatcher";

export interface TranscriptSegment {
  id: string;
  /** Seconds from call start. */
  t: number;
  speaker: Speaker;
  text: string;
  /** Substring of `text` to highlight as important. */
  highlight?: string;
}

export interface FieldUpdate {
  key: FieldKey;
  value: string;
  status: Exclude<FieldStatus, "unknown">;
}

/** A segment in a prerecorded scenario plus the precomputed extraction it produces. */
export interface ScenarioSegment extends TranscriptSegment {
  updates?: FieldUpdate[];
}

export interface Scenario {
  id: string;
  title: string;
  category: IncidentCategory;
  buildingId: string;
  segments: ScenarioSegment[];
}

export type QuestionState = "open" | "answered" | "dismissed";

export interface QuestionItem {
  id: string;
  fieldKey: FieldKey;
  text: string;
  state: QuestionState;
}

export type Priority = 1 | 2 | 3 | 4;
export type Urgency = "immediate" | "high" | "moderate" | "low";

export interface PriorityAssessment {
  proposed: Priority;
  urgency: Urgency;
  /** Human-readable rule hits that produced the proposal. */
  reasons: string[];
}

export interface PriorityDecision {
  priority: Priority;
  /** Present when the dispatcher chose something other than the proposal. */
  overrideReason: string | null;
  decidedAt: number;
}

export type IncidentStatus = "intake" | "dispatched" | "on_scene" | "closed";

export interface Incident {
  id: string;
  number: string;
  scenarioId: string | null;
  category: IncidentCategory;
  title: string;
  buildingId: string;
  location: LatLng;
  status: IncidentStatus;
  createdAt: number;
  closedAt: number | null;
  callStartedAt: number | null;
  callEndedAt: number | null;
  /** Number of scenario segments revealed so far. */
  revealed: number;
  transcript: TranscriptSegment[];
  fields: Record<FieldKey, FieldValue>;
  questions: QuestionItem[];
  priorityDecision: PriorityDecision | null;
  /** Officers the dispatcher declined for this incident. */
  declinedOfficerIds: string[];
}

export type ResponderType = "police" | "ems" | "fire";
export type OfficerStatus = "available" | "busy" | "responding" | "on_scene";
export type TravelMode = "car" | "foot";

export interface Officer {
  id: string;
  callsign: string;
  name: string;
  badge: string;
  type: ResponderType;
  mode: TravelMode;
  status: OfficerStatus;
  location: LatLng;
  locationLabel: string;
  lastLocationAt: number;
  currentIncidentId: string | null;
  /** Free text when busy elsewhere. */
  busyWith: string | null;
}

export type AssignmentStatus = "active" | "cleared";

export interface DispatchAssignment {
  id: string;
  incidentId: string;
  officerId: string;
  status: AssignmentStatus;
  etaSeconds: number;
  approvedAt: number;
  acknowledgedAt: number | null;
  clearedAt: number | null;
  /** Route the dispatcher approved (sent to the unit's terminal). */
  route?: LatLng[];
}

export type EventActor = "system" | "demo" | "ai" | "dispatcher" | "officer";

export interface IncidentEvent {
  id: string;
  incidentId: string;
  at: number;
  actor: EventActor;
  type: string;
  message: string;
}

export interface Building {
  id: string;
  name: string;
  address: string;
  location: LatLng;
}

export interface Closure {
  id: string;
  label: string;
  /** [south-west, north-east] */
  bounds: [LatLng, LatLng];
  /** Waypoint a route uses to go around the closure. */
  detour: LatLng;
}

export interface Recommendation {
  officer: Officer;
  etaSeconds: number;
  distanceMeters: number;
  route: LatLng[];
  avoidsClosure: string | null;
  reason: string;
}

export interface AppState {
  rev: number;
  officers: Officer[];
  incidents: Incident[];
  assignments: DispatchAssignment[];
  events: IncidentEvent[];
  activeIncidentId: string | null;
}
