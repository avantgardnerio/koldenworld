// Layers around the pavement by rubber band:
//
// 1. The pavement is one boolean: the union of every street and junction
//    polygon (a self-crossing polygon counts either way round).
// 2. Each further layer pushes the previous layer's loops out vertex by
//    vertex (vertex k of a loop becomes vertex k of the pushed loop), each
//    along its corner's bisector, as far as it takes to be d from both its
//    edges: a band of constant width, mitered, with no crossings between
//    layers to compute.
// 3. Each band is one more boolean: inside the pushed loops (either way round:
//    where a band folds over itself, the fold counts), minus inside the loops
//    it was pushed from (only where they wind positively: an inside-out fold
//    isn't cut away). It only does real work where a band folds.
//
// All in 2D: bridges and tunnels are polygons like any other here (each
// street keeps its layer for when heights come in).

import type { Graph, Point } from "./graph.ts";
import { slabs, type SlabResult } from "./slabs.ts";
import { splitStreets, unit } from "./split.ts";

const MITER = 4;

export interface Layers {
  pavement: SlabResult;
  bands: { width: number; loops: Point[][]; result: SlabResult }[];  // loops: the pushed loops, before clean-up
}

/**
 * Pushes loops (the result on their left, as slabs makes them) out to their right by d. Each vertex
 * goes out along its corner's bisector, as far as it takes to be d from both its edges, limited at
 * very sharp corners.
 */
export function push(loops: Point[][], d: number): Point[][] {
  return loops.map((loop) => loop.map((p, i) => {
    const a = loop[(i - 1 + loop.length) % loop.length]!, b = loop[(i + 1) % loop.length]!;
    const n1 = unit(p.y - a.y, -(p.x - a.x)), n2 = unit(b.y - p.y, -(b.x - p.x));
    const m = unit(n1.x + n2.x, n1.y + n2.y), k = Math.min(MITER, 1 / Math.max(1 / MITER, m.x * n1.x + m.y * n1.y));
    return { x: p.x + m.x * d * k, y: p.y + m.y * d * k };
  }));
}

/** The pavement, then a band per width, each pushed out from the last. */
export function layers(g: Graph, widths: number[]): Layers {
  const { streets, junctions } = splitStreets(g);
  const pavement = slabs([...streets, ...junctions.map((j) => j.ring)].map((p) => [p]), (w) => w.some((v) => v !== 0));
  const bands: Layers["bands"] = [];
  let inner = pavement.loops;
  for (const width of widths) {
    const outer = push(inner, width);
    bands.push({ width, loops: outer, result: slabs([outer, inner], (w) => w[0] !== 0 && !(w[1]! > 0)) });
    inner = outer;
  }
  return { pavement, bands };
}
