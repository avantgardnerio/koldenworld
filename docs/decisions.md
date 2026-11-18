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

