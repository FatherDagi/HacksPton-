// Princeton campus simulation data. Building coordinates are approximate.
// Officers, closures and incidents are fictional.
import type { Building, Closure, LatLng, Officer } from "./types";

export const CAMPUS_CENTER: LatLng = [40.3465, -74.6555];

export const BUILDINGS: Building[] = [
  { id: "frist", name: "Frist Campus Center", address: "Frist Campus Center, Princeton, NJ 08544", location: [40.3468, -74.6551] },
  { id: "nassau", name: "Nassau Hall", address: "Nassau Hall, Princeton, NJ 08544", location: [40.3487, -74.6593] },
  { id: "firestone", name: "Firestone Library", address: "One Washington Rd, Princeton, NJ 08544", location: [40.3496, -74.6576] },
  { id: "whitman", name: "Whitman College", address: "Whitman College, Princeton, NJ 08544", location: [40.3443, -74.6583] },
  { id: "equad", name: "Engineering Quadrangle", address: "41 Olden St, Princeton, NJ 08540", location: [40.3503, -74.6515] },
  { id: "stadium", name: "Princeton Stadium", address: "Princeton Stadium, Princeton, NJ 08544", location: [40.3457, -74.6494] },
  { id: "jadwin", name: "Jadwin Gym", address: "Jadwin Gymnasium, Princeton, NJ 08544", location: [40.3437, -74.6486] },
  { id: "dillon", name: "Dillon Gym", address: "Dillon Gymnasium, Princeton, NJ 08544", location: [40.3464, -74.6603] },
  { id: "dps", name: "Public Safety (simulated HQ)", address: "Elm Dr, Princeton, NJ 08544", location: [40.3434, -74.6563] },
  { id: "lewis", name: "Lewis Library", address: "Washington Rd, Princeton, NJ 08544", location: [40.3463, -74.6527] },
];

export const buildingById = (id: string) => BUILDINGS.find((b) => b.id === id);

export const CLOSURES: Closure[] = [
  {
    id: "elm-resurfacing",
    label: "Elm Dr resurfacing (simulated)",
    bounds: [[40.3448, -74.6572], [40.3458, -74.6559]],
    detour: [40.3452, -74.6545],
  },
  {
    id: "wash-lane",
    label: "Washington Rd lane closure (simulated)",
    bounds: [[40.3478, -74.6536], [40.3488, -74.6526]],
    detour: [40.3483, -74.6545],
  },
];

const T0 = 0; // lastLocationAt is filled in at seed time

export const SEED_OFFICERS: Officer[] = [
  {
    id: "U1", callsign: "Unit 1", name: "Ofc. Dana Reyes", badge: "4127", type: "police", mode: "car",
    status: "available", location: [40.3492, -74.6600], locationLabel: "Nassau St at Nassau Hall",
    lastLocationAt: T0, currentIncidentId: null, busyWith: null,
  },
  {
    id: "U2", callsign: "Unit 2", name: "Ofc. Marcus Hale", badge: "3381", type: "police", mode: "car",
    status: "busy", location: [40.3459, -74.6488], locationLabel: "Princeton Stadium",
    lastLocationAt: T0, currentIncidentId: null, busyWith: "Noise complaint at stadium",
  },
  {
    id: "U3", callsign: "Unit 3", name: "Ofc. Priya Nair", badge: "2904", type: "police", mode: "foot",
    status: "available", location: [40.3476, -74.6531], locationLabel: "Washington Rd, on foot",
    lastLocationAt: T0, currentIncidentId: null, busyWith: null,
  },
  {
    id: "M1", callsign: "Medic 1", name: "EMT Sam Ortiz", badge: "6620", type: "ems", mode: "car",
    status: "available", location: [40.3436, -74.6566], locationLabel: "Public Safety HQ, Elm Dr",
    lastLocationAt: T0, currentIncidentId: null, busyWith: null,
  },
  {
    id: "F1", callsign: "Fire 1", name: "Fire Marshal Jo Whitaker", badge: "7012", type: "fire", mode: "car",
    status: "available", location: [40.3499, -74.6540], locationLabel: "William St",
    lastLocationAt: T0, currentIncidentId: null, busyWith: null,
  },
];
