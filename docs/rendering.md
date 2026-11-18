# Rendering

The viewer is a pure view: it reads map artifacts and dynamic tables and draws them. It owns no game state.

The project is first an efficient world renderer; the game sits on top of it. Rendering work follows the same principles as everything else: meshes come from pure, tested operators, the GPU side holds only handles, and every view is reproducible from its URL.

## Built so far

`packages/viewer` (raw WebGL2, Vite dev server):

```
GET /<area>/nodes.arrow, edges.arrow ─▶ roadGraphFromArrow (zero-copy views)
  ├─▶ roadSurfaceMesh (world operator) ─▶ road layer: asphalt + markings, 1 draw call
  └─▶ roadLineMesh (world operator)    ─▶ graph overlay (G): 1 px lines by class, 1 draw call
ground layer: one green quad to the far plane, under everything
GET /<area>/buildings.arrow ─▶ buildingsFromArrow ─▶ buildingMesh (world operator) ─▶ building layer, 1 draw call
```

- **Road surface** (`road-surface.ts`, decision 18): each edge is a mitered ribbon whose width comes from lanes × the class's lane width plus shoulders; every node gets a disc as wide as its widest road, which fills intersection corners and rounds dead ends. Markings on tertiary roads and above: double yellow center line on two-way roads, dashed white (3 m dash, 9 m gap) between same-direction lanes, stopping short of intersections. 80205: 140k triangles.
- **Flat layers** (`flat-layer.ts`): one shader for every mesh on the ground plane, with a material index per vertex and a per-layer palette. They are coplanar, so they are painted in order (depth test `ALWAYS`) but still write depth.
- **Buildings** (`building-mesh.ts`, `solid-layer.ts`, decision 19): walls extruded from each ring edge with flat outward normals, flat roofs triangulated with earcut (holes included), every triangle counterclockwise from outside. Drawn after the ground with depth test `LEQUAL` and back-face culling. Lit by a fixed sun (south-southeast, high) plus ambient; colored by group (residential, commercial, industrial, civic, utility, other; wall and roof) with a stable ±10% tint per OSM id so neighbors differ. 80205: 17,014 polygons → 358k triangles.
- **Atmosphere:** sky-colored background, distance fog toward the sky color (range grows with altitude), and lane markings fading into asphalt between 60 and 220 m so they don't shimmer below a pixel wide. MSAA is on.

- **Camera:** a fly camera, `{pos, rot}` (position in meters, orientation quaternion), perspective with a 60° vertical field of view. `stepCamera(camera, input, dt)` is pure and tested in Node (decision 17). The pose is mirrored to the URL hash (`/?area=80205#x,y,z,yaw,pitch`, meters and degrees), so a URL fully describes the view.
- **Controls:** click to capture the mouse (Esc releases; dragging also looks); WASD or arrows move along the view direction; E/Space up, Q/C down in world space; Shift ×4. Speed scales with altitude (max(5, z) m/s). Keys are physical codes, so the layout doesn't matter.
- **Draw on demand:** the frame loop runs only while keys are held or the mouse moves; when input goes idle it stops and writes the pose to the URL.
- **Draw order:** segments are sorted by class, least important first, so major roads paint over minor ones without a depth buffer.
- **Style** (colors per class) lives in the viewer, not in the map data.
- **Limits:** lane data is sparse: in 80205 only 8 edges are tagged with 2+ lanes each way, so most arterials render as 1+1. Roads that cross without sharing a node (bridges) overlap flat. Roofs are all flat (`roof:shape` is on only 29 buildings in 80205). Buildings on the edge of the area are cut off with the fetch box. Lane-count changes show as small bulges at the node disc.
- 80205: 7,684 edges → 17,074 segments, one draw call.

## Static world

- Each partition's meshes come from operators, already merged into a few vertex buffers per partition and LOD. That keeps draw calls to a few hundred instead of one per building.
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
