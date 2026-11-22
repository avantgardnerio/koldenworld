// Water for one cell (decision 25): lakes, river surfaces and waterway lines,
// clipped to the cell's own square, triangulated, and placed on the ground.
//
// Unlike roads and buildings, water isn't owned by one cell: a reservoir or a
// 50 km river would stretch far past any owner. Each cell clips to its own
// square instead, so neighbors' pieces meet along the shared edge.
//
// Heights (with a HeightFn; without one everything is at h = 0):
// - lakes are flat at one level, sampled inside the lake. USGS elevation is
//   hydro-flattened (lakes are one height in the data), so every cell sampling
//   the same lake gets the same level.
// - river surfaces follow the ground, so they're cut into a grid first and
//   every vertex is draped (wide rivers are flattened downstream in the data too).
// - waterway lines become ribbons of their width, draped along the centerline.
//
// The output is a plain triangle list (no index buffer) with a material per vertex.

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

export const WaterMaterial = { Lake: 0, River: 1, Stream: 2 } as const;

export interface WaterMesh {
  positions: Float32Array;  // x, y, z per vertex, three vertices per triangle, in the cell frame
  material: Uint8Array;     // WaterMaterial per vertex
}

export const emptyWater = (): WaterMesh => ({ positions: new Float32Array(0), material: new Uint8Array(0) });

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

/** Where water surfaces go (decision 29). Without one, everything is at h = 0. */
export interface WaterHeights {
  dem: HeightFn;           // the raw elevation: a lake's level is sampled from it inside the lake
  surface: HeightFn;       // the drawn ground before carving (groundSampler without carve): river surfaces
  ground: GroundSampler;   // the drawn ground: streams sit at its highest point across their width
}

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

export function cellWater(
  cell: CellId, frame: Frame, areas: WaterAreaInput[], lines: WaterwayInput[], heights?: WaterHeights,
): WaterMesh {
  const height = heights?.surface;
  const project = enuProjection(frame), unproject = enuUnprojection(frame);
  let win: Pt[] = cellOutline(cell).corners.map((c) => project(c.lon, c.lat));
  if (area2(win) < 0) win = win.reverse();
  const pos: number[] = [], mat: number[] = [];
  /** A vertex at (x, y) on the tangent plane, placed at height h (or the ground's) at its true position. */
  const put = (x: number, y: number, m: number, h?: number) => {
    const [lon, lat] = unproject(x, y);
    const p = height ? ecefToLocal(frame, geodeticToEcef({ lat, lon, h: h ?? height(lat, lon) })) : [x, y, 0];
    pos.push(p[0]!, p[1]!, p[2]!);
    mat.push(m);
  };
  const fill = (rings: Pt[][], m: number, h?: number) => {
    const flat = rings.flat(), holes: number[] = [];
    let n = 0;
    for (const r of rings.slice(0, -1)) holes.push((n += r.length));
    const tris = earcut(flat.flat(), holes.length ? holes : undefined, 2);
    for (const i of tris) put(flat[i]![0], flat[i]![1], m, h);
  };

  for (const a of areas) {
    for (const polygon of a.polygons) {
      const rings = polygon.map((r) => r.slice(0, -1).map(([lon, lat]) => project(lon, lat)));
      const clipped = rings.map((r) => clipPolygon(r, win)).filter((r, i) => i > 0 ? r.length >= 3 : true);
      if (clipped[0]!.length < 3) continue;
      if (a.kind === "lake") {
        fill(clipped, WaterMaterial.Lake, heights ? lakeLevel(clipped, unproject, heights.dem) : undefined);
        continue;
      }
      // A river surface: cut into grid squares so every vertex can follow the ground.
      const xs = clipped[0]!.map((p) => p[0]), ys = clipped[0]!.map((p) => p[1]);
      for (let gx = Math.floor(Math.min(...xs) / RIVER_GRID) * RIVER_GRID; gx < Math.max(...xs); gx += RIVER_GRID) {
        for (let gy = Math.floor(Math.min(...ys) / RIVER_GRID) * RIVER_GRID; gy < Math.max(...ys); gy += RIVER_GRID) {
          const sq: Pt[] = [[gx, gy], [gx + RIVER_GRID, gy], [gx + RIVER_GRID, gy + RIVER_GRID], [gx, gy + RIVER_GRID]];
          const outer = clipPolygon(clipped[0]!, sq);
          if (outer.length < 3) continue;
          fill([outer, ...clipped.slice(1).map((h) => clipPolygon(h, sq)).filter((h) => h.length >= 3)], WaterMaterial.River);
        }
      }
    }
  }

  for (const w of lines) {
    const m = w.kind === "river" || w.kind === "canal" ? WaterMaterial.River : WaterMaterial.Stream;
    const line: Pt[] = [];
    for (const [k, [lon, lat]] of w.points.entries()) {
      const p = project(lon, lat);
      if (k > 0) {
        const q = line.at(-1)!, steps = Math.ceil(Math.hypot(p[0] - q[0], p[1] - q[1]) / LINE_SEGMENT);
        for (let s = 1; s < steps; s++) line.push([q[0] + ((p[0] - q[0]) * s) / steps, q[1] + ((p[1] - q[1]) * s) / steps]);
      }
      line.push(p);
    }
    for (const piece of clipPolyline(line, win)) {
      ribbon(piece, w.width / 2, m, put, heights ? (corners) => footprintMax(heights.ground, corners.map(([x, y]) => unproject(x, y))) : undefined);
    }
  }

  return { positions: Float32Array.from(pos), material: Uint8Array.from(mat) };
}

/** The level of a lake: the median ground height at a few points inside its clipped part. */
function lakeLevel(rings: Pt[][], unproject: (x: number, y: number) => [number, number], height: HeightFn): number {
  const flat = rings.flat(), holes: number[] = [];
  let n = 0;
  for (const r of rings.slice(0, -1)) holes.push((n += r.length));
  const tris = earcut(flat.flat(), holes.length ? holes : undefined, 2);
  const hs: number[] = [];
  for (let t = 0; t < tris.length && hs.length < 25; t += 3) {
    const [a, b, c] = [flat[tris[t]!]!, flat[tris[t + 1]!]!, flat[tris[t + 2]!]!];
    const [lon, lat] = unproject((a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3);
    hs.push(height(lat, lon));
  }
  hs.sort((x, y) => x - y);
  return hs[Math.floor(hs.length / 2)] ?? 0;
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

// --- Arrow -------------------------------------------------------------------------
//   water.arrow: one row per vertex: pos fixed_size_list<float32, 3>, material uint8

export function waterToArrow(w: WaterMesh, metadata: FileMetadata): Uint8Array {
  const type = new FixedSizeList(3, new Field("xyz", new Float32(), false));
  const count = w.material.length;
  return toIPC({
    pos: makeData({ type, length: count, nullCount: 0, child: makeData({ type: new Float32(), length: 3 * count, nullCount: 0, data: w.positions }) }),
    material: u8(w.material),
  }, count, metadata);
}

export function waterFromArrow(bytes: Uint8Array): WaterMesh {
  const { table } = readTable(bytes, "water");
  const n = table.numRows;
  const pos = column(table, "pos", "water").children[0]!.values as Float32Array;
  return { positions: pos.subarray(0, 3 * n), material: (column(table, "material", "water").values as Uint8Array).subarray(0, n) };
}
