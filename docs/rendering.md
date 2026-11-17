# Rendering

The viewer is a pure view: it reads map artifacts and dynamic tables and draws them. It owns no game state.

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

Open question: Three.js, or raw WebGL2 / WebGPU. Three.js is faster to start; raw APIs give full control over buffer layout. The static/dynamic split above works with either. See [roadmap.md](roadmap.md).

## Required UI

- "© OpenStreetMap contributors" attribution, always visible.
