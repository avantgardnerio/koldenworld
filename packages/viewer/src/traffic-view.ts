// Traffic in the viewer (decision 28): runs the sim on the loaded cells and
// turns its rows into instances to draw.
//
// - Each loaded cell with roads gets a slot (the sim's `cell` column). Edges of
//   different cells join where they share an OSM node, so the road network
//   spans cells without any global graph.
// - Cells near the camera are populated: the cars standing in their lanes
//   (placeVehicles) become sim cars, starting from rest. Cells beyond a larger
//   distance are dropped, and with them the cars on their roads; so are cars
//   that drive into a cell that isn't populated.
// - The sim runs at a fixed step, so a run depends only on its seed and inputs.
// - Poses are computed for cars in visible cells and written, already in the
//   view frame, into one instance array per model.

import { createCars, removeCars, Rng, spawnCar, stepTraffic, type Cars, type RoadNet } from "@game/sim";
import { edgeArcLengths, edgeLanes, lanePose, VEHICLE_MODELS, type RoadGraph, type VehiclePlacements } from "@game/world";
import type { CarInstances } from "./car-layer.ts";

const STEP = 1 / 30;     // s
const MAX_STEPS = 6;     // per frame: a stalled tab doesn't try to catch up

export interface TrafficCell {
  slot: number;
  graph: RoadGraph;
  cum: Float32Array;       // arc length at each point (edgeArcLengths)
  lengths: Float32Array;   // per edge
  placements: VehiclePlacements;
  model: Float32Array;     // the cell's live cell → view transform (owned by the renderer)
  populated: boolean;
  visible: boolean;        // set by the renderer each frame
}

export class TrafficView implements RoadNet {
  readonly cars: Cars = createCars(4096);
  simTime = 0;
  private rng: Rng;
  private slots: (TrafficCell | undefined)[] = [];
  private free: number[] = [];
  private nodes = new Map<number, number[]>();  // OSM node id → slot, node, slot, node, …
  private acc = 0;
  private pose = new Float32Array(6);

  constructor(seed: number) {
    this.rng = new Rng(seed);
  }

  /** Registers a loaded cell's roads. */
  add(graph: RoadGraph, placements: VehiclePlacements, model: Float32Array): TrafficCell {
    const slot = this.free.pop() ?? this.slots.length;
    const cum = edgeArcLengths(graph);
    const lengths = new Float32Array(graph.edges.count);
    for (let e = 0; e < graph.edges.count; e++) lengths[e] = cum[graph.edges.pointStart[e + 1]! - 1]!;
    const tc: TrafficCell = { slot, graph, cum, lengths, placements, model, populated: false, visible: false };
    this.slots[slot] = tc;
    for (let n = 0; n < graph.nodes.count; n++) {
      const id = graph.nodes.osmId[n]!;
      const list = this.nodes.get(id);
      if (list) list.push(slot, n);
      else this.nodes.set(id, [slot, n]);
    }
    return tc;
  }

  /** Unregisters a cell; its cars leave at the next update. */
  remove(tc: TrafficCell): void {
    for (let n = 0; n < tc.graph.nodes.count; n++) {
      const id = tc.graph.nodes.osmId[n]!, list = this.nodes.get(id)!;
      for (let k = list.length - 2; k >= 0; k -= 2) if (list[k] === tc.slot) list.splice(k, 2);
      if (list.length === 0) this.nodes.delete(id);
    }
    tc.populated = false;
    this.slots[tc.slot] = undefined;
    this.free.push(tc.slot);
  }

  // --- RoadNet -------------------------------------------------------------------

  length(cell: number, edge: number): number {
    return this.slots[cell]!.lengths[edge]!;
  }

  speedLimit(cell: number, edge: number): number {
    return this.slots[cell]!.graph.edges.speedLimit[edge]!;
  }

  lanes(cell: number, edge: number, dir: number): number {
    return edgeLanes(this.slots[cell]!.graph, edge, dir);
  }

  exits(cell: number, edge: number, dir: number, out: number[]): void {
    const g = this.slots[cell]!.graph;
    const node = dir > 0 ? g.edges.to[edge]! : g.edges.from[edge]!;
    const here = this.nodes.get(g.nodes.osmId[node]!);
    if (!here) return;
    for (let k = 0; k < here.length; k += 2) {
      const slot: number = here[k]!, n: number = here[k + 1]!;
      const tc: TrafficCell | undefined = this.slots[slot];
      if (!tc?.populated) continue;  // onward only into simulated cells; otherwise the car will leave
      const h: RoadGraph = tc.graph;
      for (let j: number = h.nodes.edgeStart[n]!; j < h.nodes.edgeStart[n + 1]!; j++) {
        const e: number = h.nodes.edgeList[j]!;
        if (h.edges.from[e] === n && h.edges.lanesFwd[e]! > 0) out.push(slot, e, 1);
        if (h.edges.to[e] === n && h.edges.lanesBack[e]! > 0) out.push(slot, e, -1);
      }
    }
  }

  // --- per frame -----------------------------------------------------------------

  /**
   * Populates cells within `near` m, drops those beyond `far`, removes cars
   * that left the populated cells, and advances the sim by dt (in fixed steps).
   */
  update(dt: number, distance: (tc: TrafficCell) => number, near: number, far: number, moving: boolean): void {
    for (const tc of this.slots) {
      if (!tc) continue;
      const d = distance(tc);
      if (!tc.populated && d < near) {
        tc.populated = true;
        const p = tc.placements;
        for (let i = 0; i < p.count; i++) {
          spawnCar(this.cars, this, { model: p.model[i]!, cell: tc.slot, edge: p.edge[i]!, dir: p.dir[i]!, lane: p.lane[i]!, s: p.s[i]! });
        }
      } else if (tc.populated && d > far) tc.populated = false;
    }
    removeCars(this.cars, (cell) => this.slots[cell]?.populated === true);
    if (!moving) return;
    this.acc = Math.min(this.acc + dt, MAX_STEPS * STEP);
    while (this.acc >= STEP) {
      stepTraffic(this.cars, this, STEP, this.rng);
      this.simTime += STEP;
      this.acc -= STEP;
    }
  }

  /** Writes the poses of cars in visible cells into per-model instance arrays, in the view frame. */
  instances(out: CarInstances): void {
    out.count.fill(0);
    const { model, cell, edge, dir, lane, s } = this.cars.c;
    const pose = this.pose;
    for (let i = 0; i < this.cars.count; i++) {
      const tc = this.slots[cell[i]!];
      if (!tc?.visible) continue;
      lanePose(tc.graph, tc.cum, edge[i]!, dir[i]!, lane[i]!, s[i]!, pose, 0);
      const m = tc.model, k = model[i]!;
      let data = out.data[k]!;
      const o = 6 * out.count[k]!++;
      if (o + 6 > data.length) {
        const grown = new Float32Array(data.length * 2);
        grown.set(data);
        out.data[k] = data = grown;
      }
      const [x, y, z, fx, fy, fz] = pose as unknown as [number, number, number, number, number, number];
      data[o] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
      data[o + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
      data[o + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
      data[o + 3] = m[0]! * fx + m[4]! * fy + m[8]! * fz;
      data[o + 4] = m[1]! * fx + m[5]! * fy + m[9]! * fz;
      data[o + 5] = m[2]! * fx + m[6]! * fy + m[10]! * fz;
    }
  }
}

export const emptyInstances = (): CarInstances => ({
  data: VEHICLE_MODELS.map(() => new Float32Array(6 * 256)),
  count: VEHICLE_MODELS.map(() => 0),
});
