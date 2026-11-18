# Rendering

The viewer is a pure view: it reads map artifacts and dynamic tables and draws them. It owns no game state.

The project is first an efficient world renderer; the game sits on top of it. Rendering work follows the same principles as everything else: meshes come from pure, tested operators, the GPU side holds only handles, and every view is reproducible from its URL.

## Built so far

`packages/viewer` (raw WebGL2, Vite dev server):

```
GET /<area>/nodes.arrow, edges.arrow ─▶ roadGraphFromArrow (zero-copy views)
  ─▶ roadLineMesh (world operator: positions = graph.points, per-point class, segment indices)
  ─▶ createRoadLayer: 3 buffers uploaded once ─▶ 1 drawElements(LINES) per frame
```

- **Camera:** `{x, y, mpp}` (center in meters, meters per CSS pixel), pure functions in `camera.ts`. It is mirrored to the URL hash (`/?area=80205#x,y,mpp`), so a URL fully describes the view. Drag pans, the wheel zooms about the cursor.
- **Draw on demand:** a frame is rendered only when the camera or canvas size changes.
- **Draw order:** segments are sorted by class, least important first, so major roads paint over minor ones without a depth buffer.
- **Style** (colors per class) lives in the viewer, not in the map data.
- **Limits:** lines are 1 device pixel (WebGL ignores `lineWidth`). Road ribbons with real widths are the next operator.
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
