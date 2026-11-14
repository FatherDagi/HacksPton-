// Princeton places database (data/princeton-places.json, built by scripts/build_places.py from
// OpenStreetMap plus curated campus aliases). Finds the places a caller names in a transcript.
import data from "../../data/princeton-places.json";
import type { LatLng } from "./types";

export interface Place {
  id: string;
  name: string;
  kind: string;
  lat: number;
  lng: number;
  aliases: string[];
  match: string[];
  source: string;
}

export const PLACES: Place[] = (data as { places: Place[] }).places;
const BY_ID = new Map(PLACES.map((p) => [p.id, p]));

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");

/** Spoken phrase (normalized, without a leading "the") -> place. Longest phrases are tried first. */
const PHRASES = new Map<string, Place>();
for (const p of PLACES) {
  const names = [...p.match, norm(p.name.replace(/\s*\([^)]*\)/g, ""))].filter((m) => m.split(" ").length >= 2 || p.match.includes(m));
  for (const m of names) {
    const key = m.startsWith("the ") ? m.slice(4) : m;
    if (key && !PHRASES.has(key)) PHRASES.set(key, p);
  }
}
const MAX_WORDS = Math.max(...[...PHRASES.keys()].map((k) => k.split(" ").length));

export const placeById = (id: string) => BY_ID.get(id);
export const placeLatLng = (p: Place): LatLng => [p.lat, p.lng];
/** Streets and large areas are vaguer than a building, field or station. */
export const isVague = (p: Place) => p.kind === "street" || p.kind === "area";
/** Name as said in a transcript or on a map label ("Princeton Station (Dinky)" -> "Princeton Station"). */
export const spokenName = (p: Place) => p.name.replace(/\s*\([^)]*\)/g, "").trim();

/** Places named in the text, in the order they are first mentioned (each once). */
export function findPlaces(text: string): Place[] {
  const words = norm(text).split(" ").filter(Boolean);
  const found: Place[] = [];
  for (let i = 0; i < words.length; ) {
    let hit: { p: Place; n: number } | null = null;
    for (let n = Math.min(MAX_WORDS, words.length - i); n >= 1; n--) {
      const p = PHRASES.get(words.slice(i, i + n).join(" "));
      if (p) { hit = { p, n }; break; }
    }
    if (hit) {
      if (!found.includes(hit.p)) found.push(hit.p);
      i += hit.n;
    } else i++;
  }
  return found;
}

/** Best place to pin the incident at: the first specific place named, else the first street. */
export function primaryPlace(found: Place[]): Place | null {
  return found.find((p) => !isVague(p)) ?? found[0] ?? null;
}
