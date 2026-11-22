// Airport surfaces for one cell (decision 32): aprons, taxiways and runways,
// clipped to the cell's own square like water (decision 25), so a 5 km runway
// crossing several cells meets itself along the shared edges.
//
// - Areas (aprons, and runways or taxiways mapped as areas) are cut into
//   AREA_GRID squares and every vertex sits on the drawn ground.
// - Center lines become ribbons of their width, level across, each point at
//   the highest ground under the ribbon around it (as streams).
// - Kinds stack: apron, then taxiways AEROWAY_LIFT above it, then runways
//   above those, so where they overlap the right one shows without fighting.
//
// The output is a plain triangle list (no index buffer) with a material per
// vertex, the same shape as water.

import earcut from "earcut";
import type { FileMetadata } from "./arrow-util.ts";
import { column, readTable, toIPC, u8 } from "./arrow-util.ts";
import { ecefToLocal, geodeticToEcef, type Frame } from "./geodesy.ts";
import { enuProjection, enuUnprojection } from "./projection.ts";
import { cellOutline, type CellId } from "./s2.ts";
import { footprintMax, type GroundSampler } from "./terrain.ts";
import { clipPolygon, clipPolyline, ribbon } from "./water.ts";
import { FixedSizeList, Field, Float32, makeData } from "apache-arrow";

export interface AerowayAreaInput {
  osmId: number;
  kind: "runway" | "taxiway" | "apron";
  polygons: [lon: number, lat: number][][][];  // polygon → rings (outer first, closed) → points
}

export interface AerowayLineInput {
  osmId: number;
  kind: "runway" | "taxiway";
  width: number;  // m
  points: [lon: number, lat: number][];
}

export const AerowayMaterial = { Apron: 0, Taxiway: 1, Runway: 2 } as const;
const MATERIAL = { apron: AerowayMaterial.Apron, taxiway: AerowayMaterial.Taxiway, runway: AerowayMaterial.Runway };
/** m above the ground, by material: kinds stack where they overlap. */
export const AEROWAY_LIFT = [0, 0.08, 0.16];

export interface AerowayMesh {
  positions: Float32Array;  // x, y, z per vertex, three vertices per triangle, in the cell frame
  material: Uint8Array;     // AerowayMaterial per vertex
}

export const emptyAeroways = (): AerowayMesh => ({ positions: new Float32Array(0), material: new Uint8Array(0) });

const AREA_GRID = 12;     // m: areas are cut into squares this size so they follow the ground
const LINE_SEGMENT = 20;  // m: center lines are densified to this

type Pt = [number, number];

const area2 = (r: Pt[]) => {
  let s = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += r[j]![0] * r[i]![1] - r[i]![0] * r[j]![1];
  return s;
};

/** A cell's airport surfaces on `ground` (the drawn ground; without it, flat at h = 0). */
export function cellAeroways(
  cell: CellId, frame: Frame, areas: AerowayAreaInput[], lines: AerowayLineInput[], ground?: GroundSampler,
): AerowayMesh {
  const project = enuProjection(frame), unproject = enuUnprojection(frame);
  let win: Pt[] = cellOutline(cell).corners.map((c) => project(c.lon, c.lat));
  if (area2(win) < 0) win = win.reverse();
  const pos: number[] = [], mat: number[] = [];
  /** A vertex at (x, y) on the tangent plane, at height h (or the ground's) plus its kind's lift. */
  const put = (x: number, y: number, m: number, h?: number) => {
    const [lon, lat] = unproject(x, y);
    const lift = AEROWAY_LIFT[m]!;
    const p = ground ? ecefToLocal(frame, geodeticToEcef({ lat, lon, h: (h ?? ground(lat, lon)) + lift })) : [x, y, lift];
    pos.push(p[0]!, p[1]!, p[2]!);
    mat.push(m);
  };
  const fill = (rings: Pt[][], m: number) => {
    const flat = rings.flat(), holes: number[] = [];
    let n = 0;
    for (const r of rings.slice(0, -1)) holes.push((n += r.length));
    const tris = earcut(flat.flat(), holes.length ? holes : undefined, 2);
    for (const i of tris) put(flat[i]![0], flat[i]![1], m);
  };

  // Emitted in stacking order: aprons, taxiways, runways.
  const order = (k: AerowayAreaInput["kind"]) => MATERIAL[k];
  for (const a of [...areas].sort((p, q) => order(p.kind) - order(q.kind))) {
    const m = MATERIAL[a.kind];
    for (const polygon of a.polygons) {
      const rings = polygon.map((r) => r.slice(0, -1).map(([lon, lat]) => project(lon, lat)));
      const clipped = rings.map((r) => clipPolygon(r, win)).filter((r, i) => i > 0 ? r.length >= 3 : true);
      if (clipped[0]!.length < 3) continue;
      const xs = clipped[0]!.map((p) => p[0]), ys = clipped[0]!.map((p) => p[1]);
      for (let gx = Math.floor(Math.min(...xs) / AREA_GRID) * AREA_GRID; gx < Math.max(...xs); gx += AREA_GRID) {
        for (let gy = Math.floor(Math.min(...ys) / AREA_GRID) * AREA_GRID; gy < Math.max(...ys); gy += AREA_GRID) {
          const sq: Pt[] = [[gx, gy], [gx + AREA_GRID, gy], [gx + AREA_GRID, gy + AREA_GRID], [gx, gy + AREA_GRID]];
          const outer = clipPolygon(clipped[0]!, sq);
          if (outer.length < 3) continue;
          fill([outer, ...clipped.slice(1).map((h) => clipPolygon(h, sq)).filter((h) => h.length >= 3)], m);
        }
      }
    }
  }

  const maxOver = ground ? (corners: Pt[]) => footprintMax(ground, corners.map(([x, y]) => unproject(x, y))) : undefined;
  for (const w of [...lines].sort((p, q) => order(p.kind) - order(q.kind))) {
    const line: Pt[] = [];
    for (const [k, [lon, lat]] of w.points.entries()) {
      const p = project(lon, lat);
      if (k > 0) {
        const q = line.at(-1)!, steps = Math.ceil(Math.hypot(p[0] - q[0], p[1] - q[1]) / LINE_SEGMENT);
        for (let s = 1; s < steps; s++) line.push([q[0] + ((p[0] - q[0]) * s) / steps, q[1] + ((p[1] - q[1]) * s) / steps]);
      }
      line.push(p);
    }
    for (const piece of clipPolyline(line, win)) ribbon(piece, w.width / 2, MATERIAL[w.kind], put, maxOver);
  }

  return { positions: Float32Array.from(pos), material: Uint8Array.from(mat) };
}

// --- Arrow -------------------------------------------------------------------------
//   aeroways.arrow: one row per vertex: pos fixed_size_list<float32, 3>, material uint8

export function aerowaysToArrow(a: AerowayMesh, metadata: FileMetadata): Uint8Array {
  const type = new FixedSizeList(3, new Field("xyz", new Float32(), false));
  const count = a.material.length;
  return toIPC({
    pos: makeData({ type, length: count, nullCount: 0, child: makeData({ type: new Float32(), length: 3 * count, nullCount: 0, data: a.positions }) }),
    material: u8(a.material),
  }, count, metadata);
}

export function aerowaysFromArrow(bytes: Uint8Array): AerowayMesh {
  const { table } = readTable(bytes, "aeroways");
  const n = table.numRows;
  const pos = column(table, "pos", "aeroways").children[0]!.values as Float32Array;
  return { positions: pos.subarray(0, 3 * n), material: (column(table, "material", "aeroways").values as Uint8Array).subarray(0, n) };
}
