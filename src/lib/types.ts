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
  | "notes"
  | "incident_time"
  | "patient_info"
  | "direction"
  | "vehicle";

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
  /** Set by the console's automatic grading (kept up to date until the dispatcher picks a level). */
  auto?: boolean;
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
  /** Human sign-off on the Clery / daily-log draft derived from the call sheet. */
  clerySignOff: ClerySignOff | null;
  /** Set when the call comes from the live station desk instead of a scripted scenario. */
  deskCallId?: string | null;
  /** Caller's language as detected by the station desk (transcript is translated to English). */
  callerLanguage?: string | null;
  /** True until a campus building has been matched from the call. */
  locationPending?: boolean;
  /** Place the incident pin was set to from what the caller said (places database). */
  placeName?: string | null;
  /** How specific that place is ("building", "street", ...); a street can later be refined. */
  placeKind?: string | null;
  /** Other places named in the call (e.g. where a suspect ran), pinned on every map. */
  mentionedPlaces?: MentionedPlace[];
}

export interface MentionedPlace {
  id: string;
  name: string;
  location: LatLng;
}

export interface ClerySignOff {
  reportable: boolean;
  category: string;
  geographyLabel: string;
  nibrs: string;
  dailyLog: boolean;
  timelyWarning: boolean;
  note: string | null;
  signedAt: number;
}

/** One row in the weekly Clery / daily-crime workspace. */
export interface CleryLogEntry {
  id: string;
  incidentId: string;
  incidentNumber: string;
  title: string;
  at: number;
  signedAt: number;
  reportable: boolean;
  category: string;
  geographyLabel: string;
  nibrs: string;
  dailyLog: boolean;
  timelyWarning: boolean;
  location: string;
  note: string | null;
}

export type ResponderType = "police" | "ems" | "fire";
export type OfficerStatus = "available" | "busy" | "responding" | "on_scene";
export type TravelMode = "car" | "foot";

/** Compact map avatar — distinct face so HQ can tell officers apart at a glance. */
export interface OfficerAvatar {
  skin: string;
  hair: string;
  hat: string;
}

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
  /** When a busy post/task is expected to wrap (ms epoch). Null if free / on a call. */
  busyUntil?: number | null;
  avatar: OfficerAvatar;
}

export type AssignmentStatus = "active" | "queued" | "cleared";

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
  /** What the officer has been sent so far (field key / "priority" -> value). Optional for older saved state. */
  sentSnapshot?: Record<string, string | null>;
}

/** One change between what the officer was last sent and the current incident record. */
export interface UpdateChange {
  key: string;
  label: string;
  from: string | null;
  to: string | null;
}

export type OfficerUpdateStatus = "sent" | "acknowledged";

/** A dispatcher-approved update pushed to an assigned officer. */
export interface OfficerUpdate {
  id: string;
  incidentId: string;
  assignmentId: string;
  officerId: string;
  changes: UpdateChange[];
  status: OfficerUpdateStatus;
  sentAt: number;
  acknowledgedAt: number | null;
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

/** Officer → HQ backup request. Lives until dispatch acknowledges or clears it. */
export type BackupStatus = "open" | "acknowledged" | "resolved";

export interface BackupRequest {
  id: string;
  officerId: string;
  incidentId: string;
  at: number;
  status: BackupStatus;
  note: string | null;
  acknowledgedAt: number | null;
  resolvedAt: number | null;
}

/** Short HQ ↔ officer note that rides the same realtime sync channel. */
export interface UnitMessage {
  id: string;
  at: number;
  from: "dispatcher" | "officer";
  officerId: string;
  incidentId: string | null;
  text: string;
}

export interface AppState {
  rev: number;
  officers: Officer[];
  incidents: Incident[];
  assignments: DispatchAssignment[];
  events: IncidentEvent[];
  backups: BackupRequest[];
  messages: UnitMessage[];
  cleryLog: CleryLogEntry[];
  activeIncidentId: string | null;
  /** Optional so state saved before this feature still loads. */
  officerUpdates?: OfficerUpdate[];
}
