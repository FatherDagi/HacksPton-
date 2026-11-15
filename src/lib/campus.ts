// Princeton campus seed data for the demo. Officers, buildings, patrol beats.
import type { Building, Closure, LatLng, Officer } from "./types";

export const CAMPUS_CENTER: LatLng = [40.3465, -74.6555];

export const PSAFE_HQ: LatLng = [40.34368, -74.65727];

export const BUILDINGS: Building[] = [
  { id: "frist", name: "Frist Campus Center", address: "Princeton University", location: [40.3469, -74.6550] },
  { id: "nassau", name: "Nassau Hall", address: "Princeton University", location: [40.3489, -74.6593] },
  { id: "firestone", name: "Firestone Library", address: "Princeton University", location: [40.3495, -74.6570] },
  { id: "whitman", name: "Whitman College", address: "Princeton University", location: [40.3445, -74.6580] },
  { id: "equad", name: "Engineering Quadrangle", address: "Princeton University", location: [40.3502, -74.6518] },
  { id: "stadium", name: "Princeton Stadium", address: "Princeton University", location: [40.3458, -74.6495] },
  { id: "jadwin", name: "Jadwin Gym", address: "Princeton University", location: [40.3439, -74.6488] },
  { id: "dillon", name: "Dillon Gym", address: "Princeton University", location: [40.3465, -74.6600] },
  { id: "dps", name: "Department of Public Safety", address: "200 Elm Dr", location: PSAFE_HQ },
  { id: "lewis", name: "Lewis Library", address: "Princeton University", location: [40.3464, -74.6528] },
  { id: "cottage", name: "Cottage Club", address: "Prospect Ave", location: [40.348246, -74.651714] },
  { id: "tiger-inn", name: "Tiger Inn", address: "Prospect Ave", location: [40.3480, -74.6525] },
];

export const buildingById = (id: string) => BUILDINGS.find((b) => b.id === id);

/** Demo keeps the map clear — no fake lane-closure overlays. */
export const CLOSURES: Closure[] = [];

const T0 = 0;

/** Road-ish campus waypoints used for busy-unit legs and offline route fallbacks. */
export const CAMPUS_ROADS: Record<string, LatLng> = {
  nassauW: [40.3494, -74.6610],
  nassauE: [40.3490, -74.6578],
  firestone: [40.3495, -74.6570],
  washingtonN: [40.3485, -74.6535],
  washingtonS: [40.3460, -74.6530],
  frist: [40.3469, -74.6550],
  elm: [40.3455, -74.6565],
  hq: PSAFE_HQ,
  whitman: [40.3445, -74.6580],
  dillon: [40.3465, -74.6600],
  stadium: [40.3458, -74.6495],
  jadwin: [40.3439, -74.6488],
  equad: [40.3502, -74.6518],
  lewis: [40.3464, -74.6528],
  prospect: [40.3472, -74.6568],
  cottage: [40.348246, -74.651714],
};

/**
 * Dense campus drive/walk polylines for offline routing when public routers are down.
 * Points follow the mapped street grid (Nassau, Washington, Elm, Prospect, Faculty, etc.).
 */
export const CAMPUS_WAYS: LatLng[][] = [
  // Nassau St (W→E)
  [[40.34955, -74.6622], [40.34945, -74.6610], [40.34935, -74.6595], [40.34925, -74.6582], [40.34915, -74.6570], [40.34905, -74.6555], [40.34895, -74.6538], [40.34885, -74.6522], [40.34875, -74.6508]],
  // Washington Rd (N→S)
  [[40.3492, -74.6536], [40.3485, -74.6535], [40.3476, -74.6533], [40.3468, -74.65315], [40.3460, -74.6530], [40.3450, -74.65285], [40.3440, -74.6527], [40.3430, -74.65255]],
  // Elm Dr (Whitman / HQ loop)
  [[40.3462, -74.6598], [40.3455, -74.6588], [40.3448, -74.6578], [40.3442, -74.6570], [40.3437, -74.6573], [40.3435, -74.6582], [40.3438, -74.6590], [40.3445, -74.6588], [40.3452, -74.6592], [40.3460, -74.6598]],
  // Prospect Ave (clubs)
  [[40.3484, -74.6548], [40.3483, -74.6535], [40.34825, -74.6522], [40.3482, -74.6512], [40.3481, -74.6502]],
  // Frist / center connector
  [[40.3489, -74.6575], [40.3482, -74.6565], [40.3474, -74.6556], [40.3469, -74.6550], [40.3463, -74.6542], [40.3458, -74.6535]],
  // Dillon / University Pl
  [[40.3492, -74.6605], [40.3482, -74.6603], [40.3472, -74.6601], [40.3465, -74.6600], [40.3456, -74.6596], [40.3448, -74.6590]],
  // Faculty Rd / stadium approach (W←E toward stadium)
  [[40.3460, -74.6530], [40.3459, -74.6515], [40.34585, -74.6502], [40.3458, -74.6495], [40.3452, -74.6490], [40.3443, -74.6488], [40.3439, -74.6488]],
  // EQuad / Ivy (N edge)
  [[40.3504, -74.6535], [40.3503, -74.6525], [40.3502, -74.6518], [40.3498, -74.6510], [40.3492, -74.6505]],
  // Lewis / Engineering connector
  [[40.3485, -74.6535], [40.3476, -74.6532], [40.3468, -74.6530], [40.3464, -74.6528], [40.3460, -74.6522]],
  // Firestone spur
  [[40.3493, -74.6580], [40.3495, -74.6570], [40.3492, -74.6562], [40.3486, -74.6555]],
];

/**
 * One-shot demo tasks for busy (amber) units. Start → end over ~5–7 min, then stay put.
 * Cars use road routing; foot units walk campus paths. Reload restarts from points[0].
 */
export const PATROL_BEATS: Record<string, { label: string; mode: "car" | "foot"; points: LatLng[]; durationMs: number }> = {
  U1: {
    label: "Nassau check",
    mode: "car",
    points: [CAMPUS_ROADS.nassauW, CAMPUS_ROADS.firestone],
    durationMs: 320_000,
  },
  U2: {
    label: "Stadium check",
    mode: "car",
    points: [CAMPUS_ROADS.stadium, CAMPUS_ROADS.jadwin],
    durationMs: 390_000,
  },
  U6: {
    label: "Building check",
    mode: "car",
    points: [CAMPUS_ROADS.equad, CAMPUS_ROADS.frist],
    durationMs: 420_000,
  },
  U8: {
    label: "Dillon foot post",
    mode: "foot",
    points: [CAMPUS_ROADS.dillon, CAMPUS_ROADS.whitman],
    durationMs: 300_000,
  },
};

/**
 * Demo roster: most officers free so assign never runs dry.
 * Four sit at HQ (clustered as one map badge). Available field units stand by in place.
 */
export const SEED_OFFICERS: Officer[] = [
  {
    id: "U1", callsign: "Reyes", name: "Ofc. Dana Reyes", badge: "4127", type: "police", mode: "car",
    status: "busy", location: CAMPUS_ROADS.nassauW, locationLabel: "Nassau check",
    lastLocationAt: T0, currentIncidentId: null, busyWith: "Door prop — Nassau Hall",
    avatar: { skin: "#E9C9A8", hair: "#2A1A12", hat: "#1A2234" },
  },
  {
    id: "U2", callsign: "Hale", name: "Ofc. Marcus Hale", badge: "3381", type: "police", mode: "car",
    status: "busy", location: CAMPUS_ROADS.stadium, locationLabel: "Stadium check",
    lastLocationAt: T0, currentIncidentId: null, busyWith: "Noise complaint — stadium lot",
    avatar: { skin: "#C68642", hair: "#1A120C", hat: "#1A2234" },
  },
  {
    id: "U3", callsign: "Nair", name: "Ofc. Priya Nair", badge: "2904", type: "police", mode: "foot",
    status: "available", location: CAMPUS_ROADS.washingtonN, locationLabel: "Standing by — Washington Rd",
    lastLocationAt: T0, currentIncidentId: null, busyWith: null,
    avatar: { skin: "#D4A574", hair: "#3D2314", hat: "#1A2234" },
  },
  {
    id: "U4", callsign: "Chen", name: "Ofc. Mei Chen", badge: "4502", type: "police", mode: "car",
    status: "available", location: CAMPUS_ROADS.whitman, locationLabel: "Standing by — Whitman",
    lastLocationAt: T0, currentIncidentId: null, busyWith: null,
    avatar: { skin: "#F0D5B8", hair: "#0D0D0D", hat: "#1A2234" },
  },
  {
    id: "U5", callsign: "Brooks", name: "Ofc. Jordan Brooks", badge: "3819", type: "police", mode: "car",
    status: "available", location: PSAFE_HQ, locationLabel: "PSAFE HQ desk",
    lastLocationAt: T0, currentIncidentId: null, busyWith: null,
    avatar: { skin: "#8D5524", hair: "#1C1008", hat: "#1A2234" },
  },
  {
    id: "U6", callsign: "Okonkwo", name: "Ofc. Amara Okonkwo", badge: "4011", type: "police", mode: "car",
    status: "busy", location: CAMPUS_ROADS.equad, locationLabel: "Building check — EQuad",
    lastLocationAt: T0, currentIncidentId: null, busyWith: "Building check — EQuad",
    avatar: { skin: "#A06B3C", hair: "#0A0604", hat: "#1A2234" },
  },
  {
    id: "U7", callsign: "Patel", name: "Ofc. Ravi Patel", badge: "3670", type: "police", mode: "car",
    status: "available", location: CAMPUS_ROADS.firestone, locationLabel: "Standing by — Firestone",
    lastLocationAt: T0, currentIncidentId: null, busyWith: null,
    avatar: { skin: "#C68642", hair: "#2C1810", hat: "#1A2234" },
  },
  {
    id: "U8", callsign: "Vargas", name: "Ofc. Sofia Vargas", badge: "4290", type: "police", mode: "foot",
    status: "busy", location: CAMPUS_ROADS.dillon, locationLabel: "Dillon foot post",
    lastLocationAt: T0, currentIncidentId: null, busyWith: "Wellness walk — Dillon",
    avatar: { skin: "#E0B090", hair: "#4A2010", hat: "#1A2234" },
  },
  {
    id: "U9", callsign: "Kim", name: "Ofc. Alex Kim", badge: "4410", type: "police", mode: "car",
    status: "available", location: PSAFE_HQ, locationLabel: "PSAFE HQ desk",
    lastLocationAt: T0, currentIncidentId: null, busyWith: null,
    avatar: { skin: "#F5D0A9", hair: "#1A1A1A", hat: "#1A2234" },
  },
  {
    id: "U10", callsign: "Diaz", name: "Ofc. Luis Diaz", badge: "3922", type: "police", mode: "car",
    status: "available", location: PSAFE_HQ, locationLabel: "PSAFE HQ desk",
    lastLocationAt: T0, currentIncidentId: null, busyWith: null,
    avatar: { skin: "#C68E5B", hair: "#2B1810", hat: "#1A2234" },
  },
  {
    id: "U11", callsign: "Walsh", name: "Ofc. Casey Walsh", badge: "4155", type: "police", mode: "car",
    status: "available", location: PSAFE_HQ, locationLabel: "PSAFE HQ ready room",
    lastLocationAt: T0, currentIncidentId: null, busyWith: null,
    avatar: { skin: "#E8C4A0", hair: "#5C3A21", hat: "#1A2234" },
  },
];
