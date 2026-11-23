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
//   charity   float32                    how much it draws people with nowhere to live (charityWeight)

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

/** Social facilities by what they do (social_facility=*): how much each draws people with nowhere to live. */
const SOCIAL_FACILITY: Record<string, number> = {
  shelter: 4, soup_kitchen: 3, food_bank: 3, outreach: 2, healthcare: 1, community_centre: 1,
  // Homes for the old or the young, not drop-in services.
  group_home: 0, nursing_home: 0, assisted_living: 0, retirement_home: 0, childrens_centre: 0,
};
/**
 * Names (or operators, or brands) of the services people with nowhere to live go to: national networks, and big
 * local ones (Denver, Seattle, Austin), and words that say it outright. Names, not places: they work wherever OSM has
 * them.
 */
const CHARITY_NAMES = new RegExp([
  "rescue mission", "gospel mission", "salvation army", "catholic charities", "catholic community services",
  "volunteers of america", "united way", "coalition for the homeless", "st\\.? vincent de paul", "covenant house",
  "samaritan house", "st\\.? francis center", "urban peak", "mile high ministries",
  "mary's place", "downtown emergency service", "plymouth housing", "operation sack lunch",
  "front steps", "mobile loaves", "community first! village", "lifeworks",
  "soup kitchen", "food bank", "homeless", "day shelter", "drop-in center",
].join("|"), "i");
/** Kinds a charity's name doesn't make a draw: its schools and day cares. */
const NOT_SERVICES = new Set(["childcare", "kindergarten", "school"]);
/** Shelters that aren't for people with nowhere to live (families of patients). */
const NOT_HOMELESS = /ronald mcdonald house/i;

/**
 * How much a place draws people with nowhere to live, from its OSM tags (0: not at all): a shelter 4, a soup kitchen
 * or food bank 3, outreach 2, a charity's office 1, a thrift store 0.5; anything run by (or named for) a known
 * service at least 2.
 */
export function charityWeight(category: string, kind: string, tags: Record<string, string>): number {
  let w = 0;
  if (category === "amenity" && kind === "social_facility") {
    const what = tags.social_facility, forWhom = tags["social_facility:for"] ?? "";
    w = what === undefined ? 1 : SOCIAL_FACILITY[what] ?? 1;
    if (/homeless/.test(forWhom)) w = Math.max(w, 3);
    else if (/senior|child|juvenile|youth/.test(forWhom)) w = Math.min(w, 1);
  } else if (category === "amenity" && (kind === "food_bank" || kind === "soup_kitchen")) w = 3;
  else if (category === "office" && (kind === "charity" || kind === "ngo")) w = 1;
  else if (category === "shop" && kind === "charity") w = 0.5;
  const text = [tags.name, tags.brand, tags.operator].filter(Boolean).join(" ");
  if (CHARITY_NAMES.test(text) && !NOT_SERVICES.has(kind)) w = Math.max(w, 2);
  return NOT_HOMELESS.test(text) ? 0 : w;
}

/** A stored point of interest (a Postgres row). */
export interface PoiInput {
  osmId: number;
  category: PoiCategory;
  kind: string;
  name: string | null;
  brand: string | null;
  lon: number;
  lat: number;
  charity?: number;  // charityWeight; 0 if absent
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
  charity: Float32Array; // charityWeight
  kinds: string[];
  names: string[];
}

export const emptyPois = (): Pois => ({
  count: 0, osmId: new Float64Array(0), category: new Uint8Array(0), kind: new Uint16Array(0), name: new Uint16Array(0),
  x: new Float32Array(0), y: new Float32Array(0), building: new Int32Array(0), charity: new Float32Array(0), kinds: [], names: [],
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
    y: new Float32Array(rows.length), building: new Int32Array(rows.length), charity: new Float32Array(rows.length), kinds, names,
  };
  rows.forEach(({ p, x, y, building }, i) => {
    out.osmId[i] = p.osmId;
    out.category[i] = POI_CATEGORIES.indexOf(p.category);
    out.kind[i] = index(kinds, p.kind);
    out.name[i] = index(names, (p.name ?? p.brand)!);
    out.x[i] = x;
    out.y[i] = y;
    out.building[i] = building;
    out.charity[i] = p.charity ?? 0;
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

/** Whether a point is inside a ground-floor building (its outer ring); `bounds` from buildingBounds. */
export function inBuilding(b: Buildings, bounds: Float32Array, x: number, y: number): boolean {
  for (let i = 0; i < b.count; i++) {
    if (b.minHeight[i]! > 0.5) continue;
    if (x < bounds[4 * i]! || x > bounds[4 * i + 2]! || y < bounds[4 * i + 1]! || y > bounds[4 * i + 3]!) continue;
    const r = b.ringStart[i]!;
    if (inRing(b.points, b.pointStart[r]!, b.pointStart[r + 1]!, x, y)) return true;
  }
  return false;
}

/** Each building row's outer ring's box (x0, y0, x1, y1). */
export function buildingBounds(b: Buildings): Float32Array {
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
    charity: f32(p.charity),
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
    charity: values(c("charity"), count, Float32Array, "pois.charity"),
    kinds: count > 0 ? dictionaryStrings(c("kind"), "pois.kind") : [],
    names: count > 0 ? dictionaryStrings(c("name"), "pois.name") : [],
  };
}

