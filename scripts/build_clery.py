#!/usr/bin/env python3
"""Build data/clery-geography.json: the shapes the console uses to sort each case into Princeton's Clery
Act geography automatically (on campus / residential facility / public property / noncampus / outside).

Source: OpenStreetMap via Overpass (ODbL). Shapes are approximations of the University's official Clery
map, which is published in the Annual Security and Fire Safety Report (publicsafety.princeton.edu). The
report splits statistics by Main Campus and James Forrestal Campus, each into On campus (with Residential
facility), Noncampus building or property, and Public property.

Usage: python3 scripts/build_clery.py            (fetches from Overpass)
       python3 scripts/build_clery.py --osm f.json  (uses a saved Overpass response)
"""
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "data" / "clery-geography.json"
SERVERS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter"]
UA = "campus-dispatch-demo/0.1 (hackathon project)"

QUERY = """[out:json][timeout:120];
(
  rel(6365145);                                                     /* Princeton University main campus */
  way["amenity"="university"]["name"~"Princeton University"](40.25,-74.75,40.45,-74.5);
  way["name"="Princeton Plasma Physics Laboratory"](40.3,-74.65,40.4,-74.55);
  way["building"="dormitory"](40.30,-74.70,40.37,-74.60);
  way["amenity"="social_centre"]["name"~"Club|Tiger Inn|Cloister Inn"](40.34,-74.66,40.355,-74.64);
  rel(7170150);                                                     /* University Cottage Club */
  way["building"]["operator"~"Princeton University"](40.30,-74.72,40.40,-74.58);
);
out geom;"""  # plain "out geom" (not "out geom tags") keeps relation member shapes


def fetch():
    body = urllib.parse.urlencode({"data": QUERY}).encode()
    for attempt in range(6):
        for url in SERVERS:
            try:
                req = urllib.request.Request(url, data=body, headers={"User-Agent": UA})
                raw = urllib.request.urlopen(req, timeout=180).read()
                return json.loads(raw)
            except Exception as exc:  # noqa: BLE001
                print("overpass failed:", url, exc, file=sys.stderr)
        time.sleep(5 * (attempt + 1))
    sys.exit("Overpass unavailable; try again later or pass --osm")


def ring(geom):
    return [[round(p["lon"], 6), round(p["lat"], 6)] for p in geom]


def join_ways(parts):
    """Stitch multipolygon member ways (each a list of [lng, lat]) into closed rings."""
    parts = [p[:] for p in parts if len(p) >= 2]
    rings = []
    while parts:
        cur = parts.pop(0)
        changed = True
        while cur[0] != cur[-1] and changed:
            changed = False
            for i, p in enumerate(parts):
                if p[0] == cur[-1]:
                    cur += p[1:]
                elif p[-1] == cur[-1]:
                    cur += p[::-1][1:]
                elif p[-1] == cur[0]:
                    cur = p + cur[1:]
                elif p[0] == cur[0]:
                    cur = p[::-1] + cur[1:]
                else:
                    continue
                parts.pop(i)
                changed = True
                break
        if len(cur) >= 4:
            rings.append(cur)
    return rings


def shape(e):
    """{'outer': [rings], 'inner': [rings]} for a way or multipolygon relation."""
    if e["type"] == "way":
        g = ring(e.get("geometry") or [])
        return {"outer": [g] if len(g) >= 4 else [], "inner": []}
    outer = join_ways([ring(m["geometry"]) for m in e.get("members", []) if m.get("role") == "outer" and m.get("geometry")])
    inner = join_ways([ring(m["geometry"]) for m in e.get("members", []) if m.get("role") == "inner" and m.get("geometry")])
    return {"outer": outer, "inner": inner}


def main():
    if "--osm" in sys.argv:
        data = json.load(open(sys.argv[sys.argv.index("--osm") + 1]))
    else:
        data = fetch()
    campuses, residential, clubs, university_buildings = [], [], [], []
    for e in data["elements"]:
        t = e.get("tags", {})
        name = t.get("name", "")
        s = shape(e)
        if not s["outer"]:
            continue
        if t.get("amenity") == "university" and name.startswith("Princeton University"):
            if "Forrestal" in name:
                campuses.append({"id": "forrestal", "name": "James Forrestal Campus", **s})
            elif "Meadows" in name:
                # Graduate housing south of Lake Carnegie, contiguous with the main campus.
                campuses.append({"id": "main-meadows", "name": "Main Campus (Meadows Neighborhood)", **s})
                residential.append({"name": "Meadows Neighborhood", **s})
            else:
                campuses.append({"id": "main", "name": "Main Campus", **s})
        elif name == "Princeton Plasma Physics Laboratory":
            campuses.append({"id": "forrestal-pppl", "name": "James Forrestal Campus (PPPL)", **s})
        elif t.get("amenity") == "social_centre":
            clubs.append({"name": name, **s})
        elif t.get("building") == "dormitory":
            residential.append({"name": name or "Residence hall", **s})
        elif "Princeton University" in t.get("operator", ""):
            university_buildings.append({"name": name or "University building", **s})
    out = {
        "attribution": "Shapes © OpenStreetMap contributors (ODbL), via Overpass. Approximation of Princeton's Clery map; "
        "the official geography is in the Annual Security and Fire Safety Report (publicsafety.princeton.edu).",
        "campuses": campuses,
        "residential": residential,
        "eatingClubs": clubs,
        "universityBuildings": university_buildings,
    }
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    print("campuses", [(c["id"], len(c["outer"]), sum(len(r) for r in c["outer"])) for c in campuses])
    print("residential", len(residential), "eating clubs", sorted(c["name"] for c in clubs))
    print("university buildings", len(university_buildings), "->", OUT, OUT.stat().st_size, "bytes")


if __name__ == "__main__":
    main()
