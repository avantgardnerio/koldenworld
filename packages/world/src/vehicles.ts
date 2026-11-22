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

// --- lane paths ----------------------------------------------------------------
//
// A car's path has no jumps in position or direction (decision 30):
// - Along a road, each lane is the centerline offset sideways with mitered
//   joints, as the road surface is drawn, so it bends without breaking.
// - Through a junction it leaves its lane where the lane meets the node's
//   disc and follows a curve (cubic Hermite, matching direction at both ends)
//   to its next lane where that one leaves the disc. The curve's reach on
//   each road is the disc's radius, at most half the road, so the curves at
//   the two ends of a short road never overlap.

/** A graph's lanes, computed once per graph: what lanePoint and junctionReach read. */
export interface LaneGeometry {
  graph: RoadGraph;
  cum: Float32Array;     // edgeArcLengths
  miter: Float32Array;   // per point: the mitered right-hand offset direction (x, y), scaled as in road-surface.ts
  radius: Float32Array;  // per node: its disc's radius (nodeRadii)
}

const MITER_LIMIT = 3;  // as the road surface's

export function laneGeometry(g: RoadGraph): LaneGeometry {
  const miter = new Float32Array(2 * g.pointZ.length);
  const unit = (a: number, b: number): [number, number] | undefined => {
    const dx = g.points[2 * b]! - g.points[2 * a]!, dy = g.points[2 * b + 1]! - g.points[2 * a + 1]!, l = Math.hypot(dx, dy);
    return l > 1e-3 ? [dx / l, dy / l] : undefined;
  };
  for (let e = 0; e < g.edges.count; e++) {
    const p0 = g.edges.pointStart[e]!, p1 = g.edges.pointStart[e + 1]!;
    for (let p = p0; p < p1; p++) {
      // The nearest non-degenerate segments before and after p (repeated points share them).
      let back: [number, number] | undefined, fwd: [number, number] | undefined;
      for (let q = p; q > p0 && !back; q--) back = unit(q - 1, q);
      for (let q = p; q < p1 - 1 && !fwd; q++) fwd = unit(q, q + 1);
      const b = back ?? fwd, f = fwd ?? back;
      if (!b || !f) continue;  // a zero-length edge
      const nx = b[1] + f[1], ny = -b[0] - f[0], nl = Math.hypot(nx, ny);
      if (nl < 1e-6) {  // a full reversal: no miter
        miter[2 * p] = f[1];
        miter[2 * p + 1] = -f[0];
        continue;
      }
      const cos = (nx / nl) * f[1] - (ny / nl) * f[0];
      const k = Math.min(1 / Math.max(cos, 1e-6), MITER_LIMIT);
      miter[2 * p] = (nx / nl) * k;
      miter[2 * p + 1] = (ny / nl) * k;
    }
  }
  return { graph: g, cum: edgeArcLengths(g), miter, radius: nodeRadii(g) };
}

/**
 * A point on a lane, written to out[o..o+6]: position (x, y, z, on the road
 * surface) and unit direction of travel (tilted with the road), in the
 * graph's frame. s is clamped to the edge.
 */
export function lanePoint(
  lg: LaneGeometry, e: number, dir: number, lane: number, s: number, out: Float32Array | Float64Array, o = 0,
): void {
  const { graph: g, cum, miter } = lg;
  const p0 = g.edges.pointStart[e]!, p1 = g.edges.pointStart[e + 1]! - 1;
  const length = cum[p1]!;
  const along = Math.min(length, Math.max(0, dir > 0 ? s : length - s));
  // Binary search for the segment [k − 1, k] containing `along`, skipping repeated points.
  let lo = p0 + 1, hi = p1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cum[mid]! < along) lo = mid + 1;
    else hi = mid;
  }
  while (lo < p1 && cum[lo] === cum[lo - 1]) lo++;
  const i0 = lo - 1, i1 = lo;
  const seg = cum[i1]! - cum[i0]!, t = seg > 0 ? (along - cum[i0]!) / seg : 0;
  const off = laneOffset(g, e, dir, lane);
  const x0 = g.points[2 * i0]! + miter[2 * i0]! * off, y0 = g.points[2 * i0 + 1]! + miter[2 * i0 + 1]! * off, z0 = g.pointZ[i0]!;
  const dx = g.points[2 * i1]! + miter[2 * i1]! * off - x0, dy = g.points[2 * i1 + 1]! + miter[2 * i1 + 1]! * off - y0;
  const dz = g.pointZ[i1]! - z0, len = Math.hypot(dx, dy, dz) || 1;
  out[o] = x0 + dx * t;
  out[o + 1] = y0 + dy * t;
  out[o + 2] = z0 + dz * t;
  out[o + 3] = (dir * dx) / len;
  out[o + 4] = (dir * dy) / len;
  out[o + 5] = (dir * dz) / len;
}

/** How far a junction curve reaches into an edge from its entry or exit node, m. */
export function junctionReach(lg: LaneGeometry, e: number, dir: number, end: "entry" | "exit"): number {
  const g = lg.graph, atFrom = (dir > 0) === (end === "entry");
  const length = lg.cum[g.edges.pointStart[e + 1]! - 1]!;
  return Math.min(lg.radius[atFrom ? g.edges.from[e]! : g.edges.to[e]!]!, length / 2);
}

/**
 * A point on the junction curve from a to b (each a position and unit
 * direction, as lanePoint writes them, in one frame) at u ∈ [0, 1], written
 * to out[o..o+3]. The ends' tangents grow from the chord (straight on) to
 * twice it (a U-turn), so turns stay round.
 */
export function turnPoint(
  a: ArrayLike<number>, b: ArrayLike<number>, u: number, out: Float32Array | Float64Array, o = 0,
): void {
  const chord = Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!);
  const cos = a[3]! * b[3]! + a[4]! * b[4]! + a[5]! * b[5]!;
  const k = chord * (1.5 - 0.5 * cos);
  const u2 = u * u, u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1, h10 = (u3 - 2 * u2 + u) * k, h01 = -2 * u3 + 3 * u2, h11 = (u3 - u2) * k;
  for (let j = 0; j < 3; j++) out[o + j] = h00 * a[j]! + h10 * a[3 + j]! + h01 * b[j]! + h11 * b[3 + j]!;
}
