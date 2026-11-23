// A cell's walls for collisions: every edge of every ground-level building
// polygon (outer rings and courtyards; parts up in the air are skipped), as
// segments in the cell's frame, in a uniform grid of BUCKET-m squares (CSR:
// each bucket's segments). Built once per cell; a query visits each segment
// near a box once.

import type { Buildings } from "./buildings.ts";

/** Grid squares, m. */
export const BUCKET = 16;
/** A building part starting higher than this (m) doesn't reach the street. */
const GROUND = 1;

export interface WallGrid {
  segments: Float32Array;  // x0, y0, x1, y1 per segment
  x0: number;
  y0: number;
  nx: number;
  ny: number;
  start: Uint32Array;      // nx·ny + 1 offsets into items
  items: Uint32Array;      // segment indices
  seen: Uint32Array;       // per segment: the last query that visited it
  query: number;
}

export function wallGrid(b: Buildings): WallGrid {
  const seg: number[] = [];
  for (let i = 0; i < b.count; i++) {
    if (b.minHeight[i]! > GROUND) continue;
    for (let r = b.ringStart[i]!; r < b.ringStart[i + 1]!; r++) {
      const a = b.pointStart[r]!, e = b.pointStart[r + 1]!;
      for (let k = a; k < e; k++) {
        const j = k + 1 < e ? k + 1 : a;  // rings are open
        seg.push(b.points[2 * k]!, b.points[2 * k + 1]!, b.points[2 * j]!, b.points[2 * j + 1]!);
      }
    }
  }
  const segments = Float32Array.from(seg), n = segments.length / 4;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let s = 0; s < n; s++) {
    x0 = Math.min(x0, segments[4 * s]!, segments[4 * s + 2]!);
    y0 = Math.min(y0, segments[4 * s + 1]!, segments[4 * s + 3]!);
    x1 = Math.max(x1, segments[4 * s]!, segments[4 * s + 2]!);
    y1 = Math.max(y1, segments[4 * s + 1]!, segments[4 * s + 3]!);
  }
  if (n === 0) [x0, y0, x1, y1] = [0, 0, 0, 0];
  const nx = Math.max(1, Math.ceil((x1 - x0) / BUCKET)), ny = Math.max(1, Math.ceil((y1 - y0) / BUCKET));
  const grid: WallGrid = {
    segments, x0, y0, nx, ny, start: new Uint32Array(nx * ny + 1), items: new Uint32Array(0),
    seen: new Uint32Array(n), query: 0,
  };
  // Counts, offsets, fill (CSR): each segment in every bucket its box touches.
  const each = (s: number, f: (cell: number) => void) => {
    const [ax, ay, bx, by] = [segments[4 * s]!, segments[4 * s + 1]!, segments[4 * s + 2]!, segments[4 * s + 3]!];
    forBuckets(grid, Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by), f);
  };
  for (let s = 0; s < n; s++) each(s, (c) => grid.start[c + 1]!++);
  for (let c = 0; c < nx * ny; c++) grid.start[c + 1]! += grid.start[c]!;
  grid.items = new Uint32Array(grid.start[nx * ny]!);
  const fill = grid.start.slice(0, nx * ny);
  for (let s = 0; s < n; s++) each(s, (c) => { grid.items[fill[c]!++] = s; });
  return grid;
}

/** Visits every segment whose bucket a box touches, once each. */
export function queryWalls(
  g: WallGrid, x0: number, y0: number, x1: number, y1: number,
  visit: (ax: number, ay: number, bx: number, by: number) => void,
): void {
  const q = ++g.query;
  forBuckets(g, x0, y0, x1, y1, (c) => {
    for (let k = g.start[c]!; k < g.start[c + 1]!; k++) {
      const s = g.items[k]!;
      if (g.seen[s] === q) continue;
      g.seen[s] = q;
      visit(g.segments[4 * s]!, g.segments[4 * s + 1]!, g.segments[4 * s + 2]!, g.segments[4 * s + 3]!);
    }
  });
}

/** The buckets a box touches (clamped to the grid; none if it's outside). */
function forBuckets(g: WallGrid, x0: number, y0: number, x1: number, y1: number, f: (cell: number) => void): void {
  const i0 = Math.max(0, Math.floor((x0 - g.x0) / BUCKET)), i1 = Math.min(g.nx - 1, Math.floor((x1 - g.x0) / BUCKET));
  const j0 = Math.max(0, Math.floor((y0 - g.y0) / BUCKET)), j1 = Math.min(g.ny - 1, Math.floor((y1 - g.y0) / BUCKET));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) f(j * g.nx + i);
}
