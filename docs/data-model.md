# Data model

## Three places, two physical formats

The logical schema (tables, column names, meanings) is shared. The physical layout differs where the needs differ. See decisions 10–12 in [decisions.md](decisions.md).

| | Postgres | Network / cache | Memory |
|---|---|---|---|
| Role | source of truth, analysis, partition selection | transport and cache | the game |
| Layout | rows | columnar blob per partition | the same blob, read through typed-array views |
| Geometry | PostGIS `geometry`, lat/lon (SRID 4326) | ragged `Float32Array` points, local meters | same |
| IDs | OSM ids (`bigint`) | dense `u32` indices within a partition | same |
| Content | everything: raw tags, provenance, unused rows | game columns only, strings as string tables | same |
| Spatial index | GiST | Flatbush R-tree built at export, shipped in the blob | same |

The Postgres → blob export is the single conversion point. It is a pure function of the selected rows (plus neighbors), so it is tested like the operators.

## Postgres tables

- `osm_fetches`: one row per downloaded snapshot (area key, bbox, OSM base timestamp, sha256). Identity key, since we create these.
- `road_ways`: one row per drivable OSM way, keyed by `osm_way_id`, stored **unsplit**: node id list, geometry in direction of travel, resolved attributes (class, one-way, lanes, speed limit), raw tags, and the fetch that last wrote it.

Splitting ways into segments at intersections and building the road graph happen at export time, not in Postgres. Where a way gets split depends on which other ways meet it, and only the export sees a partition together with its neighbors.

## Coordinates

- Local flat coordinates in meters: x east, y north, z up. Each world has an origin (lat/lon) and a projection.
- `f32` positions are precise enough within roughly 10 km of the origin. Larger worlds need origin rebasing (open question, see [roadmap.md](roadmap.md)).
- Lat/lon only exists at the import boundary.

## IDs

- **Postgres:** OSM-derived rows are keyed by OSM ids, so imports upsert and overlapping downloads merge. Rows we create get `bigint` identity ids; anything that may be created outside the server (saves, player content, offline data) gets UUIDv7.
- **OSM id stability:** stable within a snapshot only. Long-lived references should use a position plus a snapshot version.
- **Client:** rows are addressed by dense `u32` indices into columns. No object references.
- TypeScript branded types keep index kinds apart:
  ```ts
  type EdgeId = number & { readonly __brand: "EdgeId" };
  ```
- The original `osm_id` is kept as a column for debugging and for joining back to source data.
- Open question: stable cross-partition IDs once partitions stream in and out (likely `partition id + local index`).

## Columnar tables

Each table is a set of typed-array columns with a row count. Variable-length data (polylines, footprints) uses ragged arrays: a shared point buffer plus per-row offset and count columns.

```ts
class RoadEdges {
  count = 0;
  from       = new Uint32Array(cap);   // NodeId
  to         = new Uint32Array(cap);   // NodeId
  class_     = new Uint8Array(cap);    // RoadClass enum
  lanesFwd   = new Uint8Array(cap);
  lanesBack  = new Uint8Array(cap);    // 0 = one-way
  width      = new Float32Array(cap);
  speedLimit = new Float32Array(cap);  // m/s
  length     = new Float32Array(cap);  // m, precomputed
  ptStart    = new Uint32Array(cap);   // into points
  ptCount    = new Uint16Array(cap);
  osmId      = new Float64Array(cap);  // OSM ids exceed 2^32
}
// shared: points = Float32Array of interleaved x, y
```

The schema should be declared once and drive the TS table classes, the blob writer and the blob reader.

### Static map tables

| Table | Key columns |
|---|---|
| `RoadNode` | position, first edge / edge count (adjacency), is-signalized |
| `RoadEdge` | from, to, polyline, class, lanes per direction, width, speed limit, length |
| `Building` | footprint (ragged), height, min height, kind, height-was-estimated flag |
| `Area` | polygon (ragged), kind (park, water, parking, ...) |
| `EdgeFeature` | linear-referenced features on edges (below) |

Adjacency is stored CSR-style: an `Int32Array` of `count + 1` offsets into a flat list (Int32 to match Arrow list offsets, so files and memory share bytes). The implemented road graph is `RoadGraph` in `packages/world/src/road-graph.ts`; its Arrow layout is documented in `road-graph-arrow.ts`.

## Linear referencing

Things that belong to a road are stored relative to it, the same way doors were stored along walls in the earlier CAD system:

| Feature | Representation |
|---|---|
| Crosswalk, bus stop, parking zone | edge + start and end distance (m) + side |
| Driveway, storefront entrance | edge + distance + side |
| A car on the road network | edge + distance along it + lane |

World x/y for these is derived when needed (rendering, collision), never stored as the source of truth.

## Dynamic entity tables

Fixed-capacity pools with a free list and a flags column. Example:

```ts
class Cars {
  count = 0;
  flags   = new Uint8Array(MAX_CARS);    // alive, player, braking, off-graph...
  edge    = new Uint32Array(MAX_CARS);   // when on the graph
  t       = new Float32Array(MAX_CARS);  // distance along edge, m
  lane    = new Uint8Array(MAX_CARS);
  x       = new Float32Array(MAX_CARS);  // world position (derived or free)
  y       = new Float32Array(MAX_CARS);
  heading = new Float32Array(MAX_CARS);
  speed   = new Float32Array(MAX_CARS);
  prevX   = new Float32Array(MAX_CARS);  // for render interpolation
  prevY   = new Float32Array(MAX_CARS);
}
```

AI traffic lives on the graph (`edge`, `t`, `lane`). The player's car, and any car knocked off the road, uses free `x`, `y`, `heading` physics. See [simulation.md](simulation.md).
