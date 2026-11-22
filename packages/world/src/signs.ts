// Street name signs (decision 35): one per intersection, on the corner between
// two differently named streets, standing in the grass strip just behind the
// curb. Its spot comes from the same rule as the street polygons' corners
// (@game/streets): along the gap's bisector, as far as it takes to be the
// same distance from both streets' centerlines; here, their half widths plus
// SIGN_SETBACK. Two blades, each along the street it names.
//
// Pure: the viewer turns these into a mesh.

import type { RoadGraph } from "./road-graph.ts";
import { edgeHalfWidth } from "./road-surface.ts";

/** m behind the curb: the middle of the grass strip. */
export const SIGN_SETBACK = 0.75;
const MITER = 4;

export interface StreetSign {
  x: number;
  y: number;
  z: number;        // the ground at its foot (the road's height there), in the graph's frame
  blades: { text: string; dir: number }[];  // dir: radians, the street's direction from the corner's node
}

const WORDS: Record<string, string> = {
  North: "N", South: "S", East: "E", West: "W", Northeast: "NE", Northwest: "NW", Southeast: "SE", Southwest: "SW",
  Street: "St", Avenue: "Ave", Boulevard: "Blvd", Drive: "Dr", Road: "Rd", Lane: "Ln", Court: "Ct", Place: "Pl",
  Parkway: "Pkwy", Highway: "Hwy", Circle: "Cir", Terrace: "Ter", Way: "Way", Trail: "Trl", Square: "Sq",
};

/** A street name as US signs show it: "East 7th Avenue" → "E 7th Ave". */
export const signText = (name: string) => name.split(" ").map((w) => WORDS[w] ?? w).join(" ");

/** The signs at the intersections `owns` accepts (by node position in the graph's frame). */
export function streetSigns(g: RoadGraph, owns: (x: number, y: number) => boolean): StreetSign[] {
  const out: StreetSign[] = [];
  for (let n = 0; n < g.nodes.count; n++) {
    const first = g.nodes.edgeStart[n]!, last = g.nodes.edgeStart[n + 1]!;
    if (last - first < 3) continue;
    const x0 = g.nodes.x[n]!, y0 = g.nodes.y[n]!;
    if (!owns(x0, y0)) continue;
    // The streets leaving this node, by direction (from their first segment), with their names.
    const ends: { dir: number; name: string; hw: number }[] = [];
    for (let k = first; k < last; k++) {
      const e = g.nodes.edgeList[k]!, p0 = g.edges.pointStart[e]!, p1 = g.edges.pointStart[e + 1]! - 1;
      const [p, q] = g.edges.from[e] === n ? [p0, p0 + 1] : [p1, p1 - 1];
      const dir = Math.atan2(g.points[2 * q + 1]! - g.points[2 * p + 1]!, g.points[2 * q]! - g.points[2 * p]!);
      ends.push({ dir, name: g.names[g.edges.name[e]!] ?? "", hw: edgeHalfWidth(g, e) });
    }
    ends.sort((a, b) => a.dir - b.dir);
    // The corners between two differently named streets; of those, the one facing most south-east.
    let best: { score: number; sign: StreetSign } | undefined;
    ends.forEach((a, i) => {
      const b = ends[(i + 1) % ends.length]!, to = i + 1 < ends.length ? b.dir : b.dir + 2 * Math.PI;
      if (!a.name || !b.name || a.name === b.name) return;
      const half = (to - a.dir) / 2, mid = a.dir + half, reach = (a.hw + b.hw) / 2 + SIGN_SETBACK;
      const d = Math.min(reach / Math.sin(half), MITER * reach);
      const score = Math.cos(mid + Math.PI / 4);
      if (best && best.score >= score) return;
      best = {
        score,
        sign: {
          x: x0 + Math.cos(mid) * d, y: y0 + Math.sin(mid) * d, z: g.nodes.z[n]!,
          blades: [{ text: signText(a.name), dir: a.dir }, { text: signText(b.name), dir: b.dir }],
        },
      };
    });
    if (best) out.push(best.sign);
  }
  return out;
}
