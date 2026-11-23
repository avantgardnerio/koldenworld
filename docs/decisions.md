# Decisions

A running log. Newest last. Each entry: what we chose, what we didn't, and why.

## 1. TypeScript with columnar typed arrays, not Rust

- **Chosen:** TypeScript everywhere. Hot state in typed arrays, struct-of-arrays layout, allocation-free hot loops.
- **Rejected for now:** a Rust core (native or WASM).
- **Why:** one language across browser, Node, CLI and server; no WASM boundary; fast iteration; prior experience with fast columnar WebGL/JS. Node and Chrome share V8, so headless runs match the browser bit for bit.
- **Escape hatch:** because state is flat buffers, a hot loop can move to Rust/WASM later with typed-array views over WASM memory. Profile first.

## 2. Redux-style model, but mutable in place

- **Chosen:** `step(world, inputs, dt)` mutates the world. Inputs are discriminated unions. State is always fully serializable.
- **Rejected:** a new immutable state object every tick.
- **Why:** copying hundreds of entities at 60 Hz is wasteful. The guarantees that matter (serializable, replayable, snapshot at any tick) hold without immutability.

## 3. Hand-written arcade vehicle physics

- **Rejected:** a third-party physics engine.
- **Why:** engines keep internal state outside our tables, which breaks snapshots, replays and determinism. Arcade handling also suits the genre better.

## 4. PostGIS as the source of map data (loading path amended by 13)

- **Chosen:** Geofabrik extracts → osm2pgsql (flex output, our own schema) → PostGIS, with blobs generated from it.
- **Rejected as long-term source:** the public Overpass API (fair-use limits, volunteer-run), off-the-shelf vector tiles (simplified geometry, lost topology and tags).
- **Considered:** Planetiler → PMTiles with a custom schema (static, no server); DuckDB spatial as a serverless batch pipeline. Either can replace PostGIS later without changing the blob format or client.

## 5. Logic in TypeScript, storage in SQL

- **Chosen:** PostGIS handles storage and spatial selection. Graph building, height inference and all other import logic live in the shared TS `osm-import` package.
- **Why:** one implementation runs on the server, in the CLI and in tests.

## 6. R-trees for indexing, partitions as a separate concept

- **Chosen:** static packed R-trees (Flatbush) for queries. Partitions (the unit of regeneration, caching and streaming) are a separate decision. See [spatial.md](spatial.md).
- **Rejected:** fixed-size tiles. OSM density varies too much between downtown and rural areas.

## 7. Operator dependency graph derived from declarations

- **Chosen:** each operator declares what it reads and produces; the graph is built from that, with cycle and missing-input checks at startup.
- **Rejected:** a hard-coded graph (what the earlier CAD system did). It works but makes adding operators touch central wiring.

## 8. JSON-lines over stdin/stdout for headless control

- **Rejected:** gRPC.
- **Why:** no codegen, trivially scriptable, enough for one process talking to one client. Revisit only if a real need appears.

## 9. Local markdown docs

- Design docs live in `docs/` in the repo so they stay next to the code and under version control.

## 10. Same logical schema everywhere, two physical formats

- **Chosen:** tables, column names and meanings are shared between Postgres and the client. Physically, Postgres stores rows (lat/lon geometry, OSM ids, raw tags); the network, any cache and memory all use the same columnar blob per partition (local-meter `f32` geometry, dense `u32` indices, string tables, only game columns).
- **Rejected:** a byte-for-byte identical schema in Postgres, IndexedDB and memory; and pivoting to rows for IndexedDB.
- **Why:** geometry, coordinates, ID representation and column sets genuinely differ between the source of truth and the game. IndexedDB is slow with many tiny records but stores `ArrayBuffer`s efficiently, so a cached blob is identical to the in-memory form: paging in is "read buffer, create views". The Postgres → blob export is the one conversion point.
- **Keeping in sync:** the client schema is declared once in TS; a test compares shared columns against Postgres `information_schema`.

## 11. No IndexedDB for now

- **Chosen:** blobs are loaded through a `getBlob(key) → ArrayBuffer` interface backed by `fetch`. Immutable blob URLs with `Cache-Control: immutable` let the browser HTTP cache avoid re-downloads.
- **Deferred:** an IndexedDB layer behind the same interface, when we need offline play, caching of client-derived artifacts (meshes), or more cached data than the HTTP cache keeps.
- **Why:** a 2 km area is a few MB; even Denver's roads and buildings are tens of MB. Memory is not a constraint yet.

## 12. Keys: OSM ids for OSM data, generated ids only for our own things

- **Chosen:** OSM-derived tables are keyed by OSM ids (e.g. `road_ways.osm_way_id`). Ways are stored unsplit; imports upsert. Splitting into segments and graph building happen at blob export, which reads a partition plus its neighbors.
- **Rejected:** identity ids on imported rows, and storing pre-split segments keyed by area.
- **Why:** identity ids change on every reimport; per-area rows duplicate roads where areas overlap; and where a way gets split depends on which neighboring ways happened to be downloaded, so segments have no stable identity. OSM ids are globally unique (OSM is the single master) and make imports idempotent.
- **Caveat:** OSM ids are stable within a snapshot only; upstream edits split, merge and delete ways. A refresh upserts what is present and deletes ways that disappeared from the refreshed box. Long-lived references (missions, saves) should use position + snapshot version, not way ids.
- **Our own ids:** `bigint` identity for rows the server creates (fetches, partitions, jobs). UUIDv7 (`uuidv7()` is built into PostgreSQL 18) for anything that may be created outside the server, such as player saves or offline browser data.

## 13. One-time Overpass snapshots, converted by our own TS code

- **Chosen:** for development, raw OSM for a square around a zip code is downloaded once from Overpass into gitignored `data/osm/` (with a `.meta.json` recording bbox, query, OSM base timestamp and sha256). The TS converter reads that file and upserts into PostGIS directly.
- **Deferred:** osm2pgsql and Geofabrik extracts, until we import whole regions.
- **Why:** no repeated API traffic, no extra tooling, and all OSM interpretation stays in the shared, tested `osm-import` package.

## 14. Postgres setup

- **Chosen:** the existing local PostgreSQL 18 cluster (shared with koldenhome), no Docker. Roles: `game_migrations` owns the database and runs DDL; `game` is the runtime role with DML via default privileges. Both use `trust` on the local socket and loopback, scoped to the `game` database, so connection strings hold no secrets. One-time superuser steps are in `db/bootstrap.sql`.
- **Migrations:** plain SQL in `db/migrations/`, forward-only, applied in filename order, each in a transaction, recorded with a checksum. Editing an applied migration is an error. No ORM.

## 15. Apache Arrow IPC for exported map data

- **Chosen:** Arrow IPC files (the `apache-arrow` JS library, pure TypeScript, no WASM), one file per table per partition (`nodes.arrow`, `edges.arrow`), one record batch per file. Provenance goes in schema metadata. Served with HTTP `Content-Encoding` (brotli/gzip) on top.
- **Rejected:** JSON (5–10× larger, parse and allocation cost, lossy floats); a hand-rolled columnar blob (worked, but every inspection tool would be ours to write); Parquet (needs decoding, usually WASM in the browser).
- **Why:** reading is zero-copy (tests assert columns are views onto the file bytes), the format is a standard readable by pyarrow and others, and our layout maps directly: CSR offsets are Arrow `List` offsets, ragged points are `List<FixedSizeList<Float32, 2>>`, the class enum and street names are dictionary-encoded strings.
- **Details:** in-memory CSR offsets are `Int32Array` to match Arrow list offsets. OSM ids are stored as `float64` (exact below 2^53) to avoid `BigInt`. Dictionary ids are set explicitly so output is byte-for-byte reproducible.
- **Bitpacking:** deferred until measured. First candidate is quantizing coordinates to `Int16` relative to the partition, which WebGL can consume directly.
- **Measured (80205, 4×4 km):** nodes 171 KB raw / 81 KB brotli; edges 461 KB raw / 176 KB brotli.

## 16. Raw WebGL2 viewer, verified headless in Chromium

- **Chosen:** raw WebGL2 with a Vite dev server, built before the simulation so the pipeline is proven end to end (OSM → PostGIS → Arrow → browser → GPU). The project is primarily an efficient world renderer; the game goes on top.
- **Rejected:** Three.js (its scene graph and object-per-mesh model would wrap our columnar buffers in state we would have to sync); building the sim and text view first.
- **Viewer rules:** meshes come from pure operators in `@game/world` (tested in Node); GPU layers hold only handles; the camera is a plain value mirrored to the URL hash, so the same URL renders the same pixels; frames render on demand.
- **Headless verification:** Playwright drives headless Chromium with SwiftShader (software WebGL, no GPU, deterministic pixels). The viewer exposes `window.viewer` (status counts and a `pixel(x, y)` probe that renders and reads back), so tests assert exact colors at known world positions without decoding screenshots. `npm run shot` writes PNGs that Claude can look at.

## 17. Fly camera: quaternion state, yaw/pitch control

- **Chosen:** the camera stores a position and an orientation quaternion. Mouse look changes yaw (about world up) and pitch (about the camera's right axis, clamped to ±90°), and the quaternion is rebuilt from the new yaw and pitch each frame.
- **Rejected:** composing small rotations onto the quaternion every frame. It is the textbook approach, but float error leaks in as roll, which a pitch rotation cannot remove; in testing the camera tilted several degrees off the clamp after 50 frames of looking straight down. Also rejected: pitch from `asin`, which is ill-conditioned near ±90° (we use `atan2`).
- **Why quaternions at all:** with yaw/pitch only and a clamp there is no gimbal lock either way, but quaternions are what vehicles and free 6-DOF orientation need, and they compose and interpolate cleanly. The camera uses the same type the sim will.

## 18. Road surfaces from lanes and class profiles, painted flat

- **Chosen:** the road surface is an operator in `@game/world` (`roadSurfaceMesh`): width = lanes × lane width + shoulders, from a per-class profile; mitered ribbons per edge plus a disc per node (intersections and dead ends). Markings follow US conventions and only appear on tertiary roads and above. Everything is one triangle mesh with a material per vertex, emitted in draw order.
- **Rejected for now:** true intersection polygons (cutting each road back and joining the curb lines); per-lane geometry from `turn:lanes`; textures.
- **Why:** discs make every junction look solid with no topology work, and the mesh stays a pure function of the graph. Painter's order with no depth buffer avoids z-fighting between coplanar layers; buildings will need depth and a decal approach (polygon offset or a small z lift) for the ground layers.

## 19. Buildings: extruded footprints, parts replace outlines, depth only for solids

- **Chosen:** buildings go through the same pipeline as roads: pure TS extraction (ways and multipolygons, ring assembly, height resolution with a recorded source), a `buildings` table keyed by `(osm_type, osm_id)`, an Arrow table with one row per polygon and nested ring lists, and a pure mesh operator (walls + earcut roofs). When a building has `building:part`s inside it, the export keeps the parts and drops the outline.
- **Height policy:** `height` tag, else levels × 3 m, else a per-kind default; `height_source` records which, so estimated buildings can be treated differently later (procedural detail, a debug view).
- **Rendering:** ground layers keep painter's order but write depth; buildings are depth-tested and back-face culled. This avoids z-fighting between coplanar ground layers without needing polygon offset.
- **Rejected for now:** roof shapes (too rare in the data to justify the work), textures and windows, splitting `import` into separate road and building commands (one `import` reads the snapshot once).

## 20. Coordinates: the real globe, small local frames for everything else

- **Chosen:** one global frame and three kinds of local frame.
  - **Global:** ECEF (Earth-centered, Earth-fixed) on the WGS84 ellipsoid, meters, `f64` (a plain JS `number`). It answers "where on Earth" for partition anchors, the camera, the player and streaming. It never goes to the GPU.
  - **Partition:** each partition has an anchor (its center in ECEF) and the east-north-up (ENU) basis there. Its static geometry is `f32` meters in that frame. Vertices come from true lat/lon/height, not from a plane, so a partition is slightly curved in its own frame (about 8 cm of drop 1 km from the anchor) and neighbors meet exactly: a shared OSM node lands on the same ECEF point from both sides.
  - **Sim:** physics, collision and the dynamic grid run in an ENU frame near the player, in `f32`, rebased when the player moves about a kilometer or two from its anchor (threshold to be measured). Partitions enter it through a rigid transform computed in `f64`. Gravity is the frame's −z; within a couple of km the true vertical differs by a few hundredths of a degree.
  - **Render:** camera-relative. Each frame, each partition's partition→camera transform is computed in `f64` and only then cast to `f32`. The camera's orientation is relative to the ENU at its position, so north and up are always local.
- **Heights:** ellipsoidal (WGS84) inside the game. Elevation models usually give heights above the geoid (EGM96/EGM2008), so they are converted at import; around Denver the difference is about −17 m.
- **Terrain is in scope:** roads, buildings and the camera sit on an elevation model, not on z = 0.
- **Flight is in scope:** the frames work at any altitude; the sim frame just rebases more often at speed. Long view distances need distant terrain LOD and a depth-precision strategy (reversed-Z or logarithmic depth), both still open.
- **Rejected:** one flat projected world (UTM, Lambert conformal conic, Web Mercator), because across a continent scale error reaches 1–2% or more, up turns about 14° between Denver and Chicago, and `f32` still needs rebasing; the per-area equirectangular projection exports use today, because areas don't share a frame and a spherical radius misstates scale (about +0.15% north, −0.25% east at Denver); ECEF in `f32`, because at Earth's radius its spacing is half a meter.
- **Why:** the goal is a continuous world you can drive or fly across in real time, such as Denver to Chicago (about 1,600 km, 14 hours). Precision then doesn't depend on where on Earth you are.
- **Status:** built for the static world (decision 22): cells, the ground and the camera use these frames. Roads and buildings are still 2D on their cell's tangent plane (z dropped, a few cm at cell edges) until terrain gives them heights; the sim frame comes with the sim.

## 21. Partitions are S2 cells

- **Chosen:** Google's S2 cell hierarchy as the one global grid: the sphere projected onto a cube, a 30-level quadtree per face, cells numbered along a Hilbert curve into 64-bit ids. A partition is an S2 cell; dense areas use deeper levels than sparse ones, and ids stay stable because the grid doesn't depend on the data. Each cell's anchor frame is ENU at its center (decision 20). Implemented in `packages/world/src/s2.ts` (ids, parents, children, containment, centers, corners, edge neighbors including across cube faces, tokens, signed `bigint` for Postgres), checked against s2sphere reference values (`test/s2-golden.py`).
- **Rejected:** H3 (children only approximately cover their parent, which breaks containment and LOD; pentagons; hexagons are awkward for terrain grids); k-d trees or R-trees as the addressing scheme (boundaries move when data changes, which breaks cache keys, and they cover nothing over empty land or ocean, where terrain still lives; they stay as indexes inside a cell); Web Mercator z/x/y (cells shrink with latitude, about half size at 60°, and it stops at ±85°).
- **Why:** exact nesting, cell areas within about 2× of each other at a level anywhere on Earth, poles included, and nearby cells get nearby ids, so Postgres range scans and prefetching stay cheap. The same quadtree can serve partitions, terrain LOD and the far horizon when flying.
- **Details:** ids are `bigint` in TS. Cells are defined on lat/lon treated as spherical, like every S2 implementation, so ids interoperate with other tools; geometry inside a cell still uses WGS84. Cell edges are great-circle arcs, so a lat/lon polygon through the corners is padded when used in queries. For scale: a level-13 cell averages about 1.1 km across, level 11 about 4.5 km.
- **We wrote our own** port of the few hundred lines we need instead of depending on a JS port we would have to audit.

## 22. Cells on demand: the client asks, the server downloads, imports and exports

- **Chosen:** the viewer computes the level-13 cells within its horizon and requests them nearest first (`GET /cells/<token>/<table>.arrow`). The cell server answers from a disk cache, or generates the cell: it makes sure every level-12 cell within the cell's reach plus 300 m has been downloaded from Overpass and imported into PostGIS (recorded in `osm_fetches` as area `s2:<token>`), then runs `buildCell` and caches the Arrow files. The Vite dev server proxies `/cells` to it.
- **Levels:** cells are exported at level 13 (about 1.1 km, ~250 KB in downtown Denver) and downloaded at level 12 (about 2.3 km, 7–38 MB of raw OSM, 20–45 s from Overpass). Downloading the bigger unit keeps the request count to Overpass down; exporting the smaller keeps each response small and the load ring tight.
- **Ownership** is by one point per object (an edge's middle point, a building's outer-ring centroid), decided with `cellFromLatLon`, so every object is in exactly one cell regardless of which other cells exist. Ways are loaded together with every way sharing their nodes, so a way is cut at the same intersections by every cell that sees it.
- **How far:** the load radius is the distance to the horizon from the camera (`√(2Rh)`: 3.6 km from 1 m, 36 km from 100 m), capped at 5 km. Honest visibility goes further (a 200 m tower shows above the horizon from 55 km), and flight sees much further; that needs coarse cells (LOD), which is the next step for distance. Fog closes in at the radius.
- **Rejected for now:** a bundle format for a cell's three tables (three requests per cell are fine locally and keep each file readable by any Arrow tool); bulk regional imports (needed for the long drives, but the on-demand path works anywhere today and the import code is the same); generating in a Vite plugin (the server is what production needs).
- **Known gaps:** cached cells aren't invalidated when newer OSM arrives; only one Overpass download runs at a time, so a fresh area takes minutes; cells crossing the antimeridian are refused.

## 23. Regional extracts (OSM PBF) as the bulk source; Overpass only to fill gaps

- **Chosen:** download Geofabrik extracts (`.osm.pbf`, rebuilt daily: Colorado 389 MB, the Denver→Chicago states 990 MB, the US 12.3 GB) into `data/osm/pbf/` and import them with `cli import-pbf`. Every level-12 download cell the extract fully covers (by its `.poly` boundary) is imported through the same extractors and per-cell import as an Overpass download, and recorded the same way (`osm_fetches.area = s2:<token>`), so the cell server simply never needs Overpass there. Cells on the extract's edge are left to Overpass.
- **Why:** Overpass took 20–45 s per 2.3 km cell, one at a time, with frequent "at capacity" errors; a 5 km horizon needed ~30 downloads, and a car at highway speed would outrun it. The extract has the same data (every node, way, relation and tag, so trees, fences and everything else we add later), downloads in about a minute and decodes in 6 s; importing a cell is milliseconds.
- **The reader** is ours (`packages/osm-import/src/pbf.ts`, ~250 lines): a minimal protobuf decoder yielding the same `OsmNode`/`OsmWay`/`OsmRelation` objects as Overpass JSON, with zlib injected so the package stays platform-free. All OSM interpretation stays in TS (decision 13); no osmium or osm2pgsql.
- **Import:** three passes over the file (node coordinates into sorted typed arrays, building relations, wanted ways), ways bucketed by the download cells their nodes fall in, then 8 cells at a time into Postgres. Batches skip the "delete what's missing from the box" step (`deleteMissing: false`): a cell's share of an extract is not a box query, and deleting by box would remove ways that belong to a neighbor's batch.
- **Not yet:** re-importing a newer extract (needs a region-wide delete of rows the new extract lacks, and invalidating cached cells); extracts for more regions (the same command; Nebraska, Iowa and Illinois are next for the road trip); keeping the tagged nodes (trees, signals) the extractors don't use yet.

## 24. Terrain: USGS 10 m bare earth on each cell, roads and buildings draped on it

- **Chosen:** USGS 3DEP 1/3 arc-second tiles (bare earth, ~10 m, NAVD88; 32 tiles and 12 GB for Colorado, in `data/dem/usgs13/`) plus NOAA GEOID18 (`data/dem/us_noaa_g2018u0.tif`) for heights above the WGS84 ellipsoid (decision 20). The cell server (`elevation.ts`, the `geotiff` package) reads only the 512-pixel blocks a cell needs, keeps ~500 decoded blocks, and samples bilinearly.
- **Per cell:** a 65 × 65 height lattice over the cell's S2 square (`terrain.arrow`, ~17 m spacing). Lattice points are exact globe positions, so neighbors share edge points and heights and meet without cracks. Draping (`drapeCell`) densifies road centerlines to 20 m and gives every point the ground's height (roads stay level across), and sits each building on the lowest ground under its outer ring (uphill walls run into the slope). Points are re-placed at their true height, not raised along the cell's up axis: "up" tilts across a cell, about 25 cm horizontally at 1 km and 1,600 m.
- **Rendering:** terrain is a lit mesh (flat ground keeps its color; slopes darken or brighten with the sun), drawn at one of four lattice steps by distance with skirts hiding cracks between levels. Roads are depth-tested now, nudged toward the camera by 0.3 m plus 0.1% of the distance so they win against the ground under them but hide behind hills. The camera moves by height above the ground and never goes below it.
- **Rejected:** USGS 30 m (misses road cuts and sharp ridges); Copernicus GLO-30 (global, but a surface model: canopy and buildings are in the "ground", which would double up with generated trees and OSM buildings).
- **Not yet:** road grading (cuts and fills: the DEM alone smooths them, and roads can sink below or float a little over the 17 m lattice in steep terrain), bridges and tunnels (they follow the ground today), distant terrain for the far horizon, ground color by land cover and elevation, data outside Colorado (missing heights fall back to 0 m).

## 25. Water: OSM lakes, river surfaces and waterways, clipped per cell

- **Chosen:** water areas (closed ways and multipolygons tagged `natural=water`, `waterway=riverbank`, `landuse=reservoir`/`basin`) and waterway lines (`waterway=river/stream/canal/ditch/drain`, not tunnelled or intermittent) are extracted in TS, stored in `water_areas` and `waterways` (migration 0004), and imported with roads and buildings from both Overpass and PBF extracts.
- **Clipped, not owned:** a reservoir or a 50 km river would stretch far past any owner cell, so each cell clips water to its own square (`cellWater`: Sutherland–Hodgman for areas, Cyrus–Beck for lines) and neighbors' pieces meet along the shared edge.
- **Heights:** lakes are flat at the median ground height sampled inside them. USGS elevation is hydro-flattened (a lake is one height in the data), so every cell sampling the same lake gets the same level. River surfaces are cut into a 20 m grid and every vertex is draped. Waterway lines become ribbons of their `width` (or a default by kind: river 12 m, canal 6 m, stream 2.5 m, ditch 1.5 m), level across, following the centerline's ground.
- **Format:** `water.arrow`, a plain triangle list (one row per vertex: position, material lake / river / stream). Drawn after terrain, nudged toward the camera slightly less than roads, so a road over a stream wins.
- **Not yet:** reflections, waves or transparency (flat color by kind), shorelines carved into terrain where the DEM isn't flattened (small ponds can sit under the ground or float slightly), intermittent streams (left out: often dry beds).

## 26. Ground color: elevation and slope rules first, land cover next

- **Chosen:** the terrain shader colors the ground by height and slope: plains grass → montane forest (from ~2,300 m) → alpine tundra at treeline (~3,450 m) → rock (from ~3,700 m, and on slopes steeper than ~35–45° at any height) → snow (from ~3,950 m, not on very steep faces). Each band's edge moves by up to 120–200 m with a smooth noise field computed from lat/lon at the terrain lattice points, so bands don't read as contour lines and neighbors agree at shared edges. Flat ground below the forest band keeps exactly the base color.
- **Why rules first:** above treeline, land cover data mostly says "bare or sparse", so rock, tundra and snow need these rules regardless; and they need no new data.
- **Why land cover next:** elevation can't tell a wheat field from prairie, or forest from shrub at the same height. ESA WorldCover (10 m, global) or NLCD (30 m, US, with crops, pasture and forest types) will decide below treeline, and the same classes will drive tree placement.
- **Limits:** the thresholds are tuned for Colorado (treeline falls with latitude and varies by climate); snow is a fixed line, not seasonal.

## 27. Vehicles: Kenney Car Kit models (CC0), standing in their lanes, instanced

- **Chosen:** 10 everyday models from the Kenney Car Kit 3.1 (sedan, sports sedan, hatchback, SUV, luxury SUV, van, pickup, delivery truck, taxi, police; CC0, ~2,100 triangles each, one shared 512² palette texture), committed in `packages/viewer/assets/vehicles/` with the kit's license file. Credit to Kenney is voluntary; we give it here and in the license file.
- **Loading:** our own minimal GLB reader (`readGlb` in `@game/world`, pure and tested): every mesh node merged into one indexed mesh with node transforms applied, converted from glTF's Y-up, facing +Z to our Z-up, facing +Y, and scaled 1.85× (the kit is toy-sized; a sedan becomes ~4.7 m). No 3D engine or loader library.
- **Placement before traffic:** `placeVehicles(graph, seed)` stands cars in their lanes per cell (right-hand traffic, lane widths as the road surface, clear of intersections, spacing by road class, tilted with the road), seeded by the cell id so the same cars appear every visit.
- **Rendering:** one instanced draw per model per cell, instances in the cell frame placed by the cell's matrix: no per-car CPU work per frame. Drawn in visible cells within 1.5 km (`?cars=0` hides them).
- **Rejected:** procedural box cars (the user wanted real models first); Sketchfab-style replicas of real cars (trademarks, and recreating existing products).
- **Next:** traffic (the `sim` package: lanes, car following, intersections), a cheaper stand-in for distant cars, paint color variety (the palette texture fixes each model's color).

## 28. Dynamic tables: dense typed-array columns, batch kernels, cursors for row logic; first traffic

- **Chosen:** `Table<Schema>` in `@game/sim`: a schema of named typed-array columns, rows packed densely in `0..count-1`, removal moves the last row into the hole, capacity doubles when full. Batch updates are plain loops over the columns (no holes, no liveness checks, no objects): the shape that ports to WASM SIMD unchanged. (V8 doesn't auto-vectorize JS; the point is tight monomorphic loops now and a direct port later, decision 1.) Row-based logic uses `table.cursor(i)`: a reusable view generated from the schema whose properties read and write the columns at row `i`; moving it is `cursor.i = n`, with no allocation.
- **Where each is used:** traffic speed and distance are a batch pass over every car; the few cars that reach the end of a road go through a cursor (pick a way onward, a lane, or leave). Existing tables (road graph, buildings, terrain, water) are only processed in batches, so they don't get cursors.
- **Traffic v1:** cars on (cell slot, edge, direction, lane, distance). Target speed is set by the road, not the driver: the limit in the rightmost lane, +10 mph per lane to its left; cars accelerate at 2.5 m/s² and brake at 4 m/s² toward it. At the end of a road a car takes a random way onward through the shared OSM node (one-ways respected, U-turns only at dead ends) into a random lane. Fixed 1/30 s step with a seeded RNG: deterministic.
- **Around the camera:** cells within 1.5 km are populated with the cars `placeVehicles` stands in their lanes, starting from rest; beyond 2 km they're dropped, with their cars, and cars driving into a cell that isn't populated leave. The viewer computes poses for cars in visible cells into one instance buffer per model each frame (`TrafficView`, `createCarRenderer`).
- **Not yet:** cars drive through each other (no car following, no right of way at intersections, no lane changes mid-road), and the frame loop now runs continuously while there is traffic (`?traffic=0` stops it).

## 29. Roads on the drawn ground: level cross-sections, fill skirts, bridges and tunnels

- **Chosen:** everything is placed on the terrain that is drawn, not on the raw DEM. `groundSampler` builds the lattice of whichever cell contains a point (sampled once per cell, lowered under lakes by `carveWater`) and interpolates it on the same two triangles per square that the mesh draws, so a road, building or water surface in one cell sits on its neighbors' terrain exactly as those neighbors draw it. The cell server loads elevation and water over the whole neighbor cells a cell's objects reach into.
- **Roads:** centerlines are densified to 8 m. Each cross-section sits at the highest ground under the road segments on either side of it (`footprintMax`: exact for a piecewise-planar surface, checking polygon corners, lattice vertices inside, and edge crossings with the lattice's rows, columns and diagonals), so a road is never below the terrain and stays level across. A node sits at the highest ground under its disc and edges start and end at their nodes' heights, so junctions stay joined, across cells too (a node's height depends only on the ground). Where a road is above the ground, earth-colored fill skirts run from its edges down to the terrain.
- **Bridges and tunnels** (`bridge=*`, `tunnel=*` except `building_passage`) run straight between their end nodes, with no skirts: a bridge spans the valley and a tunnel goes under the hill.
- **Rejected:** cutting roads into the terrain (editing the lattice per road): neighbors would have to agree on every cut, and fills alone read correctly from the road.
- **Not yet:** cuts through hillsides (a road on a side slope rides on fill on its downhill side instead), bridge decks and piers, tunnel portals, layer tags for stacked roads.

## 30. Cars never jump: mitered lanes, turn curves through junctions, heading from the wheelbase

- **Chosen:** a car's path is continuous in position and direction. Along a road each lane is the centerline offset sideways with mitered joints (`laneGeometry`, `lanePoint`), as the surface is drawn. Through a junction a car leaves its lane where it meets the node's disc and follows a cubic Hermite curve (`turnPoint`, matching direction at both ends, tangents from the chord straight on to twice it for a U-turn) to its next lane where that leaves the disc. A curve reaches at most half a road into it (`junctionReach`), so the curves at both ends of a short road never overlap.
- **Planned one road ahead:** the sim picks a car's way onward when it enters a road, not when it reaches the end, and keeps the road it came from (`pcell`… and `ncell`… columns), so the renderer draws the turn ahead and finishes the one behind. Lanes keep their place counted from the right; where a road adds lanes the car may take one of them, where lanes end they merge.
- **Pose:** a car stands at its point on the path and faces from the point half a wheelbase (1.35 m) behind to the one half a wheelbase ahead, so yaw and pitch turn smoothly through bends and junctions. Path points on different cells' roads meet in the view frame.
- **Tested:** `traffic-view.test.ts` drives a car from every lane of a network with a bend, a lane drop and dead ends, and checks it never moves more than 1.5 m or turns more than 15° in a 1/30 s frame (the previous code fails it).
- **Not yet:** drawing between sim steps (cars move at 30 Hz, so they stutter on faster displays), fading cars in and out where cells are populated and dropped, lane changes mid-road (they'll follow the same rule: a gradual sideways move, never a snap), car following and right of way.

## 31. Live air traffic: ADS-B from adsb.fi, generated cartoon aircraft, extrapolated and eased

- **Source:** adsb.fi's open data API (readsb JSON; no key; 1 request/s, no daily quota; personal, non-commercial use, credited with a link in the viewer's footer). It was adsb.lol, the open choice among the free aggregators, until 2026-11-22: adsb.lol had capped us at 500 requests a day and archived its API repo, and the game is a personal project for now, so non-commercial terms are fine (revisit before any public or commercial release). The cell server answers `GET /aircraft?lat=&lon=&nm=` from it with one upstream request per 5 s at most across all callers, spread out further over any daily quota the source reports, waiting out a 429, and serving the freshest nearby answer in between (`AIRCRAFT_SOURCE`, a URL with `{lat}`, `{lon}` and `{nm}`, points it elsewhere, e.g. a local readsb on an RTL-SDR receiver). The viewer asks for 60 nm around the camera every 10 s, or sooner after moving 20 km; `?planes=0` turns it off.
- **Reports** (`parseAircraft`): SI units, heights above the WGS84 ellipsoid from ADS-B's geometric altitude (already ellipsoidal); barometric-only aircraft are corrected by the mean geometric − barometric difference of the others in the same response (today's pressure, around here). Surface vehicles (category C) are dropped.
- **Models:** generated in `@game/world` (`aircraftMesh`), low poly and cartoony like the Car Kit: narrow-body, wide-body, four-engine, regional jet (tail engines, T-tail), business jet, turboprop (high wing), light single and helicopter, picked from the ICAO type designator with the ADS-B emitter category as fallback, sized like typical members of the kind. Generic shapes and tail colors only (one per airline callsign prefix, from 8): no replicas of real types, no real liveries (as decision 27). Drawn with the car renderer: one instanced draw per model (8 kinds × 8 tails), a 16 × 1 palette texture.
- **Motion** (`AirTraffic`): each plane flies on in a straight line at its reported ground speed, track and climb rate from where its position was received; taxiing planes stay on the loaded terrain. A new report never moves a plane: the difference between where it is drawn and where the report puts it (position and velocity) fades out over ~2 s. A plane that stops reporting holds after 30 s and is forgotten after 60 s. No banking or flight dynamics; drawn at real size.
- **Contrails:** every plane more than 3,000 m above the ground (none taking off or landing) leaves a 40 s white ribbon of where it was drawn (sampled each second; a plane seen for the first time gets one back along its velocity, so it shows at once), facing the camera, widening from 6 to 56 m and fading with age. They are how high and distant planes are seen: never thinner than about 1.5 px, only lightly fogged, and pulled inside the far plane (60 km) instead of clipped, so the whole 60 nm fetch circle shows. Blended last, without writing depth.
- **Not yet:** banking into turns, spinning props and rotors, recording reports for deterministic replays.

## 32. Airport surfaces: runways, taxiways and aprons from OSM, plain concrete

- **Chosen:** OSM `aeroway` features are extracted in TS like water (decision 25): center lines (`runway`, `stopway`, `taxiway`, `taxilane`) with `width=*` or a typical width (runway 45 m, taxiway 23 m, taxilane 15 m), and areas (closed `aeroway=apron` ways and multipolygons, and runways or taxiways mapped as areas). Stored in `aeroway_lines` and `aeroway_areas` (migration 0005), imported from both Overpass and PBF extracts; Colorado has 408 runway and 2,577 taxiway lines and 274 aprons.
- **Per cell** (`cellAeroways`, `aeroways.arrow`): clipped to the cell's own square, so a 5 km runway meets itself along cell edges. Areas are cut into 12 m squares with every vertex on the drawn ground; lines become ribbons of their width, level across, at the highest ground under them. Kinds stack where they overlap (taxiways 8 cm above aprons, runways 16 cm above taxiways) and are drawn between water and roads, so a service road across an apron wins.
- **Look:** plain concrete, the runway lightest. No paint yet: the user chose surfaces first.
- **Not yet:** markings (runway center lines, edge lines and threshold stripes; yellow taxiway center lines; runway numbers and holding positions), widths from the airport's real data where OSM has none (DIA's 16R/34L is 61 m), helipads, airport lighting.

## 33. Sidewalks: generated along the road graph, from tags or a town-street rule

- **Chosen:** sidewalks are part of the road surface (`roadSurfaceMesh`), generated beside each edge on the sides its `sidewalks` bits say (1 left, 2 right, looking from → to; a new edges column, so graph version 4): a 1.8 m concrete strip beyond the shoulder, 15 cm above the road, with a curb face up from the road and an outer face down to the ground. They stop at intersection discs, leaving the corners open like curb ramps, and run through plain joints.
- **Which sides** (`roadSidewalks` in `@game/osm-import`, from the stored way's tags): `sidewalk=both|left|right|no|separate` and `sidewalk:left|right|both`, swapped for ways stored against their node order (oneway=-1). A separately mapped sidewalk counts as a sidewalk at the curb. Untagged roads get both sides when they're town streets: primary to residential and living streets at 40 mph or less, not in tunnels; never motorways, trunks, links or service roads (alleys, parking aisles). No re-import: the tags were already stored.
- **Draping** puts each cross-section at the highest ground under the road and its sidewalks, so the ground never pokes through a sidewalk; fill skirts hang from the sidewalks' outer edges.
- **Rejected for now:** drawing OSM's separately mapped footways where they are (often a grass strip from the curb in Denver): they'd need matching to their streets to avoid doubling up, and the curb-side strip reads clearly from the road.
- **Not yet:** corner fillets and curb ramps, tree lawns between curb and sidewalk, footpaths away from roads, crosswalk paint, driveways cutting the curb.

## 34. OSM import in Rust (cellgen), on demand; supersedes the TS import (13, 23)

- **Chosen:** fetching, parsing, interpreting and importing OSM moved into the Rust cell generator (`crates/cellgen`: fetch.rs, osm.rs, extract.rs, import.rs, areas.rs), rule for rule from the TS extractors and with the same SQL; the TS `osm-import` package, `cli fetch-osm`/`import`/`import-pbf` and the db import functions are deleted. `cellgen serve` imports a cell's download areas (level-12 S2 cells, from Overpass, one download at a time) before building it, and answers `GET /ensure/<area>` for the TS cell server, which still builds fine cells' roads, buildings and terrain from PostGIS. Points of interest are new (`pois`).
- **Why:** one place for OSM interpretation now that the ground is built in Rust; the TS import was the last thing keeping the Node packages that parsed OSM. Rust parses an area in 20–55 ms and extracts it in 2–13 ms (TS: 12–80 ms to extract).
- **Checked:** the Rust extractors match the TS ones (counts and sums) on four areas, and re-importing an area the TS had imported leaves every row identical.
- **Open:** Overpass is slow for teleporting (20–45 s per area). Geofabrik regions download too slowly to fetch on demand (`cellgen region` finds and downloads one); a local planet or continent, preprocessed into areas, is the likely answer. Decision 23's bulk import is gone with the TS code; data already imported stays.

## 35. Street name signs at intersections

- **Chosen:** one sign per intersection, on the corner between two differently named streets (the one facing most south-east), in the grass strip behind the curb: placed by the same corner rule as the street polygons (along the gap's bisector), at the streets' half widths plus 0.75 m. A 3 m gray pole and two green blades along the streets they name, white text with US abbreviations ("N Speer Blvd"); only the cell owning the intersection places it. Since decision 41 the sign layer is generic boxes with text, one canvas atlas per cell.
- **Not yet:** stop signs, traffic lights, house numbers.

## 36. The ground is generated in Rust (cellgen) as one exact partition; the browser only loads it

- **Chosen:** a Rust crate, `crates/cellgen`, builds each cell's ground and serves it (`cellgen serve`, axum on 5175, cached under `data/rust-cells/<token>/`; Vite proxies `/ground`). Every point of a cell is exactly one kind: asphalt, yellow and white markings, grass, sidewalk, lot (and from decisions 38–39 water, runway, taxiway, apron, forest, rock, snow). Checked on every build: the kinds' areas sum to the cell's square with nothing uncovered.
- **How:** the road graph as indices (ways cut at shared nodes, ends sorted by exact orientation, faces traced); every proper crossing of two segments without a shared node gets a shared point first, so the graph is planar (interchanges, overpasses). Each block shrinks inward by per-side widths with Clipper2 (`clipper2-rust`, `using_z` carrying dart ids): kerb, grass, sidewalk; markings cut from the pavement outside junction zones; water and airports by precedence (road > runway > taxiway > apron > water > grass/lots). On a micrometre grid. Then cut along the terrain lattice's triangles, draped, triangulated (earcut), smooth normals interpolated from the lattice (with a one-point rim so neighbors agree), vertices welded, written as Arrow (`ground.arrow`: f32 positions, i8×4 normals, u8 material; `ground_triangles.arrow`: u16 or u32 indices).
- **Rejected:** the hand-rolled shrink (tangles, slivers) and the TS `@game/streets` polygons drawn over a separate terrain mesh (grass showing through roads, z-fighting, ~15 ms of browser earcut per cell). TS ground generation (terrain mesh, street polygons, water and aeroway meshes) is deleted: "only load from Rust, never generate" — for the ground; buildings near the camera stay in TS (decision 40).
- **Why:** an exact partition can't fight itself, and Rust built the Speer cell in 0.48 s against the TS server's 2.8 s (62 MB vs 510 MB). This partly supersedes decision 1: Rust for server-side bulk geometry, TS in the browser and the TS cell server (fine cells' road graph, buildings, terrain heights, POIs).
- **Open:** bridges and tunnels as their own decks (today a bridge is drawn on the ground, winning over water), round kerb ends, junction-shaped markings.

## 37. Ground tiers by S2 level, coarsest first, with a stencil cascade

- **Chosen:** three tiers, each an S2 level built by the same pipeline with `Options::for_level`: fine (level 13, ~1.1 km: everything) within 3 km of the camera in 3D; coarse (level 10, ~9 km: residential streets and up, lines simplified to 2 m by Douglas–Peucker *before* Clipper, a 32-square lattice, no markings or sidewalks, plus building massing) to 25 km; far (level 7, ~70 km: terrain on a 128-square lattice, land cover, lakes and waterways 15 m+, simplified to 20 m; no roads, airports or buildings) to 150 km. The viewer loads only what's in the view frustum, coarsest first, each nearest first; fine ground marks the stencil, coarse draws where unmarked and marks too, far draws where neither did. Far plane 200 km; the near plane moves out with height (to 50 m). The load radius counts 3 km mountains, so the Front Range shows from Denver.
- **Massing** (coarse tiles): footprints simplified to 1 m, buildings under 40 m merged where within 10 m (grown per building, unioned per cluster, shrunk per shape), outlines thinned to 5 m, shapes under 100 m² dropped, each at its buildings' area-weighted mean height; towers kept on their own. Triangles sorted by fine cell, a range each, so the viewer skips the ranges whose fine cells are loaded (they have their own buildings); none drawn beyond 12 km.
- **Rejected:** pre-rendered textures for far tiles (a texture pipeline for detail no one sees at 30+ km); geometry roads drawn over a coarse terrain mesh (z-fighting, draping); one box per building far away (~1M triangles per tile).
- **Measured:** the Five Points coarse tile is 0.7 s to build; with car stand-ins (decision 42), a frame at the default Denver view went from ~12.5M to ~4.6M triangles.
- **Open:** skirts where tiers meet, one request per tile (the browser's 6-connection limit), compression, a level above far for the globe.

## 38. Land cover from height and slope; smooth shading

- **Chosen:** open ground (lots) takes its kind from its terrain triangle (`landcover.rs`): grass on the plains, forest from 2,100 m, rock above 3,500 m or steeper than 35° in the mountains, snow from 3,900 m where gentler than 40°. Rules for the Front Range, behind one function so NLCD (USGS land cover, 30 m, public domain) can replace them. Lighting interpolates smooth lattice normals across each triangle (decision 36); land cover still follows triangles.
- **Why:** colors on faces instead of textures (decision 37); smooth normals also welded vertices (Speer 102.6k → 61.5k, the Mount Evans far tile 126k → 46k).

## 39. Airports as ground kinds; the TS aeroway meshes deleted (supersedes 32's drawing)

- **Chosen:** runway, taxiway and apron are ground kinds in the Rust partition at every tier: lines expanded half their width (runways flat-ended, taxiways round), areas as they are; road wins over all three, then runway over taxiway over apron, then water. The TS aeroway mesh, its cell table and the viewer layer are deleted; the import (now Rust, decision 34) is unchanged.
- **Why:** airports on coarse tiles for free, drawn as true ground instead of 8–16 cm above it.

## 40. Fine buildings stay generated in TS: shader windows, pitched roofs, paint

- **Chosen:** fine cells' building meshes are built in the browser (`building-mesh.ts`) on purpose, so near buildings can get ever finer (doors, recessed windows, café tables). Windows are drawn by the fragment shader from each wall vertex's façade position (m along the wall from its first whole bay, m above its bottom, the bays' width, the wall's height) and the floor height (from `building:levels`, else by group): whole bays on full floors only, none on walls too short for a bay, utility buildings, parts under 40 m² on top of others, or domes; fading to the pattern's average under a pixel. Houses (and `roof:shape=gabled|hipped|pyramidal`) get pitched roofs fitted to the footprint's smallest bounding rectangle (each face the footprint clipped to where its plane is lowest; walls rise to meet it); residential buildings a paint color per OSM id. Walls meeting at under 30° share normals (curves shade smoothly); the bottom 5 m darken toward the ground.
- **Rejected for now:** façade textures (need art and an atlas), window geometry at every distance (millions of triangles). Moving fine buildings to Rust: the user wants them in TS.
- **Next:** near geometry within ~100 m (recessed windows, doors, shopfronts, seating), roofs from a straight skeleton for L-shaped houses.

## 41. Businesses on their buildings: shopfronts and named signs

- **Chosen:** points of interest (named or branded `shop`, `amenity`, `office`, `tourism`, `craft`, `leisure`, `healthcare`; decision 34's `pois` table) go to fine cells as `pois.arrow`, each assigned to the smallest ground-level building holding it, or the nearest within 25 m, and owned by that building's cell. Its building gets a shopfront (wide ground-floor glass: a flag in the floor byte); its sign goes on the building's outer wall nearest its point (3 m walls first), centered on the point's projection, sized to its name, colored by kind (food brown, shops red, offices navy, ...); several on a wall are spaced and squeezed to fit. Where it's unclear which part of a building a business is in, picking one is fine.
- **Not yet:** signs on the street-facing wall specifically, free-standing businesses, entrances (`entrance=*`: maybe; procedural doors may do), opening hours, interiors. Colorado's bulk-imported areas have no POIs until re-imported.

## 42. Driving: an arcade car with 2.5D collisions; traffic that yields and queues

- **Chosen:** `sim/vehicle.ts`, a pure, substepped arcade car in a local floating frame (ENU where driving started, re-anchored every 2 km): velocity split into forward and sideways each step, throttle, braking to a stop then reverse after 0.3 s, drag, speed-dependent engine braking, gravity along the slope, grip damping sideways speed (less with the handbrake), a bicycle-model heading with rate-limited steering falling off with speed; it sits on the ground under its four wheels. Collisions are 2D: the car's rectangle against wall segments by the separating axis test (push out, bounce a little, scrub along); walls come from each fine cell's ground-level building edges in a 16 m grid (`world/wall-grid.ts`) and from nearby traffic cars' rectangles. The viewer drives with V; the captured mouse is an analog wheel (x) and pedal (y), WASD add to it; a chase camera lags the heading so slides show. Traffic: a speed cap per car set from outside (the player ahead in its path within 2.2 m of its line: stop 4 m short), and car-following in the sim (sorted by lane; never faster than lets it stop 2 m behind the car ahead, or the first car on the road it turns onto, if that braked hard). Distant traffic cars draw as 24-triangle stand-ins beyond 250 m.
- **Rejected for now:** a physics engine (Rapier): realistic crashes and suspension aren't the goal yet, and 2.5D needs no new world data.
- **Not yet:** right of way and signals at junctions, lane changes, pushing cars, damage, walking, the coffee stop (pull up at a café, get a prompt).

