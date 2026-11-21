# Spatial partitioning and indexing

Two separate concepts:

- **Partition:** the unit of regeneration, caching and streaming. Operators run per partition, blobs are per partition, the viewer loads and unloads partitions.
- **Index:** a structure for answering spatial queries fast.

Keeping these separate means "what gets rebuilt" and "how we search" can change independently.

## Partitions

- Adaptive, split by item count, so downtown and rural areas cost about the same per partition. Fixed-size tiles were rejected for this reason.
- Partitions are cells of one global hierarchy, not something defined per fetch, so every place on Earth has a stable address and every partition uses the same coordinate logic. The hierarchy is S2 (decision 21): a partition is an S2 cell, and adaptivity comes from choosing the cell level per region. Partition ids are S2 cell ids.
- Partitions must be deterministic for a given data snapshot: the same input always yields the same partition IDs.
- Each partition has an anchor frame (ENU at its center) and stores geometry in `f32` relative to it (decision 20).

### Objects crossing boundaries

- Each object is owned by exactly one partition, chosen by centroid. A partition's bounding box grows to cover everything it owns. Culling and queries use these expanded bounds.
- Operators that need context across an edge (intersections near a boundary, sidewalks meeting) declare neighbor dependencies and read padding from adjacent partitions. See [operators.md](operators.md).
- Long roads are split at intersections during import, which keeps most edges short. Very long edges without intersections (highways) may be split at partition boundaries with a synthetic node.

## Indexes

| Need | Structure | Lifetime |
|---|---|---|
| Static queries: nearest road, building at a point, what's in a box | Flatbush (static packed Hilbert R-tree in one `ArrayBuffer`) | built per partition by an operator; transferable between workers |
| Cars, pedestrians, collision broadphase, "what's near me" | uniform grid, 32–64 m cells | updated every tick, part of sim state or derived from it |
| Raycasts, line of sight, camera collision | BVH over building geometry | built per partition by an operator |
| Which partitions are visible or nearby | R-tree over partition bounds | updated when partitions load |

## Queries

- **Visibility:** intersect the camera frustum with partition bounds, then draw those partitions' meshes at a LOD chosen by distance.
- **Streaming:** partitions within a radius of the player load; partitions beyond a larger radius unload (hysteresis avoids thrashing).
- **Raycasts:** walk partitions along the ray, test each partition's BVH, and test the dynamic grid cells along the ray for vehicles.
- **Text view:** query the dynamic grid and static R-trees for a window around the player.
