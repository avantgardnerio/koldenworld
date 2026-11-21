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
- **Status:** not built yet. Exports still project around the fetch bbox center (`packages/world/src/projection.ts`) with ground at z = 0.

## 21. Partitions are S2 cells

- **Chosen:** Google's S2 cell hierarchy as the one global grid: the sphere projected onto a cube, a 30-level quadtree per face, cells numbered along a Hilbert curve into 64-bit ids. A partition is an S2 cell; dense areas use deeper levels than sparse ones, and ids stay stable because the grid doesn't depend on the data. Each cell's anchor frame is ENU at its center (decision 20). Implemented in `packages/world/src/s2.ts` (ids, parents, children, containment, centers, corners, edge neighbors including across cube faces, tokens, signed `bigint` for Postgres), checked against s2sphere reference values (`test/s2-golden.py`).
- **Rejected:** H3 (children only approximately cover their parent, which breaks containment and LOD; pentagons; hexagons are awkward for terrain grids); k-d trees or R-trees as the addressing scheme (boundaries move when data changes, which breaks cache keys, and they cover nothing over empty land or ocean, where terrain still lives; they stay as indexes inside a cell); Web Mercator z/x/y (cells shrink with latitude, about half size at 60°, and it stops at ±85°).
- **Why:** exact nesting, cell areas within about 2× of each other at a level anywhere on Earth, poles included, and nearby cells get nearby ids, so Postgres range scans and prefetching stay cheap. The same quadtree can serve partitions, terrain LOD and the far horizon when flying.
- **Details:** ids are `bigint` in TS. Cells are defined on lat/lon treated as spherical, like every S2 implementation, so ids interoperate with other tools; geometry inside a cell still uses WGS84. Cell edges are great-circle arcs, so a lat/lon polygon through the corners is padded when used in queries. For scale: a level-13 cell averages about 1.1 km across, level 11 about 4.5 km.
- **We wrote our own** port of the few hundred lines we need instead of depending on a JS port we would have to audit.

