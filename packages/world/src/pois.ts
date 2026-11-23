// Points of interest (shops, cafés, offices, ...) in a cell, as columns, each
// assigned to the building it's in: the smallest ground-floor polygon holding
// its point, or the nearest one within ASSIGN_DISTANCE m. A business belongs to
// the cell owning its building, so its sign and shopfront are drawn with it;
// one in no building isn't kept (yet). Pure, like every operator.
//
//   pois.arrow (a row per point of interest)
//   osm_id    float64
//   category  dictionary<uint8, utf8>    POI_CATEGORIES: the key that made it one
//   kind      dictionary<uint16, utf8>   its value: "cafe", "bakery", ...
//   name      dictionary<uint16, utf8>   its name (or brand)
//   x, y      float32                    m, in the cell's frame
//   building  int32                      its row in the cell's buildings

import { Int32, makeData, Uint16, Uint8 } from "apache-arrow";
import {
  column, dictionaryStrings, f32, f64, readTable, toIPC, utf8Dictionary, values, type FileMetadata,
} from "./arrow-util.ts";
import type { Buildings } from "./buildings.ts";
import type { Projection } from "./projection.ts";

/** The OSM keys that make something a point of interest (as cellgen's POI_KEYS). */
export const POI_CATEGORIES = ["shop", "amenity", "office", "tourism", "craft", "leisure", "healthcare"] as const;
export type PoiCategory = (typeof POI_CATEGORIES)[number];

/** Not in a building, but this close to one (m): it's that building's. */
export const ASSIGN_DISTANCE = 25;

/** A stored point of interest (a Postgres row). */
export interface PoiInput {
  osmId: number;
  category: PoiCategory;
  kind: string;
  name: string | null;
  brand: string | null;
  lon: number;
  lat: number;
}

export interface Pois {
  count: number;
  osmId: Float64Array;
  category: Uint8Array;  // index into POI_CATEGORIES
  kind: Uint16Array;     // index into kinds
  name: Uint16Array;     // index into names
  x: Float32Array;
  y: Float32Array;
  building: Int32Array;  // row in the cell's buildings
  kinds: string[];
  names: string[];
}

export const emptyPois = (): Pois => ({
  count: 0, osmId: new Float64Array(0), category: new Uint8Array(0), kind: new Uint16Array(0), name: new Uint16Array(0),
  x: new Float32Array(0), y: new Float32Array(0), building: new Int32Array(0), kinds: [], names: [],
});

/** The points of interest in a cell's buildings (rows of `b`, already in its frame), in input order. */
export function buildPois(inputs: PoiInput[], b: Buildings, project: Projection): Pois {
  const rows: { p: PoiInput; x: number; y: number; building: number }[] = [];
  const bounds = buildingBounds(b);
  for (const p of inputs) {
    const text = p.name ?? p.brand;
    if (!text) continue;
    const [x, y] = project(p.lon, p.lat);
    const building = assign(b, bounds, x, y);
    if (building >= 0) rows.push({ p, x, y, building });
  }
  const kinds: string[] = [], names: string[] = [];
  const index = (list: string[], s: string) => {
    let i = list.indexOf(s);
    if (i < 0) i = list.push(s) - 1;
    return i;
  };
  const out: Pois = {
    count: rows.length, osmId: new Float64Array(rows.length), category: new Uint8Array(rows.length),
    kind: new Uint16Array(rows.length), name: new Uint16Array(rows.length), x: new Float32Array(rows.length),
    y: new Float32Array(rows.length), building: new Int32Array(rows.length), kinds, names,
  };
  rows.forEach(({ p, x, y, building }, i) => {
    out.osmId[i] = p.osmId;
    out.category[i] = POI_CATEGORIES.indexOf(p.category);
    out.kind[i] = index(kinds, p.kind);
    out.name[i] = index(names, (p.name ?? p.brand)!);
    out.x[i] = x;
    out.y[i] = y;
    out.building[i] = building;
  });
  return out;
}

/**
 * The building row a point is in (the smallest ground-floor polygon holding it), else the nearest within
 * ASSIGN_DISTANCE; −1 for none.
 */
function assign(b: Buildings, bounds: Float32Array, x: number, y: number): number {
  let best = -1, bestArea = Infinity, near = -1, nearD = ASSIGN_DISTANCE;
  for (let i = 0; i < b.count; i++) {
    if (b.minHeight[i]! > 0.5) continue;  // up in the air: not where the door is
    const [x0, y0, x1, y1] = [bounds[4 * i]!, bounds[4 * i + 1]!, bounds[4 * i + 2]!, bounds[4 * i + 3]!];
    if (x < x0 - nearD || x > x1 + nearD || y < y0 - nearD || y > y1 + nearD) continue;
    const r = b.ringStart[i]!, a = b.pointStart[r]!, e = b.pointStart[r + 1]!;
    if (inRing(b.points, a, e, x, y)) {
      const area = (x1 - x0) * (y1 - y0);
      if (area < bestArea) [best, bestArea] = [i, area];
    } else if (best < 0) {
      const d = ringDistance(b.points, a, e, x, y);
      if (d < nearD) [near, nearD] = [i, d];
    }
  }
  return best >= 0 ? best : near;
}

/** Each building row's outer ring's box (x0, y0, x1, y1). */
function buildingBounds(b: Buildings): Float32Array {
  const out = new Float32Array(4 * b.count);
  for (let i = 0; i < b.count; i++) {
    const r = b.ringStart[i]!, a = b.pointStart[r]!, e = b.pointStart[r + 1]!;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = a; k < e; k++) {
      const x = b.points[2 * k]!, y = b.points[2 * k + 1]!;
      [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
    }
    out.set([x0, y0, x1, y1], 4 * i);
  }
  return out;
}

function inRing(pts: ArrayLike<number>, a: number, e: number, x: number, y: number): boolean {
  let inside = false;
  for (let i = a, j = e - 1; i < e; j = i++) {
    const xi = pts[2 * i]!, yi = pts[2 * i + 1]!, xj = pts[2 * j]!, yj = pts[2 * j + 1]!;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance from a point to an open ring's edges. */
function ringDistance(pts: ArrayLike<number>, a: number, e: number, x: number, y: number): number {
  let best = Infinity;
  for (let i = a, j = e - 1; i < e; j = i++) {
    const [px, py, qx, qy] = [pts[2 * j]!, pts[2 * j + 1]!, pts[2 * i]!, pts[2 * i + 1]!];
    const dx = qx - px, dy = qy - py, len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - px) * dx + (y - py) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(x - (px + t * dx), y - (py + t * dy)));
  }
  return best;
}

// --- Arrow -------------------------------------------------------------------------

export function poisToArrow(p: Pois, metadata: FileMetadata): Uint8Array {
  return toIPC({
    osm_id: f64(p.osmId),
    category: utf8Dictionary(0, new Uint8(), p.category, POI_CATEGORIES),
    kind: utf8Dictionary(1, new Uint16(), p.kind, p.kinds),
    name: utf8Dictionary(2, new Uint16(), p.name, p.names),
    x: f32(p.x),
    y: f32(p.y),
    building: makeData({ type: new Int32(), length: p.count, nullCount: 0, data: p.building }),
  }, p.count, metadata);
}

export function poisFromArrow(bytes: Uint8Array): Pois {
  const { table } = readTable(bytes, "pois");
  const count = table.numRows;
  const c = (name: string) => column(table, name, "pois");
  if (dictionaryStrings(c("category"), "pois.category").join() !== POI_CATEGORIES.join()) {
    throw new Error("pois.category: dictionary does not match");
  }
  return {
    count,
    osmId: values(c("osm_id"), count, Float64Array, "pois.osm_id"),
    category: values(c("category"), count, Uint8Array, "pois.category"),
    kind: values(c("kind"), count, Uint16Array, "pois.kind"),
    name: values(c("name"), count, Uint16Array, "pois.name"),
    x: values(c("x"), count, Float32Array, "pois.x"),
    y: values(c("y"), count, Float32Array, "pois.y"),
    building: values(c("building"), count, Int32Array, "pois.building"),
    kinds: count > 0 ? dictionaryStrings(c("kind"), "pois.kind") : [],
    names: count > 0 ? dictionaryStrings(c("name"), "pois.name") : [],
  };
}

