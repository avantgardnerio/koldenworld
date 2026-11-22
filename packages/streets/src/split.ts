// Streets as polygons: every node split into one copy per gap between its
// streets (by angle), on the gap's bisector, half width / sin(half the gap)
// out: where the curbs on either side of the gap meet. A dead end's two
// copies sit square to its street. Each street is the polygon between its
// ends' copies (its sides offset by its half width, mitered at bends); each
// intersection (3 or more streets) the polygon through its copies. Neighbors
// share their copies as the same point objects.

import type { Graph, Point } from "./graph.ts";

const MITER = 4;  // a copy in a very sharp gap stops at this many half widths out

export interface StreetPolygons {
  streets: Point[][];    // per street: its left side a to b, then its right side back
  junctions: Point[][];  // per node of 3 or more streets: its copies in order around it
}

export function splitStreets(g: Graph): StreetPolygons {
  const ends = new Map<number, { dir: number; street: number; end: "a" | "b" }[]>();
  g.streets.forEach((s, si) => {
    for (const end of ["a", "b"] as const) {
      const n = s[end], p = end === "a" ? s.pts[0]! : s.pts.at(-1)!, q = end === "a" ? s.pts[1]! : s.pts.at(-2)!;
      if (!ends.has(n)) ends.set(n, []);
      ends.get(n)!.push({ dir: Math.atan2(q.y - p.y, q.x - p.x), street: si, end });
    }
  });
  const beside = new Map<string, { ccw: Point; cw: Point }>(), junctions: Point[][] = [];
  const copy = (n: number, angle: number, d: number): Point =>
    ({ x: g.nodes[n]!.x + Math.cos(angle) * d, y: g.nodes[n]!.y + Math.sin(angle) * d });
  for (const [n, list] of ends) {
    if (list.length === 1) {
      const { dir, street, end } = list[0]!, hw = g.streets[street]!.hw;
      beside.set(`${street}${end}`, { ccw: copy(n, dir + Math.PI / 2, hw), cw: copy(n, dir - Math.PI / 2, hw) });
      continue;
    }
    list.sort((p, q) => p.dir - q.dir);
    const gap = list.map((e, i) => {
      const next = list[(i + 1) % list.length]!, to = i + 1 < list.length ? next.dir : next.dir + 2 * Math.PI;
      const half = (to - e.dir) / 2, hw = (g.streets[e.street]!.hw + g.streets[next.street]!.hw) / 2;
      return copy(n, e.dir + half, Math.min(hw / Math.sin(half), MITER * hw));
    });
    // An end's copy counterclockwise of it is the gap after it; clockwise, the gap before.
    list.forEach((e, i) => beside.set(`${e.street}${e.end}`, { ccw: gap[i]!, cw: gap[(i - 1 + list.length) % list.length]! }));
    if (list.length >= 3) junctions.push(gap);
  }
  // Looking along a street from a to b, its left is counterclockwise of its direction at a, and
  // clockwise of the reverse direction at b. Each side runs from its corner at a to its corner at b,
  // through the bends between them: a bend a corner has already passed (a narrow gap puts its corner
  // far along the street) is left out, so no side ever doubles back through a corner.
  const streets = g.streets.map((s, si) => {
    const A = beside.get(`${si}a`)!, B = beside.get(`${si}b`)!;
    const left = offsets(s.pts, s.hw, A.ccw, B.cw), right = offsets(s.pts, -s.hw, A.cw, B.ccw);
    return [A.ccw, ...left, B.cw, B.ccw, ...right.reverse(), A.cw];
  });
  return { streets, junctions };
}

/**
 * A polyline's inner points offset by d to its left, mitered: the ones between where the corner
 * at its start (`from`) and the corner at its end (`to`) sit along it.
 */
function offsets(pts: Point[], d: number, from: Point, to: Point): Point[] {
  // Distance along the street of each point, and of each corner (along the street's first or last segment).
  const s = [0];
  for (let i = 1; i < pts.length; i++) s.push(s[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y));
  const along = (c: Point, p: Point, q: Point) => {
    const dx = q.x - p.x, dy = q.y - p.y;
    return ((c.x - p.x) * dx + (c.y - p.y) * dy) / Math.hypot(dx, dy);
  };
  const start = along(from, pts[0]!, pts[1]!), end = s.at(-1)! - along(to, pts.at(-1)!, pts.at(-2)!);
  const out: Point[] = [];
  for (let i = 1; i < pts.length - 1; i++) {
    if (s[i]! <= start || s[i]! >= end) continue;
    const p = pts[i]!, a = pts[i - 1]!, b = pts[i + 1]!;
    const n1 = unit(-(p.y - a.y), p.x - a.x), n2 = unit(-(b.y - p.y), b.x - p.x);
    const m = unit(n1.x + n2.x, n1.y + n2.y), k = Math.min(MITER, 1 / Math.max(1 / MITER, m.x * n1.x + m.y * n1.y));
    out.push({ x: p.x + m.x * d * k, y: p.y + m.y * d * k });
  }
  return out;
}

export const unit = (x: number, y: number): Point => {
  const l = Math.hypot(x, y) || 1;
  return { x: x / l, y: y / l };
};
