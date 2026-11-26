# Serverless plan: kill the TS cell server and Postgres

Goal (2026-11-26): put a pin in the game and leave it running in the cloud until the bill isn't worth it, on infra
that only runs when someone plays. End state: **browser → CloudFront → S3 (built cells); on a miss → one Rust
Lambda (arm64)** that builds the cell from S3 inputs, writes it to S3, and returns it. No database, no always-on
server. Optionally later the same Rust crate compiled to WASM runs in the browser's workers and the Lambda goes too.

## Where things stand

Done and committed:

- **Elevation everywhere:** FABDEM V1-2 (bare-earth Copernicus, 30 m, CC BY-NC-SA) plus the EGM2008 geoid
  (`crates/cellgen/src/elevation.rs`). All 19,011 tiles (319 GB) are in
  `s3://koldenworld-data-2/dem/fabdem-v1-2/tiles/`, geoid in `dem/geoid/`. Missing tiles are fetched on first use
  (`s3.rs`, `.none` marks the sea); no tile = sea level.
- **OSM cell files on S3:** the SedonaDB splitter (`../sedona-db`, branch `osm-pbf-reader`) writes
  `coarse=<level-6 token>/{ways,nodes}.parquet` straight to S3. Dense node-location array (`WayNodesExec`) instead
  of two 13 B-row sorts; memory reserved from the pool; KLL-sketched cuts for the final routing (`range_sketch.rs`,
  from Ballista); `SEDONA_SPILL_COMPRESSION`. Planet 261116 → `s3://koldenworld-data-2/osm/planet-261116/raw/`.
- **cellgen without Postgres** (steps 1a–1c): `local::load_box` reads any box's OSM from the level-6 files it
  touches; `from_extracted` for roads, water, airports, buildings reproduces each Postgres query exactly
  (`boxes.rs`: ST_Intersects, &&, ST_ForcePolygonCCW). The ground server (`cellgen serve`, port 5175) builds every cell
  from files: byte-identical output where OSM versions match, more complete near level-6 edges (the old area import
  missed ways there). Far tiles (level ≤ 7) draw terrain only for now. `CELLGEN_OSM_S3=s3://…/raw` reads the cell
  files from S3 into a mirror under `data/osm/s3/`.

- **Step 1d done (2026-11-26):** every fine cell table (`terrain`, `buildings`, `pois`, `nodes`, `edges`) and
  `/aircraft` come from `cellgen serve`, from the cell files; the viewer talks to nothing else. The TS cell server,
  the PostGIS import (`areas.rs`, `import.rs`, `/ensure`), every Postgres loader, `cellgen compare` and the TS
  migrations (`packages/db`, `packages/cli`) are deleted, and the OSM tables dropped. Postgres keeps only the empty
  `game` database and its roles (`db/bootstrap.sql`), for auth later, with migrations in Rust.
- **Still in TS, unused by the viewer:** `packages/world`'s cell building (`buildCell`, `drapeCell`,
  `groundSampler`, `carveWater`, `buildRoadGraph`, `buildBuildings`, `buildPois`, the `*ToArrow` writers), kept for
  its tests and the e2e test's fixture cell. Delete or keep later.

## Step 1d (done): port the TS cell server into cellgen

What follows is how it was done, kept for reference.

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
- **`nodes`/`edges` (decided 2026-11-26):** the topology exactly as the TS (checked field by field). The heights
  deliberately differ: every node and point at the drawn ground (`cell::Ground`), with a point added wherever the
  centreline crosses a lattice row, column or diagonal. Bridges and tunnels stay on the ground too, as the ground
  draws them; `drop` is 0 (no road meshes read it); `ROAD_GRAPH_VERSION` 5. No OSM `ele`/`layer`.
- **Then serve them** from `cellgen serve` at the same paths and `.cell` blob, point the viewer's `CELL_SERVER`
  (`packages/viewer/vite.config.ts`) at 5175, and delete `packages/cli/src/{server,cells,cell-pool,cell-worker,
  elevation}.ts`, `packages/db`'s loaders, `areas.rs`/`/ensure`/`import.rs`, and the Postgres dependency. Also the
  Postgres code kept only for checking: every `load` in cellgen that queries Postgres (`ways::load_road_ways`,
  `ways::load_road_ways_touching`, `water::load_water`, `aeroways::load`, `buildings::load`, `pois::load`,
  `building_inputs::load`, marked TEMPORARY
  where new),
  `cellgen compare`, `cell … --postgres` and `Inputs::load`.
- **Done in 1d:** `terrain` (served by `cellgen serve`, from the drawn ground's lattice; no 1 m water carve); the POI
  input from the files (`pois.rs`, `charity_weight`). The `pois` table waits for `buildings`: each row is its
  building's row in that table. The fine buildings input from the files (`building_inputs.rs`: parts replace the
  outline holding their point on surface, a port of GEOS's InteriorPointArea; loaded over `reach` so parts past the
  box are found). Postgres's coordinates came through ST_AsGeoJSON (9 decimals); the files' are full precision.
  The `buildings` table (`building_table.rs`, draped by `cell::Ground` on the drawn ground's lattices), served by
  `cellgen serve`; identical to the TS rows where the inputs match. The viewer takes terrain and buildings from
  `/ground/…` and the rest from the TS server, with no points of interest until `pois` is ported (the TS rows point
  at the TS server's buildings).
- **Keep in TS:** everything the browser runs. The viewer generates the near building meshes itself
  (`solid-layer.ts` → building meshes, interiors, furniture); per the fine-buildings rule those stay TS. The viewer
  only imports geodesy, frames, people placement, walls, sign and class constants from `@game/world`.

## Step 2: hosting, as one container (decided 2026-11-26)

One Docker image, run the same way locally and on Lambda, the only thing to deploy:

- **`cellgen serve` does everything:** the viewer's static release build (`vite build`) at `/`, cells at
  `/ground/<token>/<table>.arrow`, live air traffic at `/aircraft`. Vite's dev server stays for development only.
- **The bucket stays private:** only the container's credentials reach S3 (locally your `koldenworld` SSO profile,
  `~/.aws` mounted read-only; on Lambda the function's role). No anonymous or CloudFront-direct access to the data.
- **S3 through the AWS SDK only** (`aws-sdk-s3`), locally too: never the `aws` CLI. The client uses the bucket's
  region (us-east-2) whatever the profile says. **Done:** `s3.rs` (FABDEM tiles, cell files).
- **S3-centric, no local disk** (Lambda's `/tmp` is per instance, small and wiped on recycle; the level-6 cell
  files are 0.5–2 GB): dev runs the same path as Lambda.
  - **Built cells in S3**, shared by every instance and player: `cells/<version>/<token>/<table>.arrow`, the version
    from the table versions, so a format change never serves stale cells. On a request: S3, else build (inputs from
    S3), write to S3, answer. **Done:** `cells/<data>/g<ground>-r<road graph>-b<buildings>/<token>/` (`<data>`:
    `local`, or the CELLGEN_OSM_S3 snapshot's name, e.g. `planet-261116`); the server keeps nothing on disk.
  - **FABDEM by range reads:** tiles are 256×256 deflate blocks; a cell needs 1–4 blocks (~100–250 KB) and the
    header, not the 23 MB tile. **Done:** `s3::open`, a Read + Seek fetching 256 KB pages into a process-wide cache
    (CELLGEN_PAGE_CACHE_MB, 256), for the FABDEM tiles and the geoid (`dem/geoid/`, no longer on disk). A first
    Denver cell: 9 requests, 2.4 MB; the next in the same tile: 1 request; output byte-identical.
  - **Cell files by range reads:** an async Parquet reader over S3, footer first, row groups pruned by their
    statistics, only the columns needed. Nodes are sorted by S2 cell (tight row groups); ways' row groups span
    nearly the whole level-6 area in bbox (876d: 727 row groups), so measure first and fix the sort in the splitter
    if need be. **Done:** measured, the ways prune fine too (one wide row group was the outlier): a cell's box keeps
    19 of 727 way row groups (12 of 506 MB) and 14 of 328 node row groups. `local.rs` reads only S3 (default the
    planet, `osm/planet-261116/raw`): footers once per file (kept), row groups by their stats, one range request each,
    side by side, kept in a row-group cache (CELLGEN_ROW_GROUP_CACHE_MB, 512; a build loads its box, then its reach).
    Output byte-identical to the disk build. A first Denver cell: 17 MB; a neighbor: 13 MB more. From home a cold
    cell takes ~10 s, the next ~1.4 s (release). The server reads and writes nothing on disk (`s3::local_copy` is
    gone); only the dev tools (`cellgen fetch`/`region`, Overpass and Geofabrik caches) and `cellgen cell`'s output
    use `data/`, and `data/dem`, `data/osm/cells` are no longer read.
- **Remotely: Lambda first** (arm64, container image, AWS Lambda Web Adapter so the axum server runs unchanged;
  a function URL). Scales to zero: idle cost ≈ S3 storage (~$7/month FABDEM + ~$7 planet cells); a cell build
  ≈ 1 s at 2 GB ≈ $0.00003. Responses under Lambda's 6 MB buffered cap (the largest table, fine ground, is ~1 MB).
  Cold instances download their FABDEM tile and level-6 files first: a few seconds for a new area.
- Not in the container: the NPC dialogue model (GPU, on-demand instance), the planet splitter (EC2 batch).

Order: SDK (done) → built cells in S3 → FABDEM range reads → Parquet range reads → `--static` + Dockerfile, run
locally → Lambda.

## Step 3 (only if needed): WASM

Only if the browser ever needs Rust code that's in cellgen (sharing it with the TS rather than porting it): the
crate's pure parts to `wasm32`. Not a way to read the data from the browser: the bucket stays private.

## Backlog

- **Flat roads** (after 1d): the ground generator keeps every road level across its centreline, at the centreline's
  FABDEM height (as the road graph has it from 1d on), and moves the terrain at the road's edges to meet it. The
  drawn road, the graph and cars at any lane then agree. Later still, **overpasses**: bridge decks raised by OSM
  `bridge`/`layer` (read from the cell files' tags then), drawn as decks instead of painted on the ground.

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
