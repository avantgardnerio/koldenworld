// Road widths: how far each road reaches either side of its centerline, from its class's lane width and shoulder,
// and its sidewalks (decision 33). Used by draping (how much ground a road covers), the street polygons, vehicles and
// signs. The cell's drawn ground, markings included, comes from the Rust generator (crates/cellgen).
//
// Cross-section of an edge, looking along from → to (right-hand traffic; the forward lanes are on the right):
//
//   shoulder | back lanes … ‖ forward lanes … | shoulder
//                           c = (back − fwd) · laneWidth / 2

import { ROAD_CLASSES, type RoadClass, type RoadGraph } from "./road-graph.ts";



interface Profile { laneWidth: number; shoulder: number; markings: boolean }

const P = (laneWidth: number, shoulder: number, markings: boolean): Profile => ({ laneWidth, shoulder, markings });
export const ROAD_PROFILES: Record<RoadClass, Profile> = {
  motorway: P(3.7, 2.5, true), motorway_link: P(3.7, 1.5, true),
  trunk: P(3.6, 1.5, true), trunk_link: P(3.6, 1.0, true),
  primary: P(3.4, 1.0, true), primary_link: P(3.4, 0.5, true),
  secondary: P(3.4, 1.0, true), secondary_link: P(3.4, 0.5, true),
  tertiary: P(3.3, 1.0, true), tertiary_link: P(3.3, 0.5, true),
  unclassified: P(3.0, 1.0, false), residential: P(3.0, 1.0, false), living_street: P(3.0, 0.5, false),
  service: P(2.8, 0.2, false), road: P(3.0, 0.5, false),
};
const PROFILES = ROAD_CLASSES.map((c) => ROAD_PROFILES[c]);


export const SIDEWALK = {
  width: 1.8,  // m: 5 ft plus the curb
  curb: 0.15,  // m above the road
} as const;


export function edgeHalfWidth(g: RoadGraph, e: number): number {
  const p = PROFILES[g.edges.class[e]!]!;
  return ((g.edges.lanesFwd[e]! + g.edges.lanesBack[e]!) * p.laneWidth) / 2 + p.shoulder;
}

/** How far the road reaches left and right of its centerline (looking from → to), sidewalks included. */
export function edgeExtents(g: RoadGraph, e: number): [left: number, right: number] {
  const hw = edgeHalfWidth(g, e), s = g.edges.sidewalks[e]!;
  return [hw + (s & 1 ? SIDEWALK.width : 0), hw + (s & 2 ? SIDEWALK.width : 0)];
}

/** Per node: the widest half width of its incident edges (the intersection disc radius). */
export function nodeRadii(g: RoadGraph): Float32Array {
  const r = new Float32Array(g.nodes.count);
  for (let e = 0; e < g.edges.count; e++) {
    const hw = edgeHalfWidth(g, e);
    for (const n of [g.edges.from[e]!, g.edges.to[e]!]) if (hw > r[n]!) r[n] = hw;
  }
  return r;
}
