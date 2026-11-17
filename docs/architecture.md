# Architecture

## Goals

- An original open-world driving game set on real streets, built from OpenStreetMap (OSM) data.
- Any location: open the app, enter a zip code, play there.
- A workflow where every part of the game can be run, inspected and tested headless, by a human or by Claude.

## Non-goals

- Recreating any existing game (its name, characters, art, missions or look). Genre mechanics are fine.
- Simulating an entire city at once. Only the area around the player is alive (see [simulation.md](simulation.md)).

## Principles

1. **Model first.** All game state is data. Renderers (3D, text, JSON) are views of that data and never own state.
2. **Deterministic.** `step(world, inputs, dt)` with a fixed timestep and a seeded RNG. No clock, no I/O, no hidden state. The same inputs give the same result.
3. **Headless first.** Everything except the viewer runs in Node with the same code that runs in the browser.
4. **Columnar.** State lives in typed arrays (struct of arrays). Snapshots are buffer copies, diffs are byte comparisons, and buffers go to the GPU and between workers without conversion.
5. **Pure functions plus a scheduler.** The sim step and the operators that build derived data are pure, so each can be tested in isolation.
6. **The map is an input, not state.** Map data is versioned by content hash. Tests and replays reference a hash, never a live fetch.

## Packages

```
packages/
  sim/         pure step(), dynamic entity tables      ─┐ no DOM, no Node APIs:
  world/       map tables, operators, spatial indexes   │ loads anywhere
  osm-import/  raw OSM → map tables                    ─┘
  viewer/      3D rendering, input, UI                  ← browser only
  cli/         scenarios, replays, text view,           ← Node only
               JSON-lines on stdin/stdout
  server/      blob generator over PostGIS              ← Node only
```

The shared packages are compiled without DOM type definitions, and a lint rule blocks Node-specific imports, so platform leaks fail the build.

## Data flow

```
OSM extract ─▶ PostGIS ─▶ osm-import (TS, Node) ─▶ partition blobs (typed arrays)
                                                        │  HTTP, immutable, cacheable
                                                        ▼
                                   client cache (IndexedDB in browser, files in Node)
                                                        │
                                                        ▼
                                          map tables (columnar)
                                                        │  operators, per partition
                                                        ▼
                     derived artifacts: meshes, collision BVH, lane graph, rasters
                                                        │
       inputs ─▶ sim step() ─▶ dynamic tables ──────────┼──▶ viewer (3D)
                                                        ├──▶ text view
                                                        └──▶ JSON-lines
```

## Two speeds of data

| | Static world | Dynamic entities |
|---|---|---|
| Examples | roads, buildings, parks | cars, pedestrians, the player |
| Changes | rarely: import, streaming, maybe destruction | every tick |
| Pipeline | operators regenerate per-partition artifacts | none: columns feed instance buffers directly |
| Spatial index | R-tree / BVH per partition, rebuilt on change | uniform grid, updated every tick |

## Platform adapters

The few things that differ between browser and Node go through small injected interfaces:

| Concern | Browser | Node |
|---|---|---|
| Blob cache | IndexedDB | filesystem |
| Background work | Web Workers | `worker_threads`, or synchronous (tests) |
| Network | `fetch` | `fetch` (built in) |

## Runtime modes

- **Playing:** the browser loads blobs, runs operators in workers, runs `step()` and renders.
- **Headless:** the CLI loads blobs from disk or the blob server, runs the same `step()` and operators in process, and renders text or JSON. No browser or server is involved.
- **Dev bridge (optional, later):** the browser exposes the CLI's JSON-lines protocol over a local WebSocket so a live session can be inspected and driven. A debugging aid, not part of the architecture.
