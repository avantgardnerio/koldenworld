# OSM pipeline

## Current: cell files, read by the Rust cell generator

```
viewer: cells and tiles in view
   │  GET /ground/<token>/<table>.arrow and /aircraft  (cellgen serve, port 5175, through Vite)
   ▼
cellgen serve: on a miss, every table of a cell or tile from the OSM cell files (local.rs: the level-6 files its
   load box touches, data/osm/cells/, or fetched from CELLGEN_OSM_S3 into data/osm/s3/), and the elevation data
     osm.rs     the files' ways and tagged nodes into columns (tags into one string table)
     extract.rs roads, buildings, water, airports, points of interest (columns)
   ─▶ data/rust-cells/<token>/*.arrow (cached)
```

The cell files come from a planet (or extract) .pbf, split by the SedonaDB pipeline (docker/splitter). There is no
database: the PostGIS import and the TS cell server were removed on 2026-11-26.

By hand: `cellgen fetch <token | lat,lon>` downloads an area from Overpass (cached in data/osm/s2/) and parses it;
`cellgen extract …` prints what it holds (`--local`: from the cell files). `cellgen cell <token>…` builds cells into
data/rust-cells/.

Measured (Nov 2026, Overpass): a downtown download area is 7–22 MB of raw OSM and takes 20–45 s from overpass-api.de
(downtown Seattle: 43 s); parsing it takes 20–55 ms, extracting 2–13 ms.

### Regional extracts (later)

`cellgen region <lat,lon> [--download]` finds the deepest Geofabrik region holding a point (from their index, downloaded once) and downloads its `.osm.pbf` once into `data/osm/pbf/` (Washington state: 366 MB in 135 s). Too slow to fetch on a teleport; not wired into the server. A local planet (or continent), preprocessed into areas, is the way to make any place load at once.

## Target (later)

```
cell files ─▶ cellgen (one Rust Lambda, docs/serverless-plan.md): as now, plus an R-tree per cell and LOD levels
        ─▶ Arrow files per table per cell on S3, immutable, keyed by content hash
        ─▶ GET /cells/{token}/{hash}/{table}.arrow   (Cache-Control: immutable, brotli)
        ─▶ client getBlob() → typed-array views
```

For whole regions, Geofabrik extracts via osm2pgsql (or our converter reading `.pbf`) replace Overpass snapshots. The tables and everything downstream stay the same.

## Import (cellgen: extract.rs, import.rs)

- Select drivable ways: `highway` in motorway…residential, living_street, service, road, and their `_link` variants; not `area=yes`.
- Resolve one-way (explicit tags, implied for motorways and roundabouts), lanes per direction, speed limit (tag or US default by class). Geometry and node order are stored in the direction of travel for one-way roads.
- Upsert into `road_ways` by `osm_way_id`. Then delete road ways that have a node inside the fetched box but were not in this fetch (deleted upstream, or no longer a road).
- Record the fetch in `osm_fetches` (keyed by file sha256, so re-importing the same file is idempotent).
- Sidewalk sides and bridges or tunnels aren't stored: they're resolved from each way's stored tags when it's loaded.

### Buildings

- Sources: closed ways and multipolygon relations tagged `building=*` or `building:part=*` (not `no`). Relation member ways are joined into rings by matching endpoints; inner rings are attached to the outer ring containing them. Building nodes (4 in 80205) are ignored.
- Height: `height=*` (meters, feet or feet'inches"), else `building:levels` × 3 m, else a default by kind (house 6 m, garage 3 m, apartments 12 m, …). `min_height` or `building:min_level` × 3 m lifts the bottom. The source is stored (`height_source`) so estimated heights stay visible.
- Keyed by `(osm_type, osm_id)` (ways and relations have separate id spaces); geometry is always a MultiPolygon.
- 80205: 16,694 buildings + 379 parts, none skipped; heights from `height` 6,716 (Denver's lidar import), levels 1,683, default 8,674. Tallest: 213 m.

### Points of interest

- Nodes, closed ways and multipolygons tagged `shop`, `amenity`, `office`, `tourism`, `craft`, `leisure` or `healthcare` with a `name` or `brand`; an area at its outer ring's centroid. Stored in `pois` (category: the key; kind: its value) with all their tags, keyed like buildings. Downtown Seattle's area: 2,425.

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
