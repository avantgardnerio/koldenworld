// Pavement, grass and sidewalk for one cell, as polygons, from @game/streets
// (decision 34): the union of every street around the cell as polygons, then
// bands pushed out from it by index. The input is a draped road graph of every
// road around the cell (not just the ones it owns), so a cell's pieces meet
// its neighbors'. Heights come with the vertices: each street's points carry
// their draped height, and everything made from them carries it on.
//
// Each layer is cut to the cell's square with the same boolean, so the cell
// keeps polygons (an outer loop and its holes, simple loops) and neighbors'
// polygons meet along the shared edge. They are triangulated only to be drawn.
// Columns throughout (decision 1): no object per point.

import { F64, I32, layers, ringArea, ringCount, RingsBuilder, slabs, Verts, concatRings, type Graph, type Rings } from "@game/streets";
import type { FileMetadata } from "./arrow-util.ts";
import { column, readTable, toIPC, u8, u32 } from "./arrow-util.ts";
import type { Frame } from "./geodesy.ts";
import { enuProjection } from "./projection.ts";
import { ROAD_STRUCTURES, type RoadGraph } from "./road-graph.ts";
import { edgeHalfWidth } from "./road-surface.ts";
import { cellOutline, type CellId } from "./s2.ts";
import { FixedSizeList, Field, Float32, makeData } from "apache-arrow";

export const StreetsMaterial = { Pavement: 0, Grass: 1, Sidewalk: 2 } as const;

/** Grass then sidewalk, out from the curb, m. */
export const STREET_BANDS = [1.5, 1.8] as const;
/** Each band's top above the pavement, m (the sidewalk is up a curb). */
const BAND_LIFT = [0, 0.05, 0.15];
/** m around the cell's square whose streets are used: the bands' reach and some. */
const REACH = 40;

/**
 * A cell's street polygons as rows, one per ring vertex, rings in order: a polygon is its outer
 * ring (counterclockwise) then its holes (clockwise). The same columns as streets.arrow.
 */
export interface StreetsPolygons {
  x: Float32Array; y: Float32Array; z: Float32Array;
  polygon: Uint32Array;  // per row: its polygon (numbered from 0)
  ring: Uint32Array;     // per row: its ring (numbered from 0)
  material: Uint8Array;  // per row: its polygon's StreetsMaterial
}

export const emptyStreets = (): StreetsPolygons => ({
  x: new Float32Array(0), y: new Float32Array(0), z: new Float32Array(0),
  polygon: new Uint32Array(0), ring: new Uint32Array(0), material: new Uint8Array(0),
});

/** A draped road graph's edges with a point `keep` accepts, as a streets graph (columns straight from its columns). */
export function streetsGraph(g: RoadGraph, keep: (x: number, y: number) => boolean = () => true): Graph {
  const A = new I32(), B = new I32(), HW = new F64(), LAYER = new I32(), start = new I32(), PX = new F64(), PY = new F64(), PZ = new F64();
  start.push(0);
  for (let e = 0; e < g.edges.count; e++) {
    const p0 = g.edges.pointStart[e]!, p1 = g.edges.pointStart[e + 1]!;
    let near = false;
    for (let p = p0; p < p1 && !near; p++) near = keep(g.points[2 * p]!, g.points[2 * p + 1]!);
    if (!near) continue;
    const before = PX.length;
    for (let p = p0; p < p1; p++) {
      const x = g.points[2 * p]!, y = g.points[2 * p + 1]!;
      if (PX.length > before && x === PX.data[PX.length - 1] && y === PY.data[PY.length - 1]) continue;
      PX.push(x); PY.push(y); PZ.push(g.pointZ[p]!);
    }
    if (PX.length - before < 2) { PX.length = PY.length = PZ.length = before; continue; }
    const structure = ROAD_STRUCTURES[g.edges.structure[e]!];
    A.push(g.edges.from[e]!); B.push(g.edges.to[e]!); HW.push(edgeHalfWidth(g, e));
    LAYER.push(structure === "bridge" ? 1 : structure === "tunnel" ? -1 : 0);
    start.push(PX.length);
  }
  return {
    nodeCount: g.nodes.count, nx: Float64Array.from(g.nodes.x), ny: Float64Array.from(g.nodes.y), nz: Float64Array.from(g.nodes.z),
    streetCount: A.length, a: A.view().slice(), b: B.view().slice(), hw: HW.view().slice(), layer: Int8Array.from(LAYER.view()),
    pointStart: start.view().slice(), px: PX.view().slice(), py: PY.view().slice(), pz: PZ.view().slice(),
  };
}

/** A cell's pavement, grass and sidewalk polygons from `roads`: every road around it, draped, in its frame. */
export function cellStreets(cell: CellId, frame: Frame, roads: RoadGraph): StreetsPolygons {
  const project = enuProjection(frame), corners = cellOutline(cell).corners;
  const sx = new Float64Array(4), sy = new Float64Array(4);
  corners.forEach((c, k) => { [sx[k], sy[k]] = project(c.lon, c.lat); });
  const [x0, x1, y0, y1] = [Math.min(...sx) - REACH, Math.max(...sx) + REACH, Math.min(...sy) - REACH, Math.max(...sy) + REACH];
  const { V, pavement, bands } = layers(streetsGraph(roads, (x, y) => x > x0 && x < x1 && y > y0 && y < y1), [...STREET_BANDS]);

  // The square as a ring of vertices with no height (NaN), counterclockwise.
  const square = new RingsBuilder();
  const ccw = (sx[1]! - sx[0]!) * (sy[2]! - sy[0]!) - (sy[1]! - sy[0]!) * (sx[2]! - sx[0]!) > 0;
  for (let k = 0; k < 4; k++) { const i = ccw ? k : 3 - k; square.add(V.push(sx[i]!, sy[i]!, NaN)); }
  square.close();
  const sq = square.rings();

  const X = new F64(), Y = new F64(), Z = new F64(), POLY = new I32(), RING = new I32(), MAT = new I32();
  let nPoly = 0, nRing = 0;
  [pavement.loops, ...bands.map((b) => b.result.loops)].forEach((loops, material) => {
    if (ringCount(loops) === 0) return;
    // Cut to the square: inside the layer's loops (polygon 0) and inside the square (polygon 1).
    const nl = ringCount(loops), ringPoly = new Int32Array(nl + 1).fill(1, nl);
    const cut = slabs(V, concatRings(loops, sq), ringPoly, Int32Array.of(0, 1), 2, (nz, pos) => nz[0]! > 0 && pos[1]! > 0).loops;
    fillHeights(V, cut);
    for (const rings of group(V, cut)) {
      for (const r of rings) {
        for (let i = cut.start[r]!; i < cut.start[r + 1]!; i++) {
          const v = cut.verts[i]!;
          X.push(V.x(v)); Y.push(V.y(v)); Z.push(V.z(v) + BAND_LIFT[material]!);
          POLY.push(nPoly); RING.push(nRing); MAT.push(material);
        }
        nRing++;
      }
      nPoly++;
    }
  });
  return {
    x: Float32Array.from(X.view()), y: Float32Array.from(Y.view()), z: Float32Array.from(Z.view()),
    polygon: Uint32Array.from(POLY.view()), ring: Uint32Array.from(RING.view()), material: Uint8Array.from(MAT.view()),
  };
}

/** Loops into polygons: per outer ring (counterclockwise), it and the holes (clockwise) inside it, as ring numbers. */
function group(V: Verts, loops: Rings): number[][] {
  const n = ringCount(loops), polys: number[][] = [], outers: number[] = [];
  for (let r = 0; r < n; r++) if (ringArea(V, loops, r) > 0) { outers.push(r); polys.push([r]); }
  for (let r = 0; r < n; r++) {
    if (ringArea(V, loops, r) >= 0) continue;
    // Test the middle of the hole's first edge (a hole may touch its outer at a vertex).
    const a = loops.verts[loops.start[r]!]!, b = loops.verts[loops.start[r]! + 1]!;
    const px = (V.x(a) + V.x(b)) / 2, py = (V.y(a) + V.y(b)) / 2;
    const k = outers.findIndex((o) => contains(V, loops, o, px, py));
    if (k >= 0) polys[k]!.push(r);
  }
  return polys;
}

function contains(V: Verts, loops: Rings, r: number, x: number, y: number): boolean {
  let inside = false;
  const s = loops.start[r]!, e = loops.start[r + 1]!;
  for (let i = s, j = e - 1; i < e; j = i++) {
    const a = loops.verts[i]!, b = loops.verts[j]!;
    if ((V.y(a) > y) !== (V.y(b) > y) && x < ((V.x(b) - V.x(a)) * (y - V.y(a))) / (V.y(b) - V.y(a)) + V.x(a)) inside = !inside;
  }
  return inside;
}

/** Vertices with no height (the square's corners) take one along their ring, between their neighbors with heights. */
function fillHeights(V: Verts, loops: Rings): void {
  for (let r = 0; r < ringCount(loops); r++) {
    const s = loops.start[r]!, n = loops.start[r + 1]! - s;
    let any = false;
    for (let k = 0; k < n; k++) if (V.z(loops.verts[s + k]!) === V.z(loops.verts[s + k]!)) any = true;
    for (let k = 0; k < n; k++) {
      const v = loops.verts[s + k]!;
      if (V.z(v) === V.z(v)) continue;
      if (!any) { V.xyz[3 * v + 2] = 0; continue; }
      let before = 0, after = 0, zb = 0, za = 0;
      for (let j = k, len = 0; ; ) {
        const prev = (j - 1 + n) % n;
        len += Math.hypot(V.x(loops.verts[s + j]!) - V.x(loops.verts[s + prev]!), V.y(loops.verts[s + j]!) - V.y(loops.verts[s + prev]!));
        j = prev;
        const z = V.z(loops.verts[s + j]!);
        if (z === z) { before = len; zb = z; break; }
      }
      for (let j = k, len = 0; ; ) {
        const next = (j + 1) % n;
        len += Math.hypot(V.x(loops.verts[s + next]!) - V.x(loops.verts[s + j]!), V.y(loops.verts[s + next]!) - V.y(loops.verts[s + j]!));
        j = next;
        const z = V.z(loops.verts[s + j]!);
        if (z === z) { after = len; za = z; break; }
      }
      V.xyz[3 * v + 2] = zb + ((za - zb) * before) / (before + after || 1);
    }
  }
}

// --- Arrow -------------------------------------------------------------------------
//   streets.arrow: one row per ring vertex, rings in order:
//     pos fixed_size_list<float32, 3>, polygon uint32, ring uint32 (numbered from 0 in the file), material uint8

export function streetsToArrow(s: StreetsPolygons, metadata: FileMetadata): Uint8Array {
  const count = s.polygon.length, xyz = new Float32Array(3 * count);
  for (let i = 0; i < count; i++) { xyz[3 * i] = s.x[i]!; xyz[3 * i + 1] = s.y[i]!; xyz[3 * i + 2] = s.z[i]!; }
  const type = new FixedSizeList(3, new Field("xyz", new Float32(), false));
  return toIPC({
    pos: makeData({ type, length: count, nullCount: 0, child: makeData({ type: new Float32(), length: 3 * count, nullCount: 0, data: xyz }) }),
    polygon: u32(s.polygon), ring: u32(s.ring), material: u8(s.material),
  }, count, metadata);
}

export function streetsFromArrow(bytes: Uint8Array): StreetsPolygons {
  const { table } = readTable(bytes, "streets");
  const n = table.numRows;
  const xyz = column(table, "pos", "streets").children[0]!.values as Float32Array;
  const x = new Float32Array(n), y = new Float32Array(n), z = new Float32Array(n);
  for (let i = 0; i < n; i++) { x[i] = xyz[3 * i]!; y[i] = xyz[3 * i + 1]!; z[i] = xyz[3 * i + 2]!; }
  return {
    x, y, z,
    polygon: (column(table, "polygon", "streets").values as Uint32Array).subarray(0, n),
    ring: (column(table, "ring", "streets").values as Uint32Array).subarray(0, n),
    material: (column(table, "material", "streets").values as Uint8Array).subarray(0, n),
  };
}
