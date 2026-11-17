# OSM pipeline

```
Geofabrik extract (.pbf: Colorado, the US, ...)
   │  osm2pgsql, flex output (Lua config defines our tables)
   ▼
PostGIS: raw roads / buildings / areas tables with GiST indexes
   │  osm-import (shared TS, running in Node in the server package)
   ▼
partition blobs: typed-array columns, immutable, keyed by content hash
   │  GET /p/{partition}/{hash}   (cacheable forever)
   ▼
client cache: IndexedDB (browser) or files (Node) → typed-array views
```

## Choosing an area

1. **Zip code → point.** Bundle the US Census ZCTA Gazetteer file (zip centroids, public domain, about 33k rows). No API needed. For addresses or other countries, Nominatim (light use only, per its usage policy).
2. **Point → area.** A fixed square around the centroid (start with 2×2 km). Zip boundaries are not used: rural zips can cover hundreds of km².
3. **Area → partitions.** The client requests the partitions that cover the area, then more as the player moves.

## Responsibilities

**PostGIS / osm2pgsql:** storage, tag filtering into our tables, spatial selection by bounding box.

**osm-import (TS):**
- Split ways at intersections and build the road graph (nodes, edges, CSR adjacency).
- Resolve one-way, lanes, widths, speed limits, with defaults by road class.
- Building heights from `height`, then `building:levels`, then a default by building type. Record when a height was estimated.
- Project lat/lon to local meters.
- Assign rows to partitions and write blobs.
- Later: procedural filler buildings along roads where OSM has none.

All logic stays in TS so the server, the CLI and tests share one implementation.

## Blob format

- A small header (JSON or fixed binary) listing tables, columns, types, row counts and byte offsets.
- Columns aligned to 8 bytes, so the client creates typed-array views directly on the downloaded buffer: no parsing, no copying.
- Alternative: Apache Arrow IPC. Standard, inspectable with DuckDB / pyarrow, but heavier. Decide at implementation time (see [roadmap.md](roadmap.md)).

## Versioning and caching

- Blob key = hash(OSM snapshot date + osm-import version + partition id).
- Blobs are immutable. Changing the data snapshot or the import code produces new keys and invalidates exactly what changed.
- The server generates a blob on first request, writes it to object storage, and serves it from a CDN after that.

## Operations

- **Local dev:** PostGIS in Docker with a single-state extract (Colorado is a few hundred MB, imports in minutes).
- **Scale (rough):** the US in osm2pgsql is ~100+ GB with indexes; the planet ~1 TB.
- **Freshness:** a monthly reimport is fine for a game. Minutely/daily replication diffs are available if ever needed.

## Alternatives kept in reserve

- **Overpass API:** acceptable for quick experiments; not a production source.
- **Planetiler → PMTiles (custom schema):** static file on a CDN, no database. Must keep topology and tags; stock display tiles do not.
- **DuckDB spatial:** reads `.pbf` directly, embedded in Node, good for batch "extract → all blobs → upload" jobs.

## Data quality

- Roads: good almost everywhere in the US.
- Buildings: detailed in most downtowns, sparse or missing in many suburbs and towns. Heights often missing.
- Rural areas: sparse but drivable.

## Licensing

OSM data is ODbL. The game must display "© OpenStreetMap contributors". Publicly distributed derived data (our blobs) may carry share-alike obligations; game code does not. Get a proper read before any public release.
