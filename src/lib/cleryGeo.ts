// Automatic Clery Act geography for a case location, from data/clery-geography.json
// (built by scripts/build_clery.py from OpenStreetMap). Mirrors how Princeton's Annual Security and
// Fire Safety Report splits statistics: Main Campus / James Forrestal Campus, each into On campus
// (with Residential facility), Noncampus building or property, and Public property.
//
// The shapes approximate the University's official Clery map, so the label is a strong default that
// the Clery file records automatically; the official map in the ASR remains the authority.
import GEO from "../../data/clery-geography.json";

export type CleryGeography = "on_campus" | "public_property" | "noncampus" | "outside" | "unknown";

type Ring = number[][]; // [lng, lat] points, closed
interface Shape { id?: string; name: string; outer: Ring[]; inner: Ring[] }

const CAMPUSES = GEO.campuses as Shape[];
const RESIDENTIAL = GEO.residential as Shape[];
const CLUBS = GEO.eatingClubs as Shape[];
const UNIVERSITY_BUILDINGS = GEO.universityBuildings as Shape[];

/** Public streets and sidewalks this close to the campus edge count as "immediately adjacent". */
const ADJACENT_M = 60;

export interface CleryPlace {
  geography: CleryGeography;
  campus: "Main Campus" | "James Forrestal Campus" | null;
  residential: boolean;
  /** Short label for the case and the Clery file, e.g. "On campus · residential facility (Main Campus)". */
  label: string;
  /** One sentence on why. */
  detail: string;
}

function inRing(lng: number, lat: number, r: Ring): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i];
    const [xj, yj] = r[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const inShape = (s: Shape, lng: number, lat: number) =>
  s.outer.some((r) => inRing(lng, lat, r)) && !s.inner.some((r) => inRing(lng, lat, r));

/** Metres from the point to the nearest edge of the shape (flat-earth; fine at campus scale). */
function edgeDistM(s: Shape, lng: number, lat: number): number {
  const kx = 111_320 * Math.cos((lat * Math.PI) / 180);
  const ky = 110_574;
  let best = Infinity;
  for (const r of [...s.outer, ...s.inner]) {
    for (let i = 1; i < r.length; i++) {
      const ax = (r[i - 1][0] - lng) * kx, ay = (r[i - 1][1] - lat) * ky;
      const bx = (r[i][0] - lng) * kx, by = (r[i][1] - lat) * ky;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
  }
  return best;
}

const near = (s: Shape, lng: number, lat: number, m: number) => inShape(s, lng, lat) || edgeDistM(s, lng, lat) <= m;
const campusName = (s: Shape) => (s.id?.startsWith("forrestal") ? "James Forrestal Campus" : "Main Campus") as CleryPlace["campus"];

/** Residential colleges, upperclass/graduate housing, and words for a student's room. */
const RESIDENCES = /\b(whitman|butler|mathey|rockefeller|rocky|forbes|yeh|new college west|first college|wilson college|hamilton college|graduate college|lakeside|lawrence apartments|meadows|dod hall|pyne hall|1903 hall|spelman|blair hall|little hall|henry hall|holder hall|foulke|laughlin|witherspoon hall|edwards hall|brown hall|cuyler|scully|bloomberg hall|dorm(itory)?|residence hall|my room|our room|suite)\b/i;

/** Words that put a call outside a building: the lawn, the sidewalk, the street. */
const OUTDOORS = /\b(lawn|yard|sidewalk|street|road|avenue|ave|outside|out front|in front|front of|porch|steps|curb|parking)\b/i;

/**
 * Classify a point. `hint` is the location wording from the call (location details, description), used
 * only to tell "inside the eating club" from "on its lawn / Prospect Ave".
 */
export function classifyClery(lat: number, lng: number, hint = ""): CleryPlace {
  const club = CLUBS.find((c) => near(c, lng, lat, 8));
  if (club) {
    if (OUTDOORS.test(hint)) {
      return {
        geography: "public_property", campus: "Main Campus", residential: false,
        label: "Public property (Main Campus)",
        detail: `Outside ${club.name}: the club lawns and Prospect Ave are public property on the Clery map.`,
      };
    }
    return {
      geography: "outside", campus: null, residential: false,
      label: "Not Clery geography (private eating club)",
      detail: `${club.name} is an independent eating club; the building is not on the University's Clery map.`,
    };
  }

  const campus = CAMPUSES.find((c) => inShape(c, lng, lat));
  if (campus) {
    const name = campusName(campus);
    const hall = RESIDENTIAL.find((r) => near(r, lng, lat, 20));
    const named = hint.match(RESIDENCES);
    return hall || named
      ? {
          geography: "on_campus", campus: name, residential: true,
          label: `On campus · residential facility (${name})`,
          detail: named
            ? `${named[0][0].toUpperCase()}${named[0].slice(1)} is University student housing on the ${name}.`
            : `${hall!.name === "Residence hall" ? "This residence hall" : hall!.name} is University student housing on the ${name}.`,
        }
      : {
          geography: "on_campus", campus: name, residential: false,
          label: `On campus (${name})`,
          detail: `Inside the ${name} boundary.`,
        };
  }

  const building = UNIVERSITY_BUILDINGS.find((b) => near(b, lng, lat, 6));
  if (building) {
    return {
      geography: "noncampus", campus: null, residential: false,
      label: "Noncampus building or property",
      detail: `${building.name} is University property outside the contiguous campus.`,
    };
  }

  let closest: Shape | null = null;
  let dist = Infinity;
  for (const c of CAMPUSES) {
    const d = edgeDistM(c, lng, lat);
    if (d < dist) { dist = d; closest = c; }
  }
  if (closest && dist <= ADJACENT_M) {
    const name = campusName(closest);
    return {
      geography: "public_property", campus: name, residential: false,
      label: `Public property (${name})`,
      detail: `Street or sidewalk immediately adjacent to the ${name} (${Math.round(dist)} m from the boundary).`,
    };
  }
  return {
    geography: "outside", campus: null, residential: false,
    label: "Not Clery geography",
    detail: closest
      ? `${dist < 1000 ? `${Math.round(dist / 10) * 10} m` : `${(dist / 1000).toFixed(1)} km`} from the nearest campus boundary, so not on the Clery map.`
      : "No campus boundary data.",
  };
}
