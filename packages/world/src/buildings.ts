// Buildings as a columnar table: one row per polygon (a multipolygon building
// with several outer rings becomes several rows sharing an OSM id), with its
// rings and points in nested CSR arrays, projected to a frame's meters.
//
// Ring convention: rings are open (no repeated closing point), the first ring
// of a row is the outer ring, counterclockwise; the rest are holes, clockwise.
// Downstream code (wall normals, triangulation) relies on this.

import type { Projection } from "./projection.ts";

export const BUILDINGS_VERSION = 3;

/** Where a building's height came from. */
export const HEIGHT_SOURCES = ["height", "levels", "default"] as const;
/** OSM roof:shape values we tell apart ("" for none or another); a building's roof shape is an index into this. */
export const ROOF_SHAPES = [
  "", "flat", "gabled", "hipped", "pyramidal", "skillion", "half-hipped", "gambrel", "mansard", "round", "dome", "onion",
] as const;
export type HeightSource = (typeof HEIGHT_SOURCES)[number];

export const OSM_TYPES = ["way", "relation"] as const;
export type OsmType = (typeof OSM_TYPES)[number];

/** What the table needs from a stored building (a Postgres row). */
export interface BuildingInput {
  osmType: OsmType;
  osmId: number;
  kind: string;            // the building / building:part tag value
  isPart: boolean;
  height: number;          // m above ground, top of the walls
  minHeight: number;       // m above ground, bottom of the walls
  heightSource: HeightSource;
  levels?: number | null;     // building:levels (above ground), if tagged
  minLevel?: number | null;   // building:min_level, if tagged
  roofShape?: string | null;  // roof:shape, if tagged
  polygons: [lon: number, lat: number][][][];  // polygon → rings (outer first) → points
}

export interface Buildings {
  count: number;            // rows (polygons)
  osmId: Float64Array;
  osmType: Uint8Array;      // index into OSM_TYPES
  kind: Uint16Array;        // index into kinds
  isPart: Uint8Array;       // 0 / 1
  height: Float32Array;
  minHeight: Float32Array;
  base: Float32Array;       // m up in the frame: the lowest ground under the outer ring (0 until draped)
  heightSource: Uint8Array; // index into HEIGHT_SOURCES
  levels: Float32Array;     // building:levels; NaN where not tagged
  minLevel: Float32Array;   // building:min_level; 0 where not tagged
  roofShape: Uint8Array;    // index into ROOF_SHAPES
  ringStart: Int32Array;    // count + 1 offsets into rings (CSR; Int32 like Arrow list offsets)
  pointStart: Int32Array;   // rings + 1 offsets into points
  points: Float32Array;     // x, y interleaved, m
  kinds: string[];          // in order of first appearance
}

/** Twice the signed area of an interleaved ring; positive when counterclockwise. */
export function signedArea2(xy: ArrayLike<number>, start = 0, end = xy.length / 2): number {
  let s = 0;
  for (let i = start, j = end - 1; i < end; j = i++) {
    s += xy[2 * j]! * xy[2 * i + 1]! - xy[2 * i]! * xy[2 * j + 1]!;
  }
  return s;
}

export function buildBuildings(inputs: BuildingInput[], project: Projection): Buildings {
  const kinds: string[] = [];
  const kindIndex = new Map<string, number>();
  const rows: { b: BuildingInput; kind: number; rings: number[][] }[] = [];

  for (const b of inputs) {
    let kind = kindIndex.get(b.kind);
    if (kind === undefined) {
      kind = kinds.push(b.kind) - 1;
      kindIndex.set(b.kind, kind);
    }
    for (const polygon of b.polygons) {
      const rings: number[][] = [];
      for (const [r, ring] of polygon.entries()) {
        const xy: number[] = [];
        for (const [lon, lat] of ring) {
          const [x, y] = project(lon, lat);
          const n = xy.length;
          if (n === 0 || x !== xy[n - 2] || y !== xy[n - 1]) xy.push(x, y);
        }
        // Open the ring: drop the closing point if it repeats the first.
        if (xy.length >= 4 && xy[0] === xy[xy.length - 2] && xy[1] === xy[xy.length - 1]) xy.length -= 2;
        if (xy.length < 6) {
          if (r === 0) break;  // a degenerate outer ring drops the whole polygon
          continue;
        }
        const ccw = signedArea2(xy) > 0;
        if (ccw !== (r === 0)) reverseRing(xy);
        rings.push(xy);
      }
      if (rings.length > 0) rows.push({ b, kind, rings });
    }
  }

  const count = rows.length;
  const ringTotal = rows.reduce((s, r) => s + r.rings.length, 0);
  const pointTotal = rows.reduce((s, r) => s + r.rings.reduce((t, ring) => t + ring.length / 2, 0), 0);
  const t: Buildings = {
    count,
    osmId: new Float64Array(count),
    osmType: new Uint8Array(count),
    kind: new Uint16Array(count),
    isPart: new Uint8Array(count),
    height: new Float32Array(count),
    minHeight: new Float32Array(count),
    base: new Float32Array(count),
    heightSource: new Uint8Array(count),
    levels: new Float32Array(count),
    minLevel: new Float32Array(count),
    roofShape: new Uint8Array(count),
    ringStart: new Int32Array(count + 1),
    pointStart: new Int32Array(ringTotal + 1),
    points: new Float32Array(pointTotal * 2),
    kinds,
  };
  let ring = 0, point = 0;
  for (const [i, { b, kind, rings }] of rows.entries()) {
    t.osmId[i] = b.osmId;
    t.osmType[i] = OSM_TYPES.indexOf(b.osmType);
    t.kind[i] = kind;
    t.isPart[i] = b.isPart ? 1 : 0;
    t.height[i] = b.height;
    t.minHeight[i] = b.minHeight;
    t.heightSource[i] = HEIGHT_SOURCES.indexOf(b.heightSource);
    t.levels[i] = b.levels ?? NaN;
    t.minLevel[i] = b.minLevel ?? 0;
    t.roofShape[i] = Math.max(0, ROOF_SHAPES.indexOf((b.roofShape ?? "") as (typeof ROOF_SHAPES)[number]));
    t.ringStart[i] = ring;
    for (const xy of rings) {
      t.pointStart[ring++] = point;
      t.points.set(xy, 2 * point);
      point += xy.length / 2;
    }
  }
  t.ringStart[count] = ring;
  t.pointStart[ringTotal] = point;
  return t;
}

function reverseRing(xy: number[]): void {
  for (let i = 0, j = xy.length / 2 - 1; i < j; i++, j--) {
    const x = xy[2 * i]!, y = xy[2 * i + 1]!;
    xy[2 * i] = xy[2 * j]!;
    xy[2 * i + 1] = xy[2 * j + 1]!;
    xy[2 * j] = x;
    xy[2 * j + 1] = y;
  }
}

// --- semantic groups (shared by the mesh and any future gameplay) -------------

export const BUILDING_GROUPS = ["residential", "commercial", "industrial", "civic", "utility", "other"] as const;
export type BuildingGroup = (typeof BUILDING_GROUPS)[number];

const GROUP_OF: Record<string, BuildingGroup> = {};
const groupKinds: Record<Exclude<BuildingGroup, "other">, string[]> = {
  residential: ["house", "detached", "semidetached_house", "terrace", "residential", "apartments", "dormitory", "bungalow", "duplex"],
  commercial: ["commercial", "retail", "office", "hotel", "supermarket", "kiosk", "mall"],
  industrial: ["industrial", "warehouse", "manufacture", "factory", "storage_tank"],
  civic: ["church", "cathedral", "chapel", "school", "university", "college", "kindergarten", "public", "civic",
          "government", "hospital", "fire_station", "train_station", "transportation", "stadium"],
  utility: ["garage", "garages", "shed", "carport", "roof", "parking", "hut", "service"],
};
for (const [g, ks] of Object.entries(groupKinds)) for (const k of ks) GROUP_OF[k] = g as BuildingGroup;

export const buildingGroup = (kind: string): BuildingGroup => GROUP_OF[kind] ?? "other";
