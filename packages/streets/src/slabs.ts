// Polygon booleans by slabs, tracked by index. No tolerances anywhere.
//
// Points: every vertex is an index into one table; polygons that share a point
// object share its index. The only points ever made are crossings: two edges
// that cross get one new vertex, made once, that both are split at. A vertex
// lying exactly on another edge splits that edge at its own index. Nothing is
// snapped or compared within a tolerance; where an exact test lands on zero in
// a way indices don't explain, it's counted in `events` instead of hidden.
//
// 1. Split every edge at its crossings and at vertices lying on it. Pieces
//    with the same two ends are one piece, carrying each polygon's winding
//    change (an edge two polygons share).
// 2. Every vertex's y is a slab line (equal y: one line). In a slab no pieces
//    cross, so they sort left to right; each cell between neighbors is a
//    trapezoid (a triangle when one side is a point).
// 3. Walking a slab left to right, winding numbers change at each piece:
//    every cell is classified at once by `inside(w)`.
// 4. Picked cells → triangles (their corners on slab lines are for drawing only).
// 5. The outline: pieces with the result on one side only (decided once per
//    piece: nothing crosses a piece, so its sides never change along it),
//    directed with the result on their left, stitched by index into loops,
//    taking the sharpest right turn where several continue from one vertex.
//
// Polygons are turned counterclockwise as a whole first, so winding +1 is a
// polygon's normal inside and −1 a loop of it turned inside out.

import type { Point } from "./graph.ts";

export interface SlabEvents {
  crossings: number;     // new vertices made where two edges cross
  touches: number;       // a vertex exactly on another polygon's edge
  overlaps: number;      // two edges exactly collinear and overlapping
  ties: number;          // two different pieces at exactly the same place in a slab
  disagree: number;      // a piece whose sides came out differently in two slabs
}

export interface SlabResult {
  triangles: Point[][];
  loops: Point[][];      // the result on their left: outer loops counterclockwise, holes clockwise
  events: SlabEvents;
  tied: [Point, Point, Point, Point][];  // distinct pairs of pieces that tied: each piece's two ends
}

const orient = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const between = (a: Point, b: Point, p: Point) =>
  Math.min(a.x, b.x) <= p.x && p.x <= Math.max(a.x, b.x) && Math.min(a.y, b.y) <= p.y && p.y <= Math.max(a.y, b.y);
export const area = (ring: Point[]) => ring.reduce((s, p, i) => {
  const q = ring[(i + 1) % ring.length]!;
  return s + p.x * q.y - q.x * p.y;
}, 0) / 2;

interface Line { i: number; j: number; on: number[] }  // one geometric edge: vertices splitting it in `on`
interface Edge { i: number; j: number; poly: number; line: Line }
interface Piece { lo: number; hi: number; turns: Map<number, number> }

/**
 * polys: per polygon, its rings (shared point objects are shared vertices).
 * inside(w): w[i] is polygon i's winding number in a cell.
 */
export function slabs(polys: Point[][][], inside: (w: Int32Array) => boolean): SlabResult {
  const P: Point[] = [], index = new Map<Point, number>();
  const id = (p: Point) => {
    if (!index.has(p)) index.set(p, P.push(p) - 1);
    return index.get(p)!;
  };
  const events: SlabEvents = { crossings: 0, touches: 0, overlaps: 0, ties: 0, disagree: 0 };

  // Edges of polygons, and the lines they lie on: polygons' edges with the same two ends (an edge
  // they share) are one line, so whatever crosses it crosses it once, at one vertex they all share.
  const edges: Edge[] = [], lines = new Map<string, Line>();
  polys.forEach((rings, poly) => {
    const flip = rings.reduce((s, r) => s + area(r), 0) < 0;
    for (const ring of rings) {
      const r = (flip ? [...ring].reverse() : ring).map(id);
      r.forEach((i, k) => {
        const j = r[(k + 1) % r.length]!;
        if (i === j) return;
        const key = i < j ? `${i},${j}` : `${j},${i}`;
        if (!lines.has(key)) lines.set(key, { i, j, on: [] });
        edges.push({ i, j, poly, line: lines.get(key)! });
      });
    }
  });
  const unique = [...lines.values()];

  // 1. Crossings and touches, by exact orientation signs.
  for (let m = 0; m < unique.length; m++) {
    for (let n = m + 1; n < unique.length; n++) {
      const e = unique[m]!, f = unique[n]!;
      const a = P[e.i]!, b = P[e.j]!, c = P[f.i]!, d = P[f.j]!;
      if (Math.max(a.x, b.x) < Math.min(c.x, d.x) || Math.max(c.x, d.x) < Math.min(a.x, b.x)) continue;
      if (Math.max(a.y, b.y) < Math.min(c.y, d.y) || Math.max(c.y, d.y) < Math.min(a.y, b.y)) continue;
      const shared = e.i === f.i || e.i === f.j || e.j === f.i || e.j === f.j;
      const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
      if (!shared && Math.sign(o1) * Math.sign(o2) < 0 && Math.sign(o3) * Math.sign(o4) < 0) {
        const t = o3 / (o3 - o4), v = P.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }) - 1;
        e.on.push(v);
        f.on.push(v);
        events.crossings++;
        continue;
      }
      const touch = (g: Line, k: number, o: number, p: Point) => {
        if (o !== 0 || k === g.i || k === g.j || !between(P[g.i]!, P[g.j]!, p)) return false;
        g.on.push(k);
        return true;
      };
      const hits = [touch(e, f.i, o1, c), touch(e, f.j, o2, d), touch(f, e.i, o3, a), touch(f, e.j, o4, b)].filter(Boolean).length;
      if (hits) {
        if (o1 === 0 && o2 === 0) events.overlaps++;
        else if (!shared) events.touches++;
      }
    }
  }

  // Pieces: each edge cut at its vertices, in order along it; the same two ends → one piece.
  const pieces = new Map<string, Piece>();
  for (const e of edges) {
    const a = P[e.i]!, b = P[e.j]!, dx = b.x - a.x, dy = b.y - a.y;
    const along = (k: number) => (P[k]!.x - a.x) * dx + (P[k]!.y - a.y) * dy;
    const chain = [e.i, ...[...new Set(e.line.on)].sort((p, q) => along(p) - along(q)), e.j];
    for (let k = 0; k + 1 < chain.length; k++) {
      const u = chain[k]!, v = chain[k + 1]!;
      if (u === v) continue;
      // Stored bottom to top. Crossing, west to east, a piece that runs down goes into a counterclockwise polygon.
      const up = P[u]!.y < P[v]!.y || (P[u]!.y === P[v]!.y && P[u]!.x < P[v]!.x);
      const [lo, hi] = up ? [u, v] : [v, u], key = `${lo},${hi}`;
      if (!pieces.has(key)) pieces.set(key, { lo, hi, turns: new Map() });
      const piece = pieces.get(key)!;
      piece.turns.set(e.poly, (piece.turns.get(e.poly) ?? 0) + (up ? -1 : 1));
    }
  }
  const list = [...pieces.values()].filter((p) => [...p.turns.values()].some((d) => d !== 0));

  // 2–4. Slabs. A piece's x at a slab line is its own endpoint's when it ends there.
  const ys = [...new Set(list.flatMap((p) => [P[p.lo]!.y, P[p.hi]!.y]))].sort((p, q) => p - q);
  const xAt = (p: Piece, y: number) => {
    const a = P[p.lo]!, b = P[p.hi]!;
    if (y === a.y) return a.x;
    if (y === b.y) return b.x;
    return a.x + ((b.x - a.x) * (y - a.y)) / (b.y - a.y);
  };
  const n = polys.length, triangles: Point[][] = [], outline: [number, number][] = [];
  const side = new Map<Piece, "west" | "east" | "none">();
  const tied: SlabResult["tied"] = [], tiedSeen = new Set<string>();  // which side the result is on, if just one
  const picked: { x0: number; x1: number; top0: number; top1: number }[][] = [];
  for (let k = 0; k + 1 < ys.length; k++) {
    const y0 = ys[k]!, y1 = ys[k + 1]!, ym = (y0 + y1) / 2;
    const span = list.filter((p) => P[p.lo]!.y <= y0 && P[p.hi]!.y >= y1 && P[p.lo]!.y !== P[p.hi]!.y)
      .map((p) => ({ p, x0: xAt(p, y0), x1: xAt(p, y1), xm: xAt(p, ym) }))
      .sort((s, t) => s.xm - t.xm);
    for (let i = 0; i + 1 < span.length; i++) {
      if (span[i]!.xm !== span[i + 1]!.xm) continue;
      events.ties++;
      const p = span[i]!.p, q = span[i + 1]!.p, key = `${p.lo},${p.hi}/${q.lo},${q.hi}`;
      if (!tiedSeen.has(key)) { tiedSeen.add(key); tied.push([P[p.lo]!, P[p.hi]!, P[q.lo]!, P[q.hi]!]); }
    }
    const w = new Int32Array(n), cells: (typeof picked)[number] = [];
    let wasIn = false;
    span.forEach((s, i) => {
      for (const [poly, d] of s.p.turns) w[poly]! += d;
      const isIn = i + 1 < span.length && inside(w);
      const here = isIn === wasIn ? "none" : wasIn ? "west" : "east";
      if (!side.has(s.p)) side.set(s.p, here);
      else if (side.get(s.p) !== here) events.disagree++;
      wasIn = isIn;
      if (!isIn) return;
      const t = span[i + 1]!;
      const c = [{ x: s.x0, y: y0 }, { x: t.x0, y: y0 }, { x: t.x1, y: y1 }, { x: s.x1, y: y1 }] as const;
      if (t.x0 !== s.x0) triangles.push([c[0], c[1], c[2]]);
      if (t.x1 !== s.x1) triangles.push([c[0], c[2], c[3]]);
      cells.push({ x0: s.x0, x1: t.x0, top0: s.x1, top1: t.x1 });
    });
    picked.push(cells);
  }
  // Result on the left: going up (low to high) when it's to the west, down when to the east.
  for (const [p, s] of side) {
    if (s === "west") outline.push([p.lo, p.hi]);
    else if (s === "east") outline.push([p.hi, p.lo]);
  }
  // Horizontal pieces are outline where the result is on one side of them only.
  const covered = (k: number, x: number, top: boolean) =>
    (picked[k] ?? []).some((c) => (top ? c.top0 < x && x < c.top1 : c.x0 < x && x < c.x1));
  for (const p of list) {
    const a = P[p.lo]!, b = P[p.hi]!;
    if (a.y !== b.y) continue;
    const k = ys.indexOf(a.y), xm = (a.x + b.x) / 2;
    const above = covered(k, xm, false), below = k > 0 && covered(k - 1, xm, true);
    if (above && !below) outline.push([p.lo, p.hi]);       // result above: east keeps it on the left
    else if (below && !above) outline.push([p.hi, p.lo]);  // result below: west
  }

  // 5. Stitch by index, taking the sharpest right turn.
  const from = new Map<number, number[]>();
  outline.forEach(([u], i) => {
    if (!from.has(u)) from.set(u, []);
    from.get(u)!.push(i);
  });
  const used = new Set<number>(), loops: Point[][] = [];
  for (let start = 0; start < outline.length; start++) {
    if (used.has(start)) continue;
    const loop: number[] = [];
    for (let cur: number | undefined = start; cur !== undefined && !used.has(cur);) {
      used.add(cur);
      const [u, v]: [number, number] = outline[cur]!;
      loop.push(u);
      const back = Math.atan2(P[u]!.y - P[v]!.y, P[u]!.x - P[v]!.x);
      const turn = (i: number) => {
        const [a, b] = outline[i]!, out = Math.atan2(P[b]!.y - P[a]!.y, P[b]!.x - P[a]!.x);
        const r = (out - back) % (2 * Math.PI);
        return r <= 0 ? r + 2 * Math.PI : r;  // counterclockwise from straight back: smallest is the sharpest right
      };
      cur = (from.get(v) ?? []).filter((i) => !used.has(i)).sort((i, j) => turn(i) - turn(j))[0];
    }
    const pts = loop.map((k) => P[k]!);
    if (pts.length >= 3 && area(pts) !== 0) loops.push(pts);
  }
  return { triangles, loops, events, tied };
}
