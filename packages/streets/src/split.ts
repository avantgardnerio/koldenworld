// Streets as polygons: every node split into one copy per gap between its
// streets (by angle), on the gap's bisector, half width / sin(half the gap)
// out: where the curbs on either side of the gap meet. A dead end's two
// copies sit square to its street. Each street is the ring between its ends'
// copies (its sides offset by its half width, mitered at bends, starting at
// their corners: a bend a corner has already passed is left out, so no side
// doubles back through a corner); each intersection (3 or more streets) the
// ring through its copies. Neighbors share their copies as the same vertex.

import { concatRings, I32, RingsBuilder, type Rings, type Verts } from "./arrays.ts";
import type { Graph } from "./graph.ts";

const MITER = 4;  // a copy in a very sharp gap stops at this many half widths out

export interface StreetRings {
  rings: Rings;          // the streets' rings (one per street, in order), then the junctions'
  streetCount: number;
}

export function splitStreets(g: Graph, V: Verts): StreetRings {
  const S = g.streetCount, nEnds = 2 * S;
  // Street ends (end 2s is street s at a, 2s + 1 at b): their node and direction leaving it.
  const endNode = new Int32Array(nEnds), endDir = new Float64Array(nEnds);
  for (let s = 0; s < S; s++) {
    const p0 = g.pointStart[s]!, p1 = g.pointStart[s + 1]! - 1;
    endNode[2 * s] = g.a[s]!;
    endDir[2 * s] = Math.atan2(g.py[p0 + 1]! - g.py[p0]!, g.px[p0 + 1]! - g.px[p0]!);
    endNode[2 * s + 1] = g.b[s]!;
    endDir[2 * s + 1] = Math.atan2(g.py[p1 - 1]! - g.py[p1]!, g.px[p1 - 1]! - g.px[p1]!);
  }
  // Ends grouped by node (CSR).
  const nodeStart = new Int32Array(g.nodeCount + 1);
  for (let e = 0; e < nEnds; e++) nodeStart[endNode[e]! + 1]!++;
  for (let n = 0; n < g.nodeCount; n++) nodeStart[n + 1]! += nodeStart[n]!;
  const fill = nodeStart.slice(0, g.nodeCount), byNode = new Int32Array(nEnds);
  for (let e = 0; e < nEnds; e++) byNode[fill[endNode[e]!]!++] = e;

  const ccw = new Int32Array(nEnds), cw = new Int32Array(nEnds), junctions = new RingsBuilder();
  const copy = (n: number, angle: number, d: number) =>
    V.push(g.nx[n]! + Math.cos(angle) * d, g.ny[n]! + Math.sin(angle) * d, g.nz[n]!);
  const gap = new I32();
  for (let n = 0; n < g.nodeCount; n++) {
    const a = nodeStart[n]!, b = nodeStart[n + 1]!, deg = b - a;
    if (deg === 0) continue;
    if (deg === 1) {
      const e = byNode[a]!, hw = g.hw[e >> 1]!;
      ccw[e] = copy(n, endDir[e]! + Math.PI / 2, hw);
      cw[e] = copy(n, endDir[e]! - Math.PI / 2, hw);
      continue;
    }
    // Around the node by direction (insertion sort: a node has few ends).
    for (let i = a + 1; i < b; i++) {
      const e = byNode[i]!;
      let j = i - 1;
      while (j >= a && endDir[byNode[j]!]! > endDir[e]!) { byNode[j + 1] = byNode[j]!; j--; }
      byNode[j + 1] = e;
    }
    gap.length = 0;
    for (let i = a; i < b; i++) {
      const e = byNode[i]!, f = byNode[i + 1 < b ? i + 1 : a]!;
      const to = i + 1 < b ? endDir[f]! : endDir[f]! + 2 * Math.PI, half = (to - endDir[e]!) / 2;
      const hw = (g.hw[e >> 1]! + g.hw[f >> 1]!) / 2;
      gap.push(copy(n, endDir[e]! + half, Math.min(hw / Math.sin(half), MITER * hw)));
    }
    // An end's copy counterclockwise of it is the gap after it; clockwise, the gap before.
    for (let i = a; i < b; i++) {
      const e = byNode[i]!;
      ccw[e] = gap.data[i - a]!;
      cw[e] = gap.data[(i - a - 1 + deg) % deg]!;
    }
    if (deg >= 3) {
      for (let k = 0; k < deg; k++) junctions.add(gap.data[k]!);
      junctions.close();
    }
  }

  // Looking along a street from a to b, its left is counterclockwise of its direction at a, and
  // clockwise of the reverse direction at b.
  const streets = new RingsBuilder(), right = new I32();
  for (let s = 0; s < S; s++) {
    const A = 2 * s, B = 2 * s + 1;
    streets.add(ccw[A]!);
    offsets(g, s, g.hw[s]!, ccw[A]!, cw[B]!, V, streets, null);
    streets.add(cw[B]!);
    streets.add(ccw[B]!);
    right.length = 0;
    offsets(g, s, -g.hw[s]!, cw[A]!, ccw[B]!, V, null, right);
    for (let k = right.length - 1; k >= 0; k--) streets.add(right.data[k]!);
    streets.add(cw[A]!);
    streets.close();
  }
  return { rings: concatRings(streets.rings(), junctions.rings()), streetCount: S };
}

/**
 * Street s's inner points offset by d to its left, mitered: those between where the corner at its
 * start (`from`) and the corner at its end (`to`) sit along it. Appended as new vertices to `ring`
 * (or to `list`).
 */
function offsets(g: Graph, s: number, d: number, from: number, to: number, V: Verts, ring: RingsBuilder | null, list: I32 | null): void {
  const p0 = g.pointStart[s]!, p1 = g.pointStart[s + 1]!;
  if (p1 - p0 < 3) return;
  // How far along the street each corner sits, along its first or last segment.
  const along = (c: number, p: number, q: number) => {
    const dx = g.px[q]! - g.px[p]!, dy = g.py[q]! - g.py[p]!;
    return ((V.x(c) - g.px[p]!) * dx + (V.y(c) - g.py[p]!) * dy) / Math.hypot(dx, dy);
  };
  let total = 0;
  for (let p = p0 + 1; p < p1; p++) total += Math.hypot(g.px[p]! - g.px[p - 1]!, g.py[p]! - g.py[p - 1]!);
  const start = along(from, p0, p0 + 1), end = total - along(to, p1 - 1, p1 - 2);
  let at = 0;
  for (let p = p0 + 1; p < p1 - 1; p++) {
    at += Math.hypot(g.px[p]! - g.px[p - 1]!, g.py[p]! - g.py[p - 1]!);
    if (at <= start || at >= end) continue;
    const ax = g.px[p]! - g.px[p - 1]!, ay = g.py[p]! - g.py[p - 1]!, bx = g.px[p + 1]! - g.px[p]!, by = g.py[p + 1]! - g.py[p]!;
    const la = Math.hypot(ax, ay) || 1, lb = Math.hypot(bx, by) || 1;
    const n1x = -ay / la, n1y = ax / la, n2x = -by / lb, n2y = bx / lb;
    const mx = n1x + n2x, my = n1y + n2y, ml = Math.hypot(mx, my) || 1;
    const k = Math.min(MITER, 1 / Math.max(1 / MITER, (mx / ml) * n1x + (my / ml) * n1y));
    const v = V.push(g.px[p]! + (mx / ml) * d * k, g.py[p]! + (my / ml) * d * k, g.pz[p]!);
    if (ring) ring.add(v);
    else list!.push(v);
  }
}
