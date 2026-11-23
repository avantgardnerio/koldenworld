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
//   view frame, into one instance array per model. A car's path runs from
//   the road it came from through its own to the one it takes next, turning
//   through the junctions between (decision 30); it stands at its point on
//   the path, facing from a point half a wheelbase behind to one half a
//   wheelbase ahead, so it turns smoothly through bends and junctions alike.
//   Path points on different cells' roads meet in the view frame.
// - Cars notice the player's car (yieldTo): one with it ahead in its path
//   slows to stop short of it, and the cars near it are handed back as
//   rectangles for its collisions.

import { BRAKING, createCars, NONE, removeCars, Rng, spawnCar, stepTraffic, type Cars, type RoadNet } from "@game/sim";
import {
  edgeLanes, junctionReach, laneGeometry, lanePoint, turnPoint, VEHICLE_MODELS,
  type LaneGeometry, type RoadGraph, type VehiclePlacements,
} from "@game/world";
import type { CarInstances } from "./car-layer.ts";

const STEP = 1 / 30;     // s
const MAX_STEPS = 6;     // per frame: a stalled tab doesn't try to catch up
const HALF_WHEELBASE = 1.35;  // m
/**
 * Yielding to the player's car: a car stops this far short of it (m, bumper to bumper, a car being CAR_LENGTH long),
 * looking this far either side of its own line (m, about a lane), at cars this near (m) and in cells this near (m).
 */
export const YIELD = { gap: 4, half: 2.2, near: 80, cells: 1500 };
const CAR_LENGTH = 4.7;
/** A traffic car's rectangle for collisions: half length, half width (m). */
export const CAR_HALF = [2.35, 1.0] as const;

export interface TrafficCell {
  slot: number;
  graph: RoadGraph;
  lanes: LaneGeometry;
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
  // Scratch for path points: two lane points (position, direction) and three path points.
  private a = new Float64Array(6);
  private b = new Float64Array(6);
  private rear = new Float64Array(3);
  private mid = new Float64Array(3);
  private front = new Float64Array(3);

  constructor(seed: number) {
    this.rng = new Rng(seed);
  }

  /** Registers a loaded cell's roads. */
  add(graph: RoadGraph, placements: VehiclePlacements, model: Float32Array): TrafficCell {
    const slot = this.free.pop() ?? this.slots.length;
    const lanes = laneGeometry(graph);
    const lengths = new Float32Array(graph.edges.count);
    for (let e = 0; e < graph.edges.count; e++) lengths[e] = lanes.cum[graph.edges.pointStart[e + 1]! - 1]!;
    const tc: TrafficCell = { slot, graph, lanes, lengths, placements, model, populated: false, visible: false };
    this.slots[slot] = tc;
    for (let n = 0; n < graph.nodes.count; n++) {
      const id = graph.nodes.osmId[n]!;
      const list = this.nodes.get(id);
      if (list) list.push(slot, n);
      else this.nodes.set(id, [slot, n]);
    }
    return tc;
  }

  /**
   * Unregisters a cell. Its cars leave now, before the slot can be reused,
   * and other cars forget it as the road they came from or take next (so
   * one that was turning into it leaves at the end of its road).
   */
  remove(tc: TrafficCell): void {
    for (let n = 0; n < tc.graph.nodes.count; n++) {
      const id = tc.graph.nodes.osmId[n]!, list = this.nodes.get(id)!;
      for (let k = list.length - 2; k >= 0; k -= 2) if (list[k] === tc.slot) list.splice(k, 2);
      if (list.length === 0) this.nodes.delete(id);
    }
    removeCars(this.cars, (cell) => cell !== tc.slot);
    const { pcell, ncell } = this.cars.c;
    for (let i = 0; i < this.cars.count; i++) {
      if (pcell[i] === tc.slot) pcell[i] = NONE;
      if (ncell[i] === tc.slot) ncell[i] = NONE;
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
          spawnCar(this.cars, this, { model: p.model[i]!, cell: tc.slot, edge: p.edge[i]!, dir: p.dir[i]!, lane: p.lane[i]!, s: p.s[i]! }, this.rng);
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

  /**
   * Cars notice the player's car (`me`, in the view frame; undefined: there's none): a car with it ahead in its path
   * (in front, within YIELD.half of its line) is capped to the speed it can still stop at YIELD.gap short of it; every
   * other car's cap is lifted. The cars within YIELD.near of it are written into `near` (center x, y, z, forward x, y,
   * view frame; as many as fit); returns how many.
   */
  yieldTo(me: readonly number[] | undefined, near: Float64Array): number {
    const { cap, cell } = this.cars.c;
    cap.fill(Infinity, 0, this.cars.count);
    if (!me) return 0;
    const { rear, mid, front } = this;
    let n = 0;
    for (let i = 0; i < this.cars.count; i++) {
      const m = this.slots[cell[i]!]?.model;
      if (!m || Math.hypot(m[12]! - me[0]!, m[13]! - me[1]!) > YIELD.cells) continue;
      this.pathPoint(i, 0, mid);
      const dx = me[0]! - mid[0]!, dy = me[1]! - mid[1]!;
      if (Math.hypot(dx, dy) > YIELD.near) continue;
      this.pathPoint(i, -HALF_WHEELBASE, rear);
      this.pathPoint(i, HALF_WHEELBASE, front);
      const fl = Math.hypot(front[0]! - rear[0]!, front[1]! - rear[1]!) || 1;
      const fx = (front[0]! - rear[0]!) / fl, fy = (front[1]! - rear[1]!) / fl;
      const ahead = dx * fx + dy * fy, aside = Math.abs(dx * fy - dy * fx);
      if (ahead > 0 && aside < YIELD.half) cap[i] = Math.sqrt(2 * BRAKING * Math.max(0, ahead - CAR_LENGTH - YIELD.gap));
      if (5 * n + 5 <= near.length) near.set([mid[0]!, mid[1]!, mid[2]!, fx, fy], 5 * n++);
    }
    return n;
  }

  /** Writes the poses of cars in visible cells into per-model instance arrays, in the view frame. */
  instances(out: CarInstances): void {
    out.count.fill(0);
    const { model, cell } = this.cars.c;
    const { rear, mid, front } = this;
    for (let i = 0; i < this.cars.count; i++) {
      if (!this.slots[cell[i]!]?.visible) continue;
      this.pathPoint(i, -HALF_WHEELBASE, rear);
      this.pathPoint(i, 0, mid);
      this.pathPoint(i, HALF_WHEELBASE, front);
      const k = model[i]!;
      let data = out.data[k]!;
      const o = 6 * out.count[k]!++;
      if (o + 6 > data.length) {
        const grown = new Float32Array(data.length * 2);
        grown.set(data);
        out.data[k] = data = grown;
      }
      const fx = front[0]! - rear[0]!, fy = front[1]! - rear[1]!, fz = front[2]! - rear[2]!, fl = Math.hypot(fx, fy, fz) || 1;
      data[o] = mid[0]!;
      data[o + 1] = mid[1]!;
      data[o + 2] = mid[2]!;
      data[o + 3] = fx / fl;
      data[o + 4] = fy / fl;
      data[o + 5] = fz / fl;
    }
  }

  /**
   * The point on car i's path ds m ahead of it (behind, if negative), in the
   * view frame. The path is the road it came from, its own and the one it
   * takes next, with junction curves between; past their ends it stops.
   */
  private pathPoint(i: number, ds: number, out: Float64Array): void {
    const c = this.cars.c;
    // (cell, edge, dir, lane) before, on and after the road the point is on; cell −1: none.
    let pc = c.pcell[i] === NONE ? -1 : c.pcell[i]!, pe = c.pedge[i]!, pd = c.pdir[i]!, pl = c.plane[i]!;
    let cc = c.cell[i]!, ce = c.edge[i]!, cd = c.dir[i]!, cl = c.lane[i]!;
    let nc = c.ncell[i] === NONE ? -1 : c.ncell[i]!, ne = c.nedge[i]!, nd = c.ndir[i]!, nl = c.nlane[i]!;
    let s = c.s[i]! + ds;
    if (s < 0 && pc >= 0) {
      [nc, ne, nd, nl, cc, ce, cd, cl] = [cc, ce, cd, cl, pc, pe, pd, pl];
      pc = -1;
      s += this.length(cc, ce);
    } else if (s > c.length[i]! && nc >= 0) {
      s -= c.length[i]!;
      [pc, pe, pd, pl, cc, ce, cd, cl] = [cc, ce, cd, cl, nc, ne, nd, nl];
      nc = -1;
    }
    const here = this.slots[cc]!.lanes, length = this.length(cc, ce);
    const rIn = pc >= 0 ? junctionReach(here, ce, cd, "entry") : 0;
    const rOut = nc >= 0 ? junctionReach(here, ce, cd, "exit") : 0;
    if (pc >= 0 && s < rIn) {
      // Turning in from the road before: its curve reaches back rA along that road.
      const rA = junctionReach(this.slots[pc]!.lanes, pe, pd, "exit");
      this.lanePoint(pc, pe, pd, pl, this.length(pc, pe) - rA, this.a);
      this.lanePoint(cc, ce, cd, cl, rIn, this.b);
      turnPoint(this.a, this.b, (rA + s) / (rA + rIn), out);
    } else if (nc >= 0 && s > length - rOut) {
      const rB = junctionReach(this.slots[nc]!.lanes, ne, nd, "entry");
      this.lanePoint(cc, ce, cd, cl, length - rOut, this.a);
      this.lanePoint(nc, ne, nd, nl, rB, this.b);
      turnPoint(this.a, this.b, (s - (length - rOut)) / (rOut + rB), out);
    } else {
      this.lanePoint(cc, ce, cd, cl, s, this.a);
      out[0] = this.a[0]!;
      out[1] = this.a[1]!;
      out[2] = this.a[2]!;
    }
  }

  /** A lane point (position, direction) of a cell's edge, in the view frame. */
  private lanePoint(cell: number, edge: number, dir: number, lane: number, s: number, out: Float64Array): void {
    const tc = this.slots[cell]!, m = tc.model;
    lanePoint(tc.lanes, edge, dir, lane, s, out);
    const x = out[0]!, y = out[1]!, z = out[2]!, fx = out[3]!, fy = out[4]!, fz = out[5]!;
    out[0] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
    out[1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
    out[2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
    out[3] = m[0]! * fx + m[4]! * fy + m[8]! * fz;
    out[4] = m[1]! * fx + m[5]! * fy + m[9]! * fz;
    out[5] = m[2]! * fx + m[6]! * fy + m[10]! * fz;
  }
}

export const emptyInstances = (): CarInstances => ({
  data: VEHICLE_MODELS.map(() => new Float32Array(6 * 256)),
  count: VEHICLE_MODELS.map(() => 0),
});
