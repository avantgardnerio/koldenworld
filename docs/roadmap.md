# Roadmap

## Milestones

**M0: Scaffold.** npm workspaces, Node running `.ts` directly, TypeScript configs that reject DOM and Node APIs in shared packages, Vitest. (Done; CI not yet.)

**M1: Data in.** Local PostGIS with roles and migrations, a one-time Overpass snapshot for 80205, converter upserting `road_ways`, road graph export to Arrow with zero-copy reads. (Done; committed fixtures still to do.)

**M2: Map in the browser.** Raw WebGL2 viewer drawing the road graph from the Arrow files, URL-addressable camera, headless e2e pixel tests and screenshots. (Done: green ground, asphalt roads with real widths, lane markings, fog, fly camera, graph overlay, buildings with heights.) Next: areas (parks, water, parking lots), then partitions and culling.

**M3: One car.** One car driving along edges, `cli view` text rendering, `cli repl`, first scenario and determinism tests, the same car drawn in the viewer; then the player drives with arcade physics.

**M4: Traffic.** Lane graph operator, AI cars on the graph, sim LOD bubble with spawning and despawning, collisions with the dynamic grid.

**M5: Any location.** Zip code lookup, blob server with generate-on-miss, IndexedDB cache, partition streaming while driving.

**M6: Gameplay loop.** To be chosen (see below).

## Open questions

- **Name** of the game.
- **Gameplay loop:** timed deliveries, taxi runs, chases, checkpoint races, free roam first?
- **On foot:** is walking around part of the game, or only driving?
- **Partition sizing:** S2 cells (decision 21); target items per partition and the rule for choosing cell levels.
- **Large worlds:** stable entity IDs across partitions. (Precision is settled by decision 20.)
- **Terrain source:** USGS 3DEP for the US, a global DEM (Copernicus GLO-30) elsewhere; resolution, and how roads are fitted to it (cuts, fills, bridges, tunnels).
- **Long view distances** for flight: distant terrain LOD and depth precision (reversed-Z or logarithmic depth).
- **Bulk OSM:** continent-scale imports from regional extracts (such as Geofabrik) instead of Overpass snapshots.
- **Cross-engine determinism:** do replays need to match in Firefox and Safari, or is V8 (Node + Chrome) enough?
- **IndexedDB:** deferred; revisit for offline play or caching client-built meshes.
- **Missing buildings:** how good should an unmapped suburb look; procedural filler or not.
- **Hosting:** where PostGIS and the blob store live once there are users.

## Risks

- **Building coverage** varies widely; many locations may look empty without procedural filler.
- **Main-thread hitches** during streaming if operator work leaks out of workers.
- **ODbL share-alike** obligations on distributed blobs need a proper review before a public release.
- **Scope:** an open-world game is large. Keep each milestone playable or testable on its own.
