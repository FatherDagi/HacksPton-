#!/usr/bin/env python3
"""Build data/princeton-places.json: every named place a caller might mention on/around campus.

Sources
- OpenStreetMap (Overpass API): named buildings, amenities, fields, landmarks, streets and paths in
  the campus bounding box, with coordinates. (c) OpenStreetMap contributors, ODbL.
- station-desk/app/princeton_places.txt: the campus office directory ("Admission, Clio Hall"), used to
  add office names as aliases of the building they are in.
- CURATED below: places people say that OSM names differently or not at all (residential colleges,
  E-Quad, Public Safety, Dinky station), plus common mishearings. Coordinates are approximate.

Usage: python3 scripts/build_places.py [--osm cached_overpass.json]
"""
import json
import os
import re
import sys
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "princeton-places.json")
DIRECTORY = os.path.join(ROOT, "station-desk", "app", "princeton_places.txt")
BBOX = "40.3360,-74.6680,40.3575,-74.6380"
OVERPASS = [
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

# name -> (lat, lng, kind, aliases). Aliases include ways speech-to-text commonly mishears the name.
CURATED = {
    "Frist Campus Center": (40.3468, -74.6551, "building", ["frist", "frist center", "first campus center", "first center", "frist student center", "the campus center"]),
    "Engineering Quadrangle": (40.3503, -74.6515, "building", ["e-quad", "e quad", "equad", "engineering quad", "the e quad"]),
    "Whitman College": (40.3443, -74.6583, "college", ["whitman", "whitman dorms"]),
    "Butler College": (40.3446, -74.6569, "college", ["butler", "butler dorms"]),
    "Rockefeller College": (40.3480, -74.6619, "college", ["rockefeller", "rocky college"]),
    "Mathey College": (40.3486, -74.6624, "college", ["mathey", "mathy", "matty college"]),
    "Forbes College": (40.3420, -74.6612, "college", ["forbes"]),
    "Yeh College": (40.3426, -74.6540, "college", ["yeh college", "yay college"]),
    "New College West": (40.3424, -74.6530, "college", ["new college west", "ncw"]),
    "First College": (40.3460, -74.6560, "college", ["first college", "wilson college"]),
    "Department of Public Safety": (40.3434, -74.6563, "building", ["public safety", "dps", "public safety building", "200 elm drive"]),
    "Princeton Station (Dinky)": (40.3433, -74.6600, "station", ["dinky", "the dinky", "princeton station", "train station", "dinky station"]),
    "Princeton Stadium": (40.3457, -74.6494, "field", ["the stadium", "princeton stadium", "powers field", "football stadium"]),
    "Jadwin Gymnasium": (40.3437, -74.6486, "building", ["jadwin", "jadwin gym", "jad win"]),
    "Dillon Gymnasium": (40.3464, -74.6603, "building", ["dillon", "dillon gym"]),
    "Firestone Library": (40.3496, -74.6576, "building", ["firestone", "fire stone", "fire stone library"]),
    "Nassau Hall": (40.3487, -74.6593, "building", ["nassau hall", "nasa hall"]),
    "McCosh Hall": (40.3482, -74.6553, "building", ["mccosh", "mc cosh", "mick cosh", "mccosh hall"]),
    "Princeton University Chapel": (40.3489, -74.6567, "building", ["the chapel", "university chapel", "princeton chapel"]),
    "Lewis Library": (40.3463, -74.6527, "building", ["lewis library", "lewis science library"]),
    "Frick Chemistry Laboratory": (40.3449, -74.6519, "building", ["frick", "frick lab", "frick chemistry"]),
    "Fine Hall": (40.3459, -74.6524, "building", ["fine hall", "math building"]),
    "Princeton University Art Museum": (40.3478, -74.6577, "building", ["art museum", "the art museum"]),
    "Palmer Square": (40.3500, -74.6612, "landmark", ["palmer square"]),
    "Clio Hall": (40.3477, -74.6591, "building", ["admission office", "admissions office", "clio"]),
    "Nassau Street": (40.3497, -74.6585, "street", ["nassau street", "nassau st"]),
    "Washington Road": (40.3462, -74.6537, "street", ["washington road", "washington rd"]),
}

JUNK = re.compile(r"^(#?\d+|[A-Z]?\d+[A-Z]?)$")
KIND_ORDER = ["building", "amenity", "leisure", "tourism", "landuse", "railway", "highway"]


def norm(s):
    return " ".join(re.sub(r"[^a-z0-9]+", " ", str(s).lower()).split())


def fetch_osm():
    q = (
        "[out:json][timeout:60];("
        + "".join(
            'nwr["name"]["{}"]({});'.format(k, BBOX) for k in ("building", "amenity", "leisure", "tourism", "landuse")
        )
        + 'nwr["name"]["highway"~"^(primary|secondary|tertiary|residential|unclassified|service|pedestrian|footway)$"]({});'.format(BBOX)
        + 'nwr["name"]["railway"="station"]({});'.format(BBOX)
        + ");out center tags;"
    )
    body = urllib.parse.urlencode({"data": q}).encode()
    for url in OVERPASS:
        try:
            req = urllib.request.Request(url, data=body, headers={"User-Agent": "campus-dispatch-hackathon-demo"})
            return json.load(urllib.request.urlopen(req, timeout=90))
        except Exception as exc:  # try the next mirror
            print("overpass failed:", url, exc, file=sys.stderr)
    raise SystemExit("no Overpass mirror reachable")


def directory_aliases():
    """'Admission, Clio Hall, G3' -> ('admission office', 'Clio Hall'). Entries wrap across lines."""
    text = open(DIRECTORY, encoding="utf-8").read().splitlines()
    entries, buf = [], ""
    for line in text:
        buf = (buf + " " + line.strip()).strip()
        if re.search(r"[ ,][A-Z]\d{1,2}$", buf):
            entries.append(re.sub(r",?\s*[A-Z]\d{1,2}$", "", buf))
            buf = ""
    out = []
    for e in entries:
        parts = [p.strip() for p in e.split(",") if p.strip()]
        if len(parts) >= 2:
            building = re.sub(r"^\d+\s+", "", parts[-1])  # "50 McCosh Hall" -> "McCosh Hall"
            building = re.sub(r"\s+(first|second|third|fourth|ground) floor$", "", building, flags=re.I)
            out.append((parts[0], building))
    return out


def main():
    osm_path = sys.argv[sys.argv.index("--osm") + 1] if "--osm" in sys.argv else None
    raw = json.load(open(osm_path)) if osm_path else fetch_osm()

    places = {}  # normalized name -> place
    for el in raw["elements"]:
        tags = el.get("tags", {})
        name = (tags.get("name") or "").strip()
        center = el.get("center") or ({"lat": el["lat"], "lon": el["lon"]} if "lat" in el else None)
        if not name or not center or len(name) < 3 or JUNK.match(name):
            continue
        kind = next((k for k in KIND_ORDER if k in tags), "other")
        kind = {"highway": "street", "railway": "station", "landuse": "area", "leisure": "field"}.get(kind, kind)
        key = norm(name)
        p = places.get(key)
        if p is None:
            places[key] = {"name": name, "kind": kind, "lat": center["lat"], "lng": center["lon"], "n": 1,
                           "aliases": [], "source": "osm"}
        elif p["kind"] == "street" and kind == "street":
            # Average the segments of a street so its pin sits near the middle.
            p["lat"] = (p["lat"] * p["n"] + center["lat"]) / (p["n"] + 1)
            p["lng"] = (p["lng"] * p["n"] + center["lon"]) / (p["n"] + 1)
            p["n"] += 1
        elif KIND_ORDER.index(tags_kind(tags)) < KIND_ORDER.index(tags_kind_of(p)):
            places[key] = {"name": name, "kind": kind, "lat": center["lat"], "lng": center["lon"], "n": 1,
                           "aliases": p["aliases"], "source": "osm"}

    for name, (lat, lng, kind, aliases) in CURATED.items():
        key = norm(name)
        p = places.get(key)
        if p is None:
            places[key] = {"name": name, "kind": kind, "lat": lat, "lng": lng, "n": 1, "aliases": [], "source": "curated"}
            p = places[key]
        p["aliases"] = sorted(set(p["aliases"]) | {norm(a) for a in aliases} - {key})

    added = 0
    for office, building in directory_aliases():
        p = places.get(norm(building))
        alias = norm(office)
        # Only specific multi-word office names, and only onto buildings: one-word entries like "train",
        # "taxi" or "information" are everyday words and would drop false pins.
        if p and p["kind"] not in ("street", "area") and len(alias.split()) >= 2:
            if alias not in p["aliases"] and alias != norm(p["name"]):
                p["aliases"].append(alias)
                added += 1

    out = []
    for key, p in sorted(places.items(), key=lambda kv: kv[1]["name"].lower()):
        aliases = sorted(set(p["aliases"]))
        # Phrases that identify the place in speech: full names of 2+ words plus curated aliases.
        # One-word OSM names ("Commons", "Proof", "Princeton") are everyday words, so never on their own.
        match = sorted({key} if len(key.split()) >= 2 else set()) + [a for a in aliases if a != key]
        out.append({
            "id": re.sub(r"[^a-z0-9]+", "-", key).strip("-")[:60],
            "name": p["name"],
            "kind": p["kind"],
            "lat": round(p["lat"], 6),
            "lng": round(p["lng"], 6),
            "aliases": aliases,
            "match": sorted(set(match)),
            "source": p["source"],
        })
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"attribution": "Contains data (c) OpenStreetMap contributors, ODbL; curated campus aliases.",
                   "places": out}, f, indent=1, ensure_ascii=False)
    kinds = {}
    for p in out:
        kinds[p["kind"]] = kinds.get(p["kind"], 0) + 1
    print("wrote", len(out), "places to", os.path.relpath(OUT, ROOT), kinds, "| office aliases added:", added)


def tags_kind(tags):
    return next((k for k in KIND_ORDER if k in tags), KIND_ORDER[-1])


def tags_kind_of(p):
    back = {"street": "highway", "station": "railway", "area": "landuse", "field": "leisure"}
    k = back.get(p["kind"], p["kind"])
    return k if k in KIND_ORDER else KIND_ORDER[-1]


if __name__ == "__main__":
    main()
