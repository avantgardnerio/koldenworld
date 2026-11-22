// Pavement, grass and sidewalk for one cell, as polygons, from @game/streets
// (decision 34): the union of every street around the cell as polygons, then
// bands pushed out from it by index. The input is a draped road graph of every
// road around the cell (not just the ones it owns), so a cell's pieces meet
// its neighbors'. Heights come with the points: each street's points carry
// their draped height, and everything made from them carries it on.
//
// Each layer is cut to the cell's square with the same boolean, so the cell
// keeps polygons (an outer loop and its holes, simple loops) and neighbors'
// polygons meet along the shared edge. They are triangulated only to be drawn.

import earcut from "earcut";
import { area, layers, slabs, type Graph, type Point } from "@game/streets";
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
const BAND_LIFT = [0.05, 0.15];
/** m around the cell's square whose streets are used: the bands' reach and some. */
const REACH = 40;

/** A polygon: its outer loop (counterclockwise) then its holes (clockwise), every point with a height. */
export interface StreetPolygon {
  material: number;  // StreetsMaterial
  rings: { x: number; y: number; z: number }[][];
}

export interface StreetsPolygons { polygons: StreetPolygon[] }

export const emptyStreets = (): StreetsPolygons => ({ polygons: [] });

/** A draped road graph as streets: its nodes and edges (those `keep` accepts a point of), with heights, half widths and layers. */
export function streetsGraph(g: RoadGraph, keep: (x: number, y: number) => boolean = () => true): Graph {
  const nodes = Array.from({ length: g.nodes.count }, (_, n) => ({
    id: String(g.nodes.osmId[n]), x: g.nodes.x[n]!, y: g.nodes.y[n]!, z: g.nodes.z[n]!,
  }));
  const streets: Graph["streets"] = [];
  for (let e = 0; e < g.edges.count; e++) {
    const pts: Point[] = [];
    for (let p = g.edges.pointStart[e]!; p < g.edges.pointStart[e + 1]!; p++) {
      const q = { x: g.points[2 * p]!, y: g.points[2 * p + 1]!, z: g.pointZ[p]! }, last = pts.at(-1);
      if (!last || q.x !== last.x || q.y !== last.y) pts.push(q);
    }
    if (pts.length < 2 || !pts.some((p) => keep(p.x, p.y))) continue;
    const structure = ROAD_STRUCTURES[g.edges.structure[e]!];
    streets.push({
      a: g.edges.from[e]!, b: g.edges.to[e]!, pts, hw: edgeHalfWidth(g, e), way: String(g.edges.osmWayId[e]),
      layer: structure === "bridge" ? 1 : structure === "tunnel" ? -1 : 0,
    });
  }
  return { nodes, streets };
}

/** A cell's pavement, grass and sidewalk polygons from `roads`: every road around it, draped, in its frame. */
export function cellStreets(cell: CellId, frame: Frame, roads: RoadGraph): StreetsPolygons {
  const project = enuProjection(frame);
  let square: Point[] = cellOutline(cell).corners.map((c) => {
    const [x, y] = project(c.lon, c.lat);
    return { x, y };
  });
  if (area(square) < 0) square = square.reverse();
  const xs = square.map((p) => p.x), ys = square.map((p) => p.y);
  const near = (x: number, y: number) =>
    x > Math.min(...xs) - REACH && x < Math.max(...xs) + REACH && y > Math.min(...ys) - REACH && y < Math.max(...ys) + REACH;
  const { pavement, bands } = layers(streetsGraph(roads, near), [...STREET_BANDS]);
  const polygons: StreetPolygon[] = [];
  const results = [[pavement.loops, StreetsMaterial.Pavement, 0], ...bands.map((b, i) => [b.result.loops, i + 1, BAND_LIFT[i]!] as const)] as const;
  for (const [loops, material, lift] of results) {
    if (loops.length === 0) continue;
    // Cut to the square: inside the layer's loops (one polygon of rings) and inside the square.
    const cut = slabs([loops, [square]], (w) => w[0] !== 0 && w[1]! > 0);
    for (const rings of group(cut.loops)) {
      polygons.push({ material, rings: rings.map((r) => withHeights(r).map((p) => ({ x: p.x, y: p.y, z: p.z! + lift }))) });
    }
  }
  return { polygons };
}

/** Simple loops into polygons: each outer (counterclockwise) with the holes (clockwise) inside it. */
function group(loops: Point[][]): Point[][][] {
  const outers = loops.filter((l) => area(l) > 0), holes = loops.filter((l) => area(l) < 0);
  const mine = outers.map(() => [] as Point[][]);
  for (const h of holes) {
    // Test the middle of the hole's first edge (a hole may touch its outer at a vertex).
    const a = h[0]!, b = h[1]!, p = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const k = outers.findIndex((o) => contains(o, p.x, p.y));
    if (k >= 0) mine[k]!.push(h);
  }
  return outers.map((o, k) => [o, ...mine[k]!]);
}

function contains(ring: Point[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** A ring's points with heights: the square's corners have none, so they take them along the ring from their neighbors. */
function withHeights(ring: Point[]): Point[] {
  if (ring.every((p) => p.z === undefined)) return ring.map((p) => ({ ...p, z: 0 }));
  const n = ring.length;
  const step = (from: number, d: number) => {
    let k = from, len = 0;
    do {
      const next = (k + d + n) % n;
      len += Math.hypot(ring[next]!.x - ring[k]!.x, ring[next]!.y - ring[k]!.y);
      k = next;
    } while (ring[k]!.z === undefined);
    return { z: ring[k]!.z!, len };
  };
  return ring.map((p, i) => {
    if (p.z !== undefined) return p;
    // Between the nearest points with heights before and after it around the ring, by distance along it.
    const before = step(i, -1), after = step(i, 1);
    return { ...p, z: before.z + ((after.z - before.z) * before.len) / (before.len + after.len || 1) };
  });
}

/** For drawing: every polygon as triangles (a plain triangle list), with a material per vertex. */
export function streetsTriangles(s: StreetsPolygons): { positions: Float32Array; material: Uint8Array } {
  const pos: number[] = [], mat: number[] = [];
  for (const poly of s.polygons) {
    const flat = poly.rings.flat(), holes: number[] = [];
    let n = 0;
    for (const r of poly.rings.slice(0, -1)) holes.push((n += r.length));
    for (const i of earcut(flat.flatMap((p) => [p.x, p.y]), holes.length ? holes : undefined, 2)) {
      pos.push(flat[i]!.x, flat[i]!.y, flat[i]!.z);
      mat.push(poly.material);
    }
  }
  return { positions: Float32Array.from(pos), material: Uint8Array.from(mat) };
}

// --- Arrow -------------------------------------------------------------------------
//   streets.arrow: one row per ring vertex, rings in order:
//     pos fixed_size_list<float32, 3>, polygon uint32, ring uint32 (numbered from 0 in the file), material uint8

export function streetsToArrow(s: StreetsPolygons, metadata: FileMetadata): Uint8Array {
  const pos: number[] = [], polygon: number[] = [], ring: number[] = [], material: number[] = [];
  let r = 0;
  s.polygons.forEach((p, k) => {
    for (const rg of p.rings) {
      for (const v of rg) { pos.push(v.x, v.y, v.z); polygon.push(k); ring.push(r); material.push(p.material); }
      r++;
    }
  });
  const count = polygon.length, type = new FixedSizeList(3, new Field("xyz", new Float32(), false));
  return toIPC({
    pos: makeData({ type, length: count, nullCount: 0, child: makeData({ type: new Float32(), length: 3 * count, nullCount: 0, data: Float32Array.from(pos) }) }),
    polygon: u32(Uint32Array.from(polygon)), ring: u32(Uint32Array.from(ring)), material: u8(Uint8Array.from(material)),
  }, count, metadata);
}

export function streetsFromArrow(bytes: Uint8Array): StreetsPolygons {
  const { table } = readTable(bytes, "streets");
  const n = table.numRows;
  const pos = column(table, "pos", "streets").children[0]!.values as Float32Array;
  const polygon = column(table, "polygon", "streets").values as Uint32Array, ring = column(table, "ring", "streets").values as Uint32Array;
  const material = column(table, "material", "streets").values as Uint8Array;
  const polygons: StreetPolygon[] = [];
  for (let i = 0; i < n; i++) {
    if (i === 0 || polygon[i] !== polygon[i - 1]) polygons.push({ material: material[i]!, rings: [] });
    const p = polygons.at(-1)!;
    if (i === 0 || ring[i] !== ring[i - 1]) p.rings.push([]);
    p.rings.at(-1)!.push({ x: pos[3 * i]!, y: pos[3 * i + 1]!, z: pos[3 * i + 2]! });
  }
  return { polygons };
}
