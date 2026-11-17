# OSM pipeline

## Current (development)

```
zip code ─▶ Census ZCTA gazetteer (data/census/) ─▶ center point ─▶ square bbox
   │  npm run cli -- fetch-osm --zip 80205 --size 4     (once per area)
   ▼
Overpass API ─▶ data/osm/<zip>.json + <zip>.meta.json   (gitignored raw snapshot)
   │  npm run cli -- import-roads --zip 80205           (repeatable, no network)
   ▼
@game/osm-import (pure TS): raw OSM → drivable ways with resolved attributes
   │  @game/db: one transaction
   ▼
PostGIS: osm_fetches, road_ways (upsert by OSM id; delete ways gone from the box)
```

## Target (later)

```
PostGIS ─▶ export (TS, Node): select partition + neighbors, split ways at
           intersections, build graph, project to local meters, build R-tree
        ─▶ partition blobs: columnar, immutable, keyed by content hash
        ─▶ GET /p/{partition}/{hash}   (Cache-Control: immutable)
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

All OSM interpretation lives in TS so the server, CLI and tests share it.

## Export (not built yet)

- Per partition: split ways at shared nodes (`extractRoads` in osm-import already does this and is tested), number nodes and edges densely, build CSR adjacency.
- Project lat/lon to local meters around the world origin.
- Write columns aligned to 8 bytes after a small header, so the client creates typed-array views with no parsing or copying. Alternative: Apache Arrow IPC (decide at implementation).
- Blob key = hash(data snapshot + export code version + partition id).

## Data quality

- Roads: good almost everywhere in the US.
- Buildings: detailed in most downtowns, sparse or missing in many suburbs and towns. Heights often missing.
- Rural areas: sparse but drivable.

## Licensing

OSM data is ODbL. The game must display "© OpenStreetMap contributors". Publicly distributed derived data (our blobs) may carry share-alike obligations; game code does not. Get a proper read before any public release.
