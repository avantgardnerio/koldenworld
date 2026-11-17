# Roadmap

## Milestones

**M0: Scaffold.** Workspace with the packages from [architecture.md](architecture.md), TypeScript config without DOM types for shared packages, lint rule against Node imports, Vitest, CI.

**M1: Data in.** PostGIS in Docker, osm2pgsql flex schema, `osm-import` producing blobs for one small area, blob reader with zero-copy views, first fixtures committed.

**M2: One car, headless.** Road graph loaded, one car driving along edges, `cli view` text rendering, `cli repl`, first scenario and determinism tests.

**M3: 3D viewer.** Operators for road, building and area meshes in workers; partition culling; the player drives with arcade physics.

**M4: Traffic.** Lane graph operator, AI cars on the graph, sim LOD bubble with spawning and despawning, collisions with the dynamic grid.

**M5: Any location.** Zip code lookup, blob server with generate-on-miss, IndexedDB cache, partition streaming while driving.

**M6: Gameplay loop.** To be chosen (see below).

## Open questions

- **Name** of the game.
- **Gameplay loop:** timed deliveries, taxi runs, chases, checkpoint races, free roam first?
- **On foot:** is walking around part of the game, or only driving?
- **Viewer library:** Three.js vs raw WebGL2 / WebGPU.
- **Partition scheme:** quadtree cells vs R-tree node groups; target items per partition.
- **Large worlds:** origin rebasing for `f32` precision beyond ~10 km; stable entity IDs across partitions.
- **Cross-engine determinism:** do replays need to match in Firefox and Safari, or is V8 (Node + Chrome) enough?
- **Blob format:** custom aligned columns vs Apache Arrow IPC.
- **Missing buildings:** how good should an unmapped suburb look; procedural filler or not.
- **Hosting:** where PostGIS and the blob store live once there are users.

## Risks

- **Building coverage** varies widely; many locations may look empty without procedural filler.
- **Main-thread hitches** during streaming if operator work leaks out of workers.
- **ODbL share-alike** obligations on distributed blobs need a proper review before a public release.
- **Scope:** an open-world game is large. Keep each milestone playable or testable on its own.
