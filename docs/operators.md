# Operators

The pattern comes from an earlier CAD system: columnar tables (Room, Door, Window) with Kubernetes-style operators that, when a table changed, regenerated the derived data for that spatial region into vertex buffers ready for the GPU.

Here, operators turn **static** map tables into per-partition artifacts. Dynamic entities never go through operators.

## Contract

An operator is a pure function from inputs to one artifact:

```ts
interface Operator<Out> {
  name: string;
  version: number;               // bump when the code changes
  reads: TableName[];            // map tables it reads
  needs: ArtifactName[];         // other artifacts it depends on
  neighbors: boolean;            // needs padding from adjacent partitions
  produces: ArtifactName;
  run(input: OperatorInput): Out; // no I/O, no clock, no randomness
}
```

- **The dependency graph is built from these declarations,** not hard-coded. At startup the scheduler checks for cycles and missing inputs.
- **Artifact key** = hash(operator name + version + hashes of all inputs). If nothing changed, nothing reruns. Bumping `version` invalidates exactly that operator's outputs and everything downstream.

## Planned artifacts

| Artifact | Reads | Used by |
|---|---|---|
| `roadMesh[lod]` | RoadEdge, RoadNode, neighbors | viewer |
| `buildingMesh[lod]` | Building | viewer |
| `areaMesh[lod]` | Area | viewer |
| `laneGraph` | RoadEdge, RoadNode, neighbors | sim (traffic routing) |
| `staticRTree` | all static tables | sim, queries, text view |
| `collisionBVH` | Building | sim (raycasts, collisions) |
| `textRaster` | RoadEdge, Building, Area | text view, minimap |

## Execution

- **Browser:** operators run in Web Workers. Outputs are `ArrayBuffer`s transferred to the main thread without copying. This keeps mesh generation off the main thread and avoids frame hitches while streaming.
- **Node:** synchronous by default (simplest, deterministic for tests), or `worker_threads` for throughput.
- **Caching:** artifacts are stored by key in the same cache as blobs (IndexedDB or files).

## Testing

Each operator can be tested alone: load a fixture partition, run it, compare the output hash to a golden value, and for meshes optionally render a debug image. See [testing.md](testing.md).
