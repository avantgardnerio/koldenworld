# Rendering

The viewer is a pure view: it reads map artifacts and dynamic tables and draws them. It owns no game state.

The project is first an efficient world renderer; the game sits on top of it. Rendering work follows the same principles as everything else: meshes come from pure, tested operators, the GPU side holds only handles, and every view is reproducible from its URL.

## Built so far

`packages/viewer` (raw WebGL2, Vite dev server):

```
camera (lat, lon, alt) ─▶ cellsWithin(horizon, ≤ 5 km) ─▶ CellStreamer: nearest first, 4 at a time
GET /cells/<token>/nodes, edges, buildings, terrain.arrow ─▶ cellFromArrow (zero-copy views) ─▶ per cell:
  ├─▶ terrainMesh (world operator)     ─▶ terrain: lit 65 × 65 lattice, 4 levels of detail + skirts
  ├─▶ water.arrow (cellWater on the server) ─▶ water layer: lakes, rivers, streams, 1 draw call
  ├─▶ roadSurfaceMesh (world operator) ─▶ road layer: asphalt + markings, 1 draw call
  ├─▶ roadLineMesh (world operator)    ─▶ graph overlay (G): 1 px lines by class, 1 draw call
  └─▶ buildingMesh (world operator)    ─▶ building layer, 1 draw call
each frame: model = frameToFrame(cell frame → ENU at the camera), f64 → f32 (decision 20)
```

- **Cells and streaming** (decision 22): the load radius is the distance to the horizon from the camera's height (`horizonDistance`), capped at 25 km until there is LOD; `?radius=<m>` fixes it. Cells out to 1.3 × the radius stay loaded, so the edge doesn't thrash; the wanted set is recomputed only when the camera enters another cell or the radius moves a 500 m step (about 7 ms for the 3,100 cells of a 25 km ring with its keep margin). A cell with no files (404) is bare ground; a failed one (e.g. the server could not reach Overpass) is retried after 30 s.
- **Frames:** everything is drawn in the ENU frame on the ground below the camera, so the camera is always at (0, 0, alt) and nothing the GPU sees is large. Each cell is placed by its own rigid transform; the Earth's curvature comes out of those transforms (the ground 5 km away is 2 m below the camera's horizon plane).
- **Road surface** (`road-surface.ts`, decision 18): each edge is a mitered ribbon whose width comes from lanes × the class's lane width plus shoulders; every node gets a disc as wide as its widest road, which fills intersection corners and rounds dead ends. Markings on tertiary roads and above: double yellow center line on two-way roads, dashed white (3 m dash, 9 m gap) between same-direction lanes, stopping short of intersections. 80205: 140k triangles.
- **Terrain** (decision 24): each cell's height lattice as a mesh in its frame, lit so flat ground keeps its base color. Drawn at lattice step 1, 2, 4 or 8 by distance (4, 8, 16 km); skirts (50 m walls hanging from each cell's edge) hide cracks between neighbors at different levels.
- **Flat layers** (`flat-layer.ts`): roads, markings and the graph overlay, 3D (draped on the terrain), with a material index per vertex and a per-layer palette. Depth-tested and nudged toward the camera (0.3 m + 0.1% of distance; markings 5 cm more) so they win against the ground beneath them but still hide behind hills.
- **Buildings** (`building-mesh.ts`, `solid-layer.ts`, decision 19): walls extruded from each ring edge with flat outward normals, flat roofs triangulated with earcut (holes included), every triangle counterclockwise from outside. Drawn after the ground with depth test `LEQUAL` and back-face culling. Lit by a fixed sun (south-southeast, high) plus ambient; colored by group (residential, commercial, industrial, civic, utility, other; wall and roof) with a stable ±10% tint per OSM id so neighbors differ. 80205: 17,014 polygons → 358k triangles.
- **Atmosphere:** sky-colored background, distance fog toward the sky color (from 75% of the load radius to all of it, so the world fades out instead of ending), and lane markings fading into asphalt between 60 and 220 m so they don't shimmer below a pixel wide. MSAA is on.

- **Camera:** a fly camera on the globe (`globe-camera.ts`): latitude, longitude and altitude in f64, and an orientation quaternion relative to east-north-up at that point; perspective with a 60° vertical field of view. `stepGlobe` runs the flat `stepCamera` (decision 17) in the local frame and moves the camera to where that lands on the globe, so long flights follow the Earth's curve. Both are pure and tested in Node. The pose is mirrored to the URL hash (`#lat,lon,alt,yaw,pitch`, degrees and meters above the ellipsoid), so a URL fully describes the view.
- **Controls:** click to capture the mouse (Esc releases; dragging also looks); WASD or arrows move along the view direction; E/Space up, Q/C down in world space; Shift ×4. Speed scales with altitude (max(5, z) m/s). Keys are physical codes, so the layout doesn't matter.
- **Draw on demand:** the frame loop runs only while keys are held or the mouse moves; when input goes idle it stops and writes the pose to the URL. The HUD shows a smoothed frame rate (measured while moving, kept when idle) and the last frame's CPU time.
- **Draw order:** segments are sorted by class, least important first, so major roads paint over minor ones without a depth buffer.
- **Style** (colors per class) lives in the viewer, not in the map data.
- **Limits:** lane data is sparse: in 80205 only 8 edges are tagged with 2+ lanes each way, so most arterials render as 1+1. Roads that cross without sharing a node (bridges) overlap flat. Roofs are all flat (`roof:shape` is on only 29 buildings in 80205). Lane-count changes show as small bulges at the node disc.
- **No per-frame garbage:** each cell keeps its own model matrix, written in place each frame (`frameToFrame(…, out)`), and the visible list is reused; the graph overlay's mesh is kept on the CPU and uploaded only the first time the overlay is drawn.
- **Frustum culling:** each cell has a bounding sphere around its frame origin (its ground, the roads and buildings it owns, which reach past its edge, up to its tallest building). Each frame the sphere is tested against the six planes of the view-projection matrix (`frustum.ts`); cells entirely outside aren't drawn. The HUD shows drawn / loaded.
- **Not yet:** LOD for anything past 5 km (towers and mountains beyond the horizon of the ground), meshes built in workers (they are built on the main thread as cells arrive).

## Static world

- Each partition's meshes come from operators, already merged into a few vertex buffers per partition and LOD. That keeps draw calls to a few hundred instead of one per building.
- **No per-frame garbage:** each cell keeps its own model matrix, written in place each frame (`frameToFrame(…, out)`), and the visible list is reused; the graph overlay's mesh is kept on the CPU and uploaded only the first time the overlay is drawn.
- **Frustum culling:** test partition bounds against the camera frustum. Nearly free, and removes most of the city.
- **LOD by distance:** full detail near the camera; simplified footprints, merged blocks or impostors far away.
- **Draw distance and fog:** caps the cost and hides streaming.
- **Streaming:** load partitions in a ring around the player, unload behind, with hysteresis.
- **Occlusion culling:** cities occlude heavily, so hierarchical-Z or GPU occlusion queries can pay off. Only add it when profiling shows the need.

## Dynamic entities

- Instanced drawing: one draw call per vehicle model. Instance attributes (position, heading, color) are written straight from the `Cars` columns each frame.
- Positions are interpolated between `prev*` and current values using the fixed-timestep remainder.

## Rough budget

Estimates, not measurements:

- The city of Denver has roughly 200–300k buildings in OSM. Simple extrusions are ~20–50 triangles each, so ~5–15M triangles for all of them.
- The raw data fits in memory easily (tens of MB).
- The real limits are draw calls, detail (textures, windows, props, car models) and the simulation, not raw triangle count. Culling, LOD and merged meshes handle this.

## Library

Raw WebGL2 (decision 16). Our columns are already GPU-ready buffers; a scene graph would wrap them in objects we would then have to keep in sync. WebGPU can come later behind the same layer interface.

## Required UI

- "© OpenStreetMap contributors" attribution, always visible.
