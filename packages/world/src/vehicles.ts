// Vehicles standing in their lanes (decision 27): a pure, deterministic
// placement per cell, before there is any traffic simulation. The same graph
// and seed always give the same cars.
//
// Right-hand traffic, lanes as in road-surface.ts: looking from → to, forward
// lanes are right of the boundary c = (back − fwd) · laneWidth / 2, backward
// lanes left of it. Cars keep clear of intersections, are spaced by road
// class with some randomness, point along their lane, and tilt with the road.

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
  model: Uint8Array;     // index into VEHICLE_MODELS
  position: Float32Array;  // x, y, z per car (center of the car on the road surface), in the graph's frame
  forward: Float32Array;   // x, y, z unit vector per car
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

export function placeVehicles(g: RoadGraph, seed: number): VehiclePlacements {
  const rand = rng(seed);
  const total = WEIGHTS.reduce((a, b) => a + b, 0);
  const pick = () => {
    let r = rand() * total, i = 0;
    while (r >= WEIGHTS[i]!) r -= WEIGHTS[i++]!;
    return i;
  };
  const radius = nodeRadii(g);
  const model: number[] = [], position: number[] = [], forward: number[] = [];

  for (let e = 0; e < g.edges.count; e++) {
    const cls = ROAD_CLASSES[g.edges.class[e]!]!;
    const { laneWidth: lw } = ROAD_PROFILES[cls];
    const fwd = g.edges.lanesFwd[e]!, back = g.edges.lanesBack[e]!;
    const p0 = g.edges.pointStart[e]!, p1 = g.edges.pointStart[e + 1]!;
    // Cumulative horizontal length at each point.
    const cum = [0];
    for (let p = p0 + 1; p < p1; p++) {
      cum.push(cum.at(-1)! + Math.hypot(g.points[2 * p]! - g.points[2 * p - 2]!, g.points[2 * p + 1]! - g.points[2 * p - 1]!));
    }
    const length = cum.at(-1)!;
    const a = radius[g.edges.from[e]!]! + CLEAR, b = length - radius[g.edges.to[e]!]! - CLEAR;
    if (b - a < 6) continue;
    const c = ((back - fwd) * lw) / 2;
    const lanes: [dir: 1 | -1, offset: number][] = [];
    for (let i = 0; i < fwd; i++) lanes.push([1, c + (i + 0.5) * lw]);
    for (let i = 0; i < back; i++) lanes.push([-1, c - (i + 0.5) * lw]);

    for (const [dir, offset] of lanes) {
      const gap = SPACING[cls];
      for (let s = a + rand() * gap; s < b; s += gap * (0.4 + 1.2 * rand())) {
        // The segment containing s.
        let k = 1;
        while (k < cum.length - 1 && cum[k]! < s) k++;
        const i0 = p0 + k - 1, i1 = p0 + k;
        const seg = cum[k]! - cum[k - 1]!, t = seg > 0 ? (s - cum[k - 1]!) / seg : 0;
        const x0 = g.points[2 * i0]!, y0 = g.points[2 * i0 + 1]!, z0 = g.pointZ[i0]!;
        const dx = g.points[2 * i1]! - x0, dy = g.points[2 * i1 + 1]! - y0, dz = g.pointZ[i1]! - z0;
        const len3 = Math.hypot(dx, dy, dz) || 1, len2 = Math.hypot(dx, dy) || 1;
        // Right of from → to is (dy, −dx); the lane offset is measured that way for both directions.
        model.push(pick());
        position.push(x0 + dx * t + (dy / len2) * offset, y0 + dy * t - (dx / len2) * offset, z0 + dz * t);
        forward.push((dir * dx) / len3, (dir * dy) / len3, (dir * dz) / len3);
      }
    }
  }
  return {
    count: model.length, model: Uint8Array.from(model), position: Float32Array.from(position), forward: Float32Array.from(forward),
  };
}
