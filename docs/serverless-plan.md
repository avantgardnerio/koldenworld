# Serverless plan: kill the TS cell server and Postgres

Goal (2026-11-26): put a pin in the game and leave it running in the cloud until the bill isn't worth it, on infra
that only runs when someone plays. End state: **browser → CloudFront → S3 (built cells); on a miss → one Rust
Lambda (arm64)** that builds the cell from S3 inputs, writes it to S3, and returns it. No database, no always-on
server. Optionally later the same Rust crate compiled to WASM runs in the browser's workers and the Lambda goes too.

## Where things stand

Done and committed:

- **Elevation everywhere:** FABDEM V1-2 (bare-earth Copernicus, 30 m, CC BY-NC-SA) plus the EGM2008 geoid, in both
  readers (`crates/cellgen/src/elevation.rs`, `packages/cli/src/elevation.ts`). All 19,011 tiles (319 GB) are in
  `s3://koldenworld-data-2/dem/fabdem-v1-2/tiles/`, geoid in `dem/geoid/`. Missing tiles are fetched on first use
  (`s3.rs`, `.none` marks the sea); no tile = sea level.
- **OSM cell files on S3:** the SedonaDB splitter (`../sedona-db`, branch `osm-pbf-reader`) writes
  `coarse=<level-6 token>/{ways,nodes}.parquet` straight to S3. Dense node-location array (`WayNodesExec`) instead
  of two 13 B-row sorts; memory reserved from the pool; KLL-sketched cuts for the final routing (`range_sketch.rs`,
  from Ballista); `SEDONA_SPILL_COMPRESSION`. Planet 261116 → `s3://koldenworld-data-2/osm/planet-261116/raw/`.
- **cellgen without Postgres** (steps 1a–1c): `local::load_box` reads any box's OSM from the level-6 files it
  touches; `from_extracted` for roads, water, airports, buildings reproduces each Postgres query exactly
  (`boxes.rs`: ST_Intersects, &&, ST_ForcePolygonCCW). `cellgen compare <token|lat,lon>` diffs the two;
  `cellgen cell … --postgres` builds the old way. The ground server (`cellgen serve`, port 5175) builds every cell
  from files: byte-identical output where OSM versions match, more complete near level-6 edges (the old area import
  missed ways there). Far tiles (level ≤ 7) draw terrain only for now. `CELLGEN_OSM_S3=s3://…/raw` reads the cell
  files from S3 into a mirror under `data/osm/s3/`.

What still needs Postgres: the **TS cell server** (`packages/cli/src/server.ts` + `cells.ts`, port 5174) and the
`/ensure` import in cellgen (`areas.rs`) it calls.

## Step 1d: port the TS cell server into cellgen

The TS server builds five tables per cell (level 13): `nodes`, `edges`, `buildings`, `terrain`, `pois`
(`CELL_TABLES` in `packages/world/src/cell.ts`), served as `/cells/<token>/<table>.arrow` or all at once as
`/cells/<token>.cell` (`packCellFiles`: per table in order, a little-endian u32 length, then the bytes). Cached in
`data/export/cells/<token>/` with a `manifest.json` of `CELL_VERSION`, `ROAD_GRAPH_VERSION`, `BUILDINGS_VERSION`.

Per cell (`CellService.build` in `packages/cli/src/cells.ts`):

1. Inputs from Postgres (`packages/db`): `loadRoadWays(box)`, `loadBuildings(box)`, `loadPois(box)`, then
   `loadWater(region)` for carving. `box = cellBox(cell, MARGIN_M)`.
2. `buildCell(cell, ways, buildings, pois)` (`cell.ts`): `buildRoadGraph` (`road-graph.ts`), `buildBuildings`
   (`buildings.ts`), `buildPois` (`pois.ts`, `businesses.ts`), doors (`doors.ts`).
3. `region = cellsBox(contentBox(flat, 100), level)`: elevation and water over the whole neighbor cells objects reach
   into; `groundSampler(dem, level, carveWater(water.areas))`; `drapeCell` (`terrain.ts`).
4. `cellToArrow`: `road-graph-arrow.ts`, `buildings-arrow.ts`, `terrain.ts`, `pois.ts`.

About 1,900 lines of `packages/world` plus ~700 in `packages/cli`. cellgen already has its own road graph, terrain
and draping for the ground; reuse where the semantics match, but **the output must match the TS bytes**.

How to do it, one table at a time, the way 1a–1c went:

- **Inputs first.** Rust equivalents of the four TS loaders from `local::load_box` + `extract` (the TS loaders' SQL
  is in `packages/db/src/export.ts` and `water.ts`). Watch the roads query: it returns the roads intersecting the
  box **plus every road sharing a node with them**, wherever they are, so the graph connects across the cell edge.
  From files: load the box, then load again over the found roads' bounds and keep roads sharing a node. Buildings
  (`loadBuildings`) intersect the box (ST_Intersects, not &&), include `building:part`s, and **drop an outline
  that any part overlaps** (the parts replace it); they carry kind, min height, height source, levels,
  `building:min_level` and `roof:shape`, which the coarse loader doesn't. POIs: `geom && box`, by
  `(osm_type, osm_id)`. Check each against Postgres
  with `cellgen compare`, on cells whose areas were imported from the same OSM version (Colorado Springs areas
  came from `s3://koldenworld-data-2/osm/test/colorado-box`; many Denver areas from the Colorado extract too).
- **Then each table**, in this order (simplest first): `terrain`, `buildings`, `pois` (it points at `buildings`
  rows), `nodes`/`edges`. For each,
  build the cell in TS and Rust and `cmp` the `.arrow` bytes; where floats differ only by evaluation order, compare
  decoded columns with a tolerance and say so.
- **Then serve them** from `cellgen serve` at the same paths and `.cell` blob, point the viewer's `CELL_SERVER`
  (`packages/viewer/vite.config.ts`) at 5175, and delete `packages/cli/src/{server,cells,cell-pool,cell-worker,
  elevation}.ts`, `packages/db`'s loaders, `areas.rs`/`/ensure`/`import.rs`, and the Postgres dependency. Also the
  Postgres code kept only for checking: every `load` in cellgen that queries Postgres (`ways::load_road_ways`,
  `water::load_water`, `aeroways::load`, `buildings::load`, `pois::load`, marked TEMPORARY where new),
  `cellgen compare`, `cell … --postgres` and `Inputs::load`.
- **Done in 1d:** `terrain` (served by `cellgen serve`, from the drawn ground's lattice; no 1 m water carve); the POI
  input from the files (`pois.rs`, `charity_weight`). The `pois` table waits for `buildings`: each row is its
  building's row in that table.
- **Keep in TS:** everything the browser runs. The viewer generates the near building meshes itself
  (`solid-layer.ts` → building meshes, interiors, furniture); per the fine-buildings rule those stay TS. The viewer
  only imports geodesy, frames, people placement, walls, sign and class constants from `@game/world`.

## Step 2: hosting

- One Rust Lambda (arm64) behind CloudFront; S3 holds built cells (`cells/<data version>/<token>/…`, immutable),
  the viewer's static files, and the inputs. CloudFront serves hits from S3 and sends misses to the Lambda (or the
  Lambda writes to S3 and redirects; synchronous Lambda responses are capped at a few MB unless streamed).
- Replace the AWS CLI calls (`s3.rs`, `packages/cli/src/elevation.ts`) with `object_store`/the SDK and range reads
  (Parquet row-group pruning by the bbox statistics, COG blocks); `/tmp` as a per-instance cache.
- Idle cost ≈ S3 storage: ~$7/month FABDEM + ~$7 planet cells. A cell build ≈ 1 s at 2 GB ≈ $0.00003.
- Not Lambda: the NPC dialogue model (GPU, on-demand instance), the planet splitter (EC2 batch).

## Step 3 (optional): WASM

The same crate to `wasm32` in Web Workers, reading S3/CloudFront directly (public read; OSM ODbL and FABDEM
CC BY-NC-SA allow it with attribution). Needs the server-only crates behind a feature and a wasm-friendly Parquet
codec. No shared cache: every player builds what they visit.

## Backlog

- **Far-tile water:** the splitter writes a small water-only file per level-6 cell (waterways ≥ 15 m, water areas)
  so far tiles get rivers and lakes back cheaply. Fold into the next planet run.
- **Next planet run** (on the big box): rebuild sedona-db there first (it has the source in `/data/sedona-db`, build
  with `--no-default-features --features aws,gcp,azure,http`), `SEDONA_MEMORY_LIMIT_GB=200`,
  `SEDONA_SPILL_COMPRESSION=lz4_frame`; sketched cuts are on by default. Run script `/data/run-planet.sh`.
- **Relations** (multipolygon lakes, buildings) aren't in the cell files; deliberately deferred (only Lake Dylan
  looked missing).
- **Row-group pruning** in `local.rs` (it reads whole level-6 files; the largest is 2 GB, `coarse=47c7`).
- A way node's tags are looked up only in its own level-6 cell's `nodes.parquet`.

## Infrastructure as of 2026-11-26

- Big box: on-demand r7gd.8xlarge `i-084a4e23a28d94b89` (us-east-2, $2.18/h, 18.188.171.88, instance store wiped on
  stop), tmux `work` (windows `planet`, `fabdem`, `finish`). Terminate when the planet run is verified.
- Bucket `koldenworld-data-2` (us-east-2). AWS SSO profile `koldenworld`; set `AWS_REGION=us-east-2`.
