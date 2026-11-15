// Field catalogue, sections and curated question checklists.
// Checklists are demo aids, NOT approved call-taking protocols.
import type { FieldKey, FieldValue, IncidentCategory, QuestionItem } from "./types";

export const FIELD_LABELS: Record<FieldKey, string> = {
  caller_name: "Caller name",
  callback: "Callback number",
  caller_location: "Caller location",
  caller_safe: "Caller safe?",
  building: "Building",
  address: "Street address",
  floor: "Floor",
  room: "Room",
  location_details: "Location details",
  category: "Type",
  description: "What happened",
  people_count: "People involved",
  condition: "Patient / victim condition",
  conscious: "Conscious?",
  breathing: "Breathing?",
  suspect: "Suspect",
  hazards: "Hazards",
  weapons: "Weapons",
  access: "Access / entrance",
  notes: "Notes",
  incident_time: "When it happened",
  patient_info: "Patient age / sex",
  direction: "Direction of travel",
  vehicle: "Vehicle",
};

export const SECTIONS: { title: string; keys: FieldKey[] }[] = [
  { title: "Caller", keys: ["caller_name", "callback", "caller_location", "caller_safe"] },
  { title: "Location", keys: ["building", "address", "floor", "room", "location_details"] },
  { title: "Incident", keys: ["category", "description", "incident_time"] },
  { title: "People", keys: ["people_count", "condition", "conscious", "breathing", "patient_info", "suspect"] },
  { title: "Scene", keys: ["hazards", "weapons", "direction", "vehicle", "access", "notes"] },
];

export const ALL_FIELD_KEYS = Object.keys(FIELD_LABELS) as FieldKey[];

export function emptyFields(): Record<FieldKey, FieldValue> {
  const out = {} as Record<FieldKey, FieldValue>;
  for (const key of ALL_FIELD_KEYS) {
    out[key] = { key, value: null, status: "unknown", source: null, evidenceSegmentId: null, updatedAt: null };
  }
  return out;
}

type Checklist = { fieldKey: FieldKey; text: string }[];

const MEDICAL: Checklist = [
  { fieldKey: "breathing", text: "Is the person breathing normally?" },
  { fieldKey: "conscious", text: "Is the person awake and able to respond?" },
  { fieldKey: "room", text: "What is the exact room number?" },
  { fieldKey: "floor", text: "Which floor are you on?" },
  { fieldKey: "callback", text: "What number can we call you back on?" },
  { fieldKey: "condition", text: "What happened right before they collapsed?" },
  { fieldKey: "access", text: "Which entrance should responders use?" },
  { fieldKey: "caller_name", text: "What is your name?" },
];

const FIRE: Checklist = [
  { fieldKey: "people_count", text: "Is anyone still inside or trapped?" },
  { fieldKey: "caller_safe", text: "Are you outside the building right now?" },
  { fieldKey: "hazards", text: "Do you see flames, or only smoke? Any chemicals nearby?" },
  { fieldKey: "floor", text: "Which floor is the smoke on?" },
  { fieldKey: "room", text: "Which room or lab?" },
  { fieldKey: "access", text: "Which entrance is clear for responders?" },
  { fieldKey: "callback", text: "What number can we call you back on?" },
  { fieldKey: "caller_name", text: "What is your name?" },
];

const POLICE: Checklist = [
  { fieldKey: "weapons", text: "Did you see a weapon? What kind?" },
  { fieldKey: "caller_safe", text: "Are you somewhere safe right now?" },
  { fieldKey: "suspect", text: "What does the person look like, and which way did they go?" },
  { fieldKey: "condition", text: "Is anyone hurt? How badly?" },
  { fieldKey: "floor", text: "Which floor are you on?" },
  { fieldKey: "access", text: "Which entrance is closest to you?" },
  { fieldKey: "callback", text: "What number can we call you back on?" },
  { fieldKey: "caller_name", text: "What is your name?" },
];

export const CHECKLISTS: Record<IncidentCategory, Checklist> = {
  medical: MEDICAL,
  fire: FIRE,
  police: POLICE,
  other: POLICE,
};

export function initialQuestions(category: IncidentCategory): QuestionItem[] {
  return CHECKLISTS[category].map((q, i) => ({ id: `${category}-q${i}`, fieldKey: q.fieldKey, text: q.text, state: "open" }));
}
