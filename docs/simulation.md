# Simulation

## The step function

```ts
type Input =
  | { kind: "throttle"; value: number }   // -1..1
  | { kind: "steer"; value: number }      // -1..1
  | { kind: "enterVehicle" }
  | { kind: "exitVehicle" };
  // ...exhaustive switch with a `never` check

function step(world: World, inputs: Input[], dt: number): void
```

- Fixed timestep (60 Hz to start). The viewer accumulates real time and calls `step()` zero or more times per frame, then interpolates between `prev*` and current positions for rendering.
- `world` holds everything: dynamic tables, RNG state, tick count, player state, references to loaded map data (by hash).
- `step()` mutates in place. Snapshot = copy all buffers. Restore = copy back.

## Determinism rules

- No `Math.random()`; a seeded RNG whose state lives in `world`.
- No `Date`, `performance.now()`, or any I/O.
- Fixed iteration order (by index), never by object key order or set order.
- Use `Math.fround` where intermediate results must match `Float32Array` storage.
- `Math.sin`, `cos`, `exp`, etc. are not bit-identical across JS engines. Node and Chrome share V8, so tests match Chrome. If replays must match in Firefox and Safari too, avoid them in the sim or use our own implementations (open question).
- A test runs every scenario twice and compares state hashes.

## Allocation discipline

- No object allocation in per-tick hot loops: no temporary `{x, y}` vectors, no closures from `.map()`/`.filter()`.
- Scratch buffers are preallocated.
- A test runs a long simulation and checks that heap usage stays flat.

## Sim LOD bubble

Only the area around the player is simulated:

- Ambient traffic and pedestrians spawn at the edge of a bubble around the player (at positions the camera is unlikely to see), live inside it, and despawn when they fall behind.
- Distant parts of the city are only static map data.
- Tick cost stays flat whether the loaded map is one neighborhood or all of Denver.
- Spawning uses the seeded RNG, so it is deterministic.

## Vehicles

- **AI traffic** moves on the lane graph: position is `(edge, t, lane)`. Following the road is increasing `t`; turning means picking the next edge at a node. World x/y is derived.
- **The player's car** uses hand-written arcade physics in free x/y/heading, constrained by building collision (BVH) and the ground.
- **Transitions:** an AI car hit hard enough leaves the graph and switches to free physics. A free car may rejoin the graph when it is aligned with a lane again (or simply despawn when out of view).

## Not yet designed

- On-foot movement and pedestrians.
- Traffic signals and right-of-way at intersections.
- The gameplay loop (delivery runs, chases, races, free roam). See [roadmap.md](roadmap.md).
