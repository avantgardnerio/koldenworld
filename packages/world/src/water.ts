// Water helpers: the terrain carved a little under lakes and river surfaces (for the heights cars and the camera use),
// and the polygon and ribbon helpers airport surfaces share. The drawn water is part of the ground from the Rust
// generator (crates/cellgen), where road wins over it.

import earcut from "earcut";
import type { FileMetadata } from "./arrow-util.ts";
import { column, readTable, toIPC, u8 } from "./arrow-util.ts";
import { ecefToLocal, geodeticToEcef, type Frame } from "./geodesy.ts";
import { enuProjection, enuUnprojection } from "./projection.ts";
import { cellLattice, cellOutline, type CellId } from "./s2.ts";
import { footprintMax, type CellTerrain, type GroundSampler, type HeightFn } from "./terrain.ts";
import { FixedSizeList, Field, Float32, makeData } from "apache-arrow";

export interface WaterAreaInput {
  osmId: number;
  kind: "lake" | "river";
  polygons: [lon: number, lat: number][][][];  // polygon → rings (outer first, closed) → points
}

export interface WaterwayInput {
  osmId: number;
  kind: string;     // waterway=* value
  width: number;    // m
  points: [lon: number, lat: number][];
}




const RIVER_GRID = 20;    // m: river surfaces are cut into squares this size before draping
const LINE_SEGMENT = 20;  // m: waterway centerlines are densified to this
const MITER_LIMIT = 2;

type Pt = [number, number];

// --- clipping (convex window, counterclockwise) -----------------------------------

/** Sutherland–Hodgman: a polygon (any shape) clipped to a convex counterclockwise window. */
export function clipPolygon(poly: Pt[], win: Pt[]): Pt[] {
  let out = poly;
  for (let i = 0; i < win.length && out.length > 0; i++) {
    const [ax, ay] = win[i]!, [bx, by] = win[(i + 1) % win.length]!;
    const inside = ([x, y]: Pt) => (bx - ax) * (y - ay) - (by - ay) * (x - ax) >= 0;
    const cut = ([px, py]: Pt, [qx, qy]: Pt): Pt => {
      const dp = (bx - ax) * (py - ay) - (by - ay) * (px - ax), dq = (bx - ax) * (qy - ay) - (by - ay) * (qx - ax);
      const t = dp / (dp - dq);
      return [px + (qx - px) * t, py + (qy - py) * t];
    };
    const input = out;
    out = [];
    for (let k = 0; k < input.length; k++) {
      const p = input[k]!, q = input[(k + 1) % input.length]!;
      const pin = inside(p), qin = inside(q);
      if (pin) out.push(p);
      if (pin !== qin) out.push(cut(p, q));
    }
  }
  return out;
}

/** Cyrus–Beck: the pieces of a polyline inside a convex counterclockwise window. */
export function clipPolyline(line: Pt[], win: Pt[]): Pt[][] {
  const pieces: Pt[][] = [];
  let cur: Pt[] = [];
  const flush = () => {
    if (cur.length >= 2) pieces.push(cur);
    cur = [];
  };
  for (let k = 0; k + 1 < line.length; k++) {
    const [px, py] = line[k]!, [qx, qy] = line[k + 1]!;
    let t0 = 0, t1 = 1;
    for (let i = 0; i < win.length && t0 <= t1; i++) {
      const [ax, ay] = win[i]!, [bx, by] = win[(i + 1) % win.length]!;
      const dp = (bx - ax) * (py - ay) - (by - ay) * (px - ax);       // ≥ 0 inside
      const dd = (bx - ax) * (qy - py) - (by - ay) * (qx - px);
      if (dd === 0) { if (dp < 0) t1 = -1; continue; }
      const t = -dp / dd;
      if (dd > 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
    }
    if (t0 > t1) { flush(); continue; }
    const a: Pt = [px + (qx - px) * t0, py + (qy - py) * t0], b: Pt = [px + (qx - px) * t1, py + (qy - py) * t1];
    const last = cur.at(-1);
    if (!last || Math.hypot(last[0] - a[0], last[1] - a[1]) > 1e-6) { flush(); cur.push(a); }
    cur.push(b);
    if (t1 < 1) flush();
  }
  flush();
  return pieces;
}

const area2 = (r: Pt[]) => {
  let s = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += r[j]![0] * r[i]![1] - r[i]![0] * r[j]![1];
  return s;
};

// --- the operator ------------------------------------------------------------------

/** How far the terrain lattice is lowered inside lakes and river surfaces, m. */
export const WATER_CARVE = 1;

/**
 * Lowers the terrain lattice inside water areas, so the drawn ground near a
 * shore (which the 17 m lattice smooths up toward the bank) can't cover the
 * water. Each cell decides for its own lattice points from the same polygons,
 * so neighbors agree along shared edges. For groundSampler's `carve`.
 */
export function carveWater(areas: WaterAreaInput[]): (cell: CellId, t: CellTerrain) => CellTerrain {
  const polys = areas.flatMap((a) => a.polygons).map((rings) => {
    const lons = rings[0]!.map((p) => p[0]), lats = rings[0]!.map((p) => p[1]);
    return { rings, w: Math.min(...lons), e: Math.max(...lons), s: Math.min(...lats), n: Math.max(...lats) };
  });
  const inRing = (lon: number, lat: number, r: [number, number][]) => {
    let inside = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i]!, [xj, yj] = r[j]!;
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  return (cell, t) => {
    if (polys.length === 0) return t;
    const ll = cellLattice(cell, t.n), heights = Float32Array.from(t.heights);
    for (let k = 0; k < heights.length; k++) {
      const lat = ll[2 * k]!, lon = ll[2 * k + 1]!;
      for (const p of polys) {
        if (lon < p.w || lon > p.e || lat < p.s || lat > p.n || !inRing(lon, lat, p.rings[0]!)) continue;
        if (p.rings.slice(1).some((h) => inRing(lon, lat, h))) continue;
        heights[k] = heights[k]! - WATER_CARVE;
        break;
      }
    }
    return { n: t.n, heights };
  };
}

/**
 * A strip of half width hw along a polyline, two triangles per segment, level
 * across: each point at the highest ground under the segments on either side
 * of it (maxOver), so the water is never below the drawn ground.
 */
export function ribbon(
  pl: Pt[], hw: number, m: number, put: (x: number, y: number, m: number, h?: number) => void,
  maxOver?: (corners: Pt[]) => number,
): void {
  const side: Pt[] = pl.map((_, i) => {
    let nx = 0, ny = 0;
    for (const j of [i - 1, i]) {
      if (j < 0 || j >= pl.length - 1) continue;
      const dx = pl[j + 1]![0] - pl[j]![0], dy = pl[j + 1]![1] - pl[j]![1], len = Math.hypot(dx, dy) || 1;
      nx += dy / len;
      ny -= dx / len;
    }
    const nl = Math.hypot(nx, ny) || 1;
    const k = i > 0 && i < pl.length - 1 ? Math.min(MITER_LIMIT, 2 / nl) : 1;
    return [(nx / nl) * hw * k, (ny / nl) * hw * k];
  });
  const corners = (i: number): Pt[] => {
    const [ax, ay] = pl[i]!, [bx, by] = pl[i + 1]!, [sx, sy] = side[i]!, [tx, ty] = side[i + 1]!;
    return [[ax - sx, ay - sy], [ax + sx, ay + sy], [bx + tx, by + ty], [bx - tx, by - ty]];
  };
  const quad = maxOver ? Array.from({ length: pl.length - 1 }, (_, i) => maxOver(corners(i))) : [];
  const hs = pl.map((_, i) => (maxOver ? Math.max(quad[i - 1] ?? -Infinity, quad[i] ?? -Infinity) : undefined));
  for (let i = 0; i + 1 < pl.length; i++) {
    const [ax, ay] = pl[i]!, [bx, by] = pl[i + 1]!, [sx, sy] = side[i]!, [tx, ty] = side[i + 1]!;
    const quad: [number, number, number | undefined][] = [
      [ax - sx, ay - sy, hs[i]], [ax + sx, ay + sy, hs[i]], [bx + tx, by + ty, hs[i + 1]], [bx - tx, by - ty, hs[i + 1]],
    ];
    for (const k of [0, 1, 2, 0, 2, 3]) {
      const [x, y, h] = quad[k]!;
      put(x, y, m, h);
    }
  }
}
