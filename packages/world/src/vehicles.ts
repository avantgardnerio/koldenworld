// Vehicles on the road graph (decision 27): where cars start in a cell, and
// where a car at a lane coordinate is in space. Pure and deterministic: the
// same graph and seed always give the same cars.
//
// A lane coordinate is (edge, dir, lane, s): dir +1 travels from → to, −1
// to → from; lane counts from the left of the travel direction (0 is next to
// the center line); s is meters travelled from the entry node. Right-hand
// traffic, lanes as in road-surface.ts: looking from → to, forward lanes lie
// right of the boundary c = (back − fwd) · laneWidth / 2, backward lanes left.

import { nodeRadii, ROAD_PROFILES } from "./road-surface.ts";
import { ROAD_CLASSES, type RoadClass, type RoadGraph } from "./road-graph.ts";

/** The models, in the order placements refer to them. */
export const VEHICLE_MODELS = [
  "sedan", "sedan-sports", "hatchback-sports", "suv", "suv-luxury", "van", "truck", "delivery", "taxi", "police",
] as const;
export type VehicleModel = (typeof VEHICLE_MODELS)[number];
const WEIGHTS = [25, 8, 10, 20, 8, 8, 12, 4, 3, 2];

/** Kenney's models are toy-sized (a sedan is 2.55 units long): this makes a sedan ~4.7 m. */
export const VEHICLE_SCALE = 1.85;

/** Average gap between cars in one lane, m, by class: busy roads are fuller. */
const SPACING: Record<RoadClass, number> = {
  motorway: 60, motorway_link: 80, trunk: 60, trunk_link: 80, primary: 45, primary_link: 70,
  secondary: 55, secondary_link: 80, tertiary: 70, tertiary_link: 90,
  unclassified: 150, residential: 110, living_street: 150, service: 250, road: 200,
};
const CLEAR = 4;  // m kept free beyond an intersection disc

export interface VehiclePlacements {
  count: number;
  model: Uint8Array;  // index into VEHICLE_MODELS
  edge: Uint32Array;
  dir: Int8Array;
  lane: Uint8Array;
  s: Float32Array;
}

/** mulberry32 */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    let t = (s = (s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Lanes in a direction: lanesFwd for +1, lanesBack for −1. */
export const edgeLanes = (g: RoadGraph, e: number, dir: number) => (dir > 0 ? g.edges.lanesFwd[e]! : g.edges.lanesBack[e]!);

/** Where cars start in a cell: spaced by road class along every lane, clear of intersections. */
export function placeVehicles(g: RoadGraph, seed: number): VehiclePlacements {
  const rand = rng(seed);
  const total = WEIGHTS.reduce((a, b) => a + b, 0);
  const pick = () => {
    let r = rand() * total, i = 0;
    while (r >= WEIGHTS[i]!) r -= WEIGHTS[i++]!;
    return i;
  };
  const radius = nodeRadii(g);
  const out = { model: [] as number[], edge: [] as number[], dir: [] as number[], lane: [] as number[], s: [] as number[] };
  for (let e = 0; e < g.edges.count; e++) {
    const gap = SPACING[ROAD_CLASSES[g.edges.class[e]!]!];
    const length = g.edges.length[e]!;
    for (const dir of [1, -1]) {
      // From the entry node in this direction: clear of the disc there, and of the one at the far end.
      const a = radius[dir > 0 ? g.edges.from[e]! : g.edges.to[e]!]! + CLEAR;
      const b = length - radius[dir > 0 ? g.edges.to[e]! : g.edges.from[e]!]! - CLEAR;
      for (let lane = 0; lane < edgeLanes(g, e, dir) && b - a >= 6; lane++) {
        for (let s = a + rand() * gap; s < b; s += gap * (0.4 + 1.2 * rand())) {
          out.model.push(pick());
          out.edge.push(e);
          out.dir.push(dir);
          out.lane.push(lane);
          out.s.push(s);
        }
      }
    }
  }
  return {
    count: out.model.length, model: Uint8Array.from(out.model), edge: Uint32Array.from(out.edge),
    dir: Int8Array.from(out.dir), lane: Uint8Array.from(out.lane), s: Float32Array.from(out.s),
  };
}

/**
 * Horizontal distance along each edge at each of its points (restarting at 0
 * on every edge), indexed like graph points. Edge e's length is the value at
 * its last point.
 */
export function edgeArcLengths(g: RoadGraph): Float32Array {
  const cum = new Float32Array(g.pointZ.length);
  for (let e = 0; e < g.edges.count; e++) {
    for (let p = g.edges.pointStart[e]! + 1; p < g.edges.pointStart[e + 1]!; p++) {
      cum[p] = cum[p - 1]! + Math.hypot(g.points[2 * p]! - g.points[2 * p - 2]!, g.points[2 * p + 1]! - g.points[2 * p - 1]!);
    }
  }
  return cum;
}

/** Lateral offset of a lane's center, right of from → to positive. */
export function laneOffset(g: RoadGraph, e: number, dir: number, lane: number): number {
  const lw = ROAD_PROFILES[ROAD_CLASSES[g.edges.class[e]!]!].laneWidth;
  const c = ((g.edges.lanesBack[e]! - g.edges.lanesFwd[e]!) * lw) / 2;
  return dir > 0 ? c + (lane + 0.5) * lw : c - (lane + 0.5) * lw;
}

/**
 * The pose of a car at a lane coordinate, written to out[o..o+6]: position
 * (x, y, z, on the road surface) and unit forward vector (tilted with the
 * road), in the graph's frame.
 */
export function lanePose(
  g: RoadGraph, cum: Float32Array, e: number, dir: number, lane: number, s: number, out: Float32Array, o: number,
): void {
  const p0 = g.edges.pointStart[e]!, p1 = g.edges.pointStart[e + 1]! - 1;
  const length = cum[p1]!;
  const along = Math.min(length, Math.max(0, dir > 0 ? s : length - s));
  // Binary search for the segment [k − 1, k] containing `along`.
  let lo = p0 + 1, hi = p1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cum[mid]! < along) lo = mid + 1;
    else hi = mid;
  }
  const i0 = lo - 1, i1 = lo;
  const seg = cum[i1]! - cum[i0]!, t = seg > 0 ? (along - cum[i0]!) / seg : 0;
  const x0 = g.points[2 * i0]!, y0 = g.points[2 * i0 + 1]!, z0 = g.pointZ[i0]!;
  const dx = g.points[2 * i1]! - x0, dy = g.points[2 * i1 + 1]! - y0, dz = g.pointZ[i1]! - z0;
  const len2 = Math.hypot(dx, dy) || 1, len3 = Math.hypot(dx, dy, dz) || 1;
  const off = laneOffset(g, e, dir, lane);
  // Right of from → to is (dy, −dx).
  out[o] = x0 + dx * t + (dy / len2) * off;
  out[o + 1] = y0 + dy * t - (dx / len2) * off;
  out[o + 2] = z0 + dz * t;
  out[o + 3] = (dir * dx) / len3;
  out[o + 4] = (dir * dy) / len3;
  out[o + 5] = (dir * dz) / len3;
}
