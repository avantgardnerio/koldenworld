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

import { concatRings, ringCount, RingsBuilder, Verts, type Rings } from "./arrays.ts";
import type { Graph } from "./graph.ts";
import { slabs, type SlabResult } from "./slabs.ts";
import { splitStreets } from "./split.ts";

const MITER = 4;

export interface Layers {
  V: Verts;              // every vertex the layers use
  pavement: SlabResult;
  bands: { width: number; loops: Rings; result: SlabResult }[];  // loops: the pushed loops, before clean-up
}

/**
 * Pushes loops (the result on their left, as slabs makes them) out to their right by d: a new vertex
 * per vertex, along its corner's bisector, as far as it takes to be d from both its edges (limited
 * at very sharp corners).
 */
export function push(V: Verts, loops: Rings, d: number): Rings {
  const out = new RingsBuilder();
  for (let r = 0; r < ringCount(loops); r++) {
    const a = loops.start[r]!, b = loops.start[r + 1]!, n = b - a;
    for (let k = 0; k < n; k++) {
      const p = loops.verts[a + k]!, prev = loops.verts[a + (k - 1 + n) % n]!, next = loops.verts[a + (k + 1) % n]!;
      const ax = V.x(p) - V.x(prev), ay = V.y(p) - V.y(prev), bx = V.x(next) - V.x(p), by = V.y(next) - V.y(p);
      const la = Math.hypot(ax, ay) || 1, lb = Math.hypot(bx, by) || 1;
      const n1x = ay / la, n1y = -ax / la, n2x = by / lb, n2y = -bx / lb;  // to the right of travel
      const mx = n1x + n2x, my = n1y + n2y, ml = Math.hypot(mx, my) || 1;
      const k2 = Math.min(MITER, 1 / Math.max(1 / MITER, (mx / ml) * n1x + (my / ml) * n1y));
      out.add(V.push(V.x(p) + (mx / ml) * d * k2, V.y(p) + (my / ml) * d * k2, V.z(p)));
    }
    out.close();
  }
  return out.rings();
}

const identity = (n: number) => {
  const a = new Int32Array(n);
  for (let k = 0; k < n; k++) a[k] = k;
  return a;
};

/** The pavement, then a band per width, each pushed out from the last. */
export function layers(g: Graph, widths: number[], V = new Verts()): Layers {
  const { rings } = splitStreets(g, V);
  const n = ringCount(rings);
  // Every street and junction its own polygon, one operand: inside any of them, either way round.
  const pavement = slabs(V, rings, identity(n), new Int32Array(n), 1, (nz) => nz[0]! > 0);
  const bands: Layers["bands"] = [];
  let inner = pavement.loops;
  for (const width of widths) {
    const outer = push(V, inner, width);
    const no = ringCount(outer), ni = ringCount(inner);
    const ringPoly = new Int32Array(no + ni).fill(1, no);  // the pushed loops are polygon 0, the inner ones polygon 1
    const result = slabs(V, concatRings(outer, inner), ringPoly, Int32Array.of(0, 1), 2, (nz, pos) => nz[0]! > 0 && pos[1] === 0);
    bands.push({ width, loops: outer, result });
    inner = outer;
  }
  return { V, pavement, bands };
}
