# Regenerates s2-golden.json from s2sphere (a Python port of Google's S2), the
# reference our TypeScript S2 is checked against:
#   python3 -m venv /tmp/s2 && /tmp/s2/bin/pip install s2sphere==0.2.5
#   /tmp/s2/bin/python packages/world/test/s2-golden.py > packages/world/test/s2-golden.json
import json
import s2sphere as s2

POINTS = [
    ("denver", 39.758861, -104.964699), ("chicago", 41.878113, -87.629799),
    ("null island", 0, 0), ("north pole", 90, 0), ("south pole", -90, 0),
    ("antimeridian", 10, 180), ("antimeridian west", -10, -179.9999999),
    ("face 1", 5, 90), ("face 3", 5, -170), ("face 4", -5, -90), ("svalbard", 78.22, 15.65),
    ("tokyo", 35.6812, 139.7671), ("cape town", -33.9249, 18.4241),
]


def ll(p):
    l = s2.LatLng.from_point(p)
    return [l.lat().degrees, l.lng().degrees]


out = {"points": [], "neighbors": []}
for name, lat, lon in POINTS:
    leaf = s2.CellId.from_lat_lng(s2.LatLng.from_degrees(lat, lon))
    c13 = leaf.parent(13)
    c10 = leaf.parent(10)
    out["points"].append({
        "name": name, "lat": lat, "lon": lon,
        "ids": {str(l): str(leaf.parent(l).id()) for l in (0, 1, 5, 13, 22, 30)},
        "token13": c13.to_token(),
        "center13": ll(c13.to_point()),
        "corners10": [ll(s2.Cell(c10).get_vertex(k)) for k in range(4)],
    })
    for level in (0, 2, 13):
        c = leaf.parent(level)
        out["neighbors"].append({"id": str(c.id()), "neighbors": [str(n.id()) for n in c.get_edge_neighbors()]})

# Cells at face corners and edges, where neighbors wrap onto other faces.
for face in range(6):
    for level in (3, 13):
        c = s2.CellId.from_face_pos_level(face, 0, level)
        out["neighbors"].append({"id": str(c.id()), "neighbors": [str(n.id()) for n in c.get_edge_neighbors()]})
        last = s2.CellId.from_face_pos_level(face, (1 << 61) - 1, level)
        out["neighbors"].append({"id": str(last.id()), "neighbors": [str(n.id()) for n in last.get_edge_neighbors()]})

print(json.dumps(out, indent=1))
