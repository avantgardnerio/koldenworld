# OSM pipeline

## Current: cells on demand (decision 22)

```
viewer: cells within the horizon (level 13, nearest first)
   │  GET /cells/<token>/<table>.arrow        (Vite proxies to the cell server: npm run server)
   ▼
cell server (packages/cli: server.ts, cells.ts)
   ├─ cache hit: data/export/cells/<token>/*.arrow (manifest versions match) ─▶ respond
   └─ miss:
       1. download cells: every level-12 cell within the cell's reach + 300 m
          not yet in osm_fetches (area "s2:<token>"):
            Overpass (one download at a time, retried while busy)
              ─▶ data/osm/s2/<token>.json + .meta.json  (gitignored raw snapshot)
              ─▶ @game/osm-import ─▶ PostGIS (same import as below)
       2. PostGIS road_ways + buildings in the cell's box + 300 m (plus ways sharing their nodes)
            ─▶ @game/world buildCell: ownership, cell frame ─▶ Arrow IPC
       3. write the cache (temp + rename, manifest last) ─▶ respond
```

`npm run cli -- cell --token <token>` runs the same path for one cell, without a browser.

### Regional extracts (decision 23)

```
Geofabrik .osm.pbf + .poly ─▶ data/osm/pbf/          (curl -L; md5 checked)
   │  npm run cli -- import-pbf --file data/osm/pbf/colorado-latest.osm.pbf [--within lat,lon,km]
   ▼
@game/osm-import pbf.ts: nodes → sorted coordinate index; building relations; ways the extractors want
   ─▶ bucket ways by level-12 cell ─▶ per cell: the same importSnapshot as an Overpass download
   ─▶ osm_fetches area "s2:<token>" for every cell fully inside the .poly
```

Measured (Colorado, Nov 2026): 389 MB, 54 M nodes, 4.4 M ways; decoded in 6 s, 2.6 M ways kept; the 148 download cells within 15 km of downtown Denver imported in 5 s after a 17 s parse. The cell server checks `osm_fetches` first, so these cells never touch Overpass.

Measured (downtown Denver, Nov 2026): a level-12 download is 7–38 MB of raw OSM and takes 20–45 s from overpass-api.de; the first cell needed 5 of them. A downtown level-13 cell is 391 edges and 2,212 buildings, about 250 KB of Arrow.

### Zip codes (still available)

```
zip code ─▶ Census ZCTA gazetteer (data/census/) ─▶ center point ─▶ square bbox
   │  npm run cli -- fetch-osm --zip 80205 --size 4     (once per area)
   ▼
Overpass API ─▶ data/osm/<zip>.json + <zip>.meta.json   (gitignored raw snapshot)
   │  npm run cli -- import --zip 80205                 (repeatable, no network)
   ▼
@game/osm-import (pure TS): raw OSM → drivable ways, buildings (resolved attributes)
   │  @game/db: one transaction
   ▼
PostGIS: osm_fetches, road_ways, buildings (upsert by OSM key; delete rows gone from the box)
```

The per-area export (`cli export --zip`) is gone: rows imported this way are exported through cells like any others.

## Target (later)

```
PostGIS ─▶ export (TS, Node): as now, plus an R-tree per cell and LOD levels
        ─▶ Arrow files per table per cell, immutable, keyed by content hash
        ─▶ GET /cells/{token}/{hash}/{table}.arrow   (Cache-Control: immutable, brotli)
        ─▶ client getBlob() → typed-array views
```

For whole regions, Geofabrik extracts via osm2pgsql (or our converter reading `.pbf`) replace Overpass snapshots. The tables and everything downstream stay the same.

## Choosing an area

1. **Zip code → point.** The US Census ZCTA Gazetteer (public domain, ~33k rows) is downloaded once into `data/census/`. Its "internal point" is used as the center. For addresses or other countries, Nominatim (light use only, per its usage policy).
2. **Point → bbox.** A fixed square around the point (`--size` in km). Zip boundaries are not used: rural zips can cover hundreds of km².
3. **Overpass query:** everything in the box, plus the out-of-box nodes of ways that cross its edge, so every way's geometry is complete.

## Import (osm-import + db)

- Select drivable ways: `highway` in motorway…residential, living_street, service, road, and their `_link` variants; not `area=yes`.
- Resolve one-way (explicit tags, implied for motorways and roundabouts), lanes per direction, speed limit (tag or US default by class). Geometry and node order are stored in the direction of travel for one-way roads.
- Upsert into `road_ways` by `osm_way_id`. Then delete road ways that have a node inside the fetched box but were not in this fetch (deleted upstream, or no longer a road).
- Record the fetch in `osm_fetches` (keyed by file sha256, so re-importing the same file is idempotent).

### Buildings

- Sources: closed ways and multipolygon relations tagged `building=*` or `building:part=*` (not `no`). Relation member ways are joined into rings by matching endpoints; inner rings are attached to the outer ring containing them. Building nodes (4 in 80205) are ignored.
- Height: `height=*` (meters, feet or feet'inches"), else `building:levels` × 3 m, else a default by kind (house 6 m, garage 3 m, apartments 12 m, …). `min_height` or `building:min_level` × 3 m lifts the bottom. The source is stored (`height_source`) so estimated heights stay visible.
- Keyed by `(osm_type, osm_id)` (ways and relations have separate id spaces); geometry is always a MultiPolygon.
- 80205: 16,694 buildings + 379 parts, none skipped; heights from `height` 6,716 (Denver's lidar import), levels 1,683, default 8,674. Tallest: 213 m.

All OSM interpretation lives in TS so the server, CLI and tests share it.

## Export

Built (`@game/world` `buildCell`, run by the cell server):
- Cut ways into edges at nodes shared with another way (OSM intersections are shared node ids, not geometric crossings, so bridges stay unconnected). Nodes and edges are numbered densely in `osm_way_id` order, so output is reproducible.
- Ownership (decision 22): an edge belongs to the cell containing the middle of its points; a building polygon to the cell containing the centroid of its building's first outer ring. Every object is in exactly one cell.
- Ways are loaded with every way sharing one of their nodes, so a way is cut at the same nodes whichever cell exports it.
- Project lat/lon onto the cell's tangent plane (ENU at the cell center, WGS84; decision 20). z is dropped for now: a few cm at the cell's edges.
- Build CSR incidence lists (each node's incident edges).
- Write Arrow IPC files (decision 15) and check the round trip before writing.

Buildings (`buildBuildings`): one row per polygon; rings opened (no repeated closing point) and oriented (outer counterclockwise, holes clockwise). An outline is left out when a `building:part` lies inside it (`ST_PointOnSurface` of the part), since the parts describe its shape; parts are always kept. 80205: 17,011 buildings and parts → 17,014 polygons, 130,696 points; `buildings.arrow` 1.5 MB raw, 757 KB brotli.

80205 (the old per-area export, for reference): 3,775 ways → 5,598 nodes, 7,684 edges, 24,758 points. 98% of nodes are in one connected component; the remaining 13 components are mostly tiny pieces cut off at the bbox edge. Counts match an independent SQL computation.

Not built yet:
- Cells with adaptive levels (deeper where dense); every cell is level 13 today.
- Invalidating cached cells when a newer snapshot of their data is imported.
- Merging degree-2 nodes where one way simply continues into the next (897 such nodes in 80205).
- Content-hash keys: hash(data snapshot + graph version + partition id).
- R-tree in the export.

## Data quality

- Roads: good almost everywhere in the US.
- Buildings: detailed in most downtowns, sparse or missing in many suburbs and towns. Heights often missing.
- Rural areas: sparse but drivable.

## Licensing

OSM data is ODbL. The game must display "© OpenStreetMap contributors". Publicly distributed derived data (our blobs) may carry share-alike obligations; game code does not. Get a proper read before any public release.
