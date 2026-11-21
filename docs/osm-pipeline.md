# OSM pipeline

## Current (development)

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

Then the export (one area = one partition for now):

```
   │  npm run cli -- export --zip 80205
   ▼
PostGIS road_ways in the fetch bbox ─▶ @game/world buildRoadGraph ─▶ Arrow IPC
PostGIS buildings in the fetch bbox  ─▶ @game/world buildBuildings ─▶ Arrow IPC
   ─▶ data/export/<zip>/nodes.arrow, edges.arrow, buildings.arrow, manifest.json (sha256 per file)
```

## Target (later)

```
PostGIS ─▶ export (TS, Node): select partition + neighbors, cut ways at
           intersections, build graph, project to local meters, build R-tree
        ─▶ Arrow files per table per partition, immutable, keyed by content hash
        ─▶ GET /p/{partition}/{hash}/{table}.arrow   (Cache-Control: immutable, brotli)
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

Built (`@game/world` + `cli export`):
- Cut ways into edges at nodes shared with another way (OSM intersections are shared node ids, not geometric crossings, so bridges stay unconnected). Nodes and edges are numbered densely in `osm_way_id` order, so output is reproducible.
- Project lat/lon to local meters around the area's bbox center (equirectangular on a sphere; good to about 0.25% here). To be replaced by per-partition ENU frames on WGS84 (decision 20).
- Build CSR incidence lists (each node's incident edges).
- Write Arrow IPC files (decision 15) and check the round trip before writing.

Buildings (`buildBuildings`): one row per polygon; rings opened (no repeated closing point) and oriented (outer counterclockwise, holes clockwise). An outline is left out when a `building:part` lies inside it (`ST_PointOnSurface` of the part), since the parts describe its shape; parts are always kept. 80205: 17,011 buildings and parts → 17,014 polygons, 130,696 points; `buildings.arrow` 1.5 MB raw, 757 KB brotli.

80205 result: 3,775 ways → 5,598 nodes, 7,684 edges, 24,758 points. 98% of nodes are in one connected component; the remaining 13 components are mostly tiny pieces cut off at the bbox edge. Counts match an independent SQL computation.

Not built yet:
- Partitions: one fetch area is one partition today. Neighbor padding, so intersections at partition edges are seen.
- Merging degree-2 nodes where one way simply continues into the next (897 such nodes in 80205).
- Content-hash keys: hash(data snapshot + graph version + partition id).
- R-tree in the export.

## Data quality

- Roads: good almost everywhere in the US.
- Buildings: detailed in most downtowns, sparse or missing in many suburbs and towns. Heights often missing.
- Rural areas: sparse but drivable.

## Licensing

OSM data is ODbL. The game must display "© OpenStreetMap contributors". Publicly distributed derived data (our blobs) may carry share-alike obligations; game code does not. Get a proper read before any public release.
