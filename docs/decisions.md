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

## 4. PostGIS as the source of map data

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
