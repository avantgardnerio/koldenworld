// Raw OSM → buildings with resolved heights.
//
// Sources: closed ways tagged building=* or building:part=*, and multipolygon
// relations with the same tags (outer/inner member ways, joined into rings).
// Buildings with parts are kept here; choosing parts over their outline is an
// export decision, since it depends on which parts exist in the selection.
//
// Height, in order: height=* (top of the walls), building:levels × 3 m, a
// default by kind. min_height=* or building:min_level × 3 m lifts the bottom
// (parts of towers, overhangs). The source is recorded so estimated heights
// stay visible downstream.

import type { BuildingInput, HeightSource } from "@game/world";
import type { OsmElement, OsmNode, OsmRelation, OsmWay, Tags } from "./osm.ts";

export const LEVEL_HEIGHT = 3;  // m per storey

// m, used when neither height nor levels is tagged
const DEFAULT_HEIGHT: Record<string, number> = {
  house: 6, detached: 6, semidetached_house: 6, bungalow: 4, terrace: 7, duplex: 7,
  residential: 8, apartments: 12, dormitory: 12,
  garage: 3, garages: 3, shed: 2.5, carport: 3, roof: 4, hut: 3,
  commercial: 8, retail: 5, office: 12, hotel: 15, supermarket: 6, kiosk: 3,
  industrial: 8, warehouse: 9, manufacture: 9,
  church: 12, cathedral: 20, chapel: 8, school: 8, university: 12, college: 10, kindergarten: 4,
  public: 8, civic: 8, government: 10, hospital: 15, fire_station: 7, parking: 10,
};
const FALLBACK_HEIGHT = 6;

export interface OsmBuilding extends BuildingInput {
  name: string | null;
  levels: number | null;
  tags: Tags;
}

export interface BuildingStats {
  buildings: number;
  parts: number;
  byHeightSource: Record<HeightSource, number>;
  skipped: number;  // unclosed ways, missing nodes, relations without a closed outer ring
}

/** "12", "12 m", "12.5m", "40'", "40 ft", "12'6\"" → meters; undefined if unparseable or not positive. */
export function parseHeight(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const s = v.trim().replace(",", ".");
  let m = /^(\d+(?:\.\d+)?)\s*(m|meters?|metres?)?$/i.exec(s);
  if (m) return pos(Number(m[1]));
  m = /^(\d+(?:\.\d+)?)\s*(ft|feet|')$/i.exec(s);
  if (m) return pos(Number(m[1]) * 0.3048);
  m = /^(\d+)\s*'\s*(\d+(?:\.\d+)?)\s*"?$/.exec(s);
  if (m) return pos(Number(m[1]) * 0.3048 + Number(m[2]) * 0.0254);
  return undefined;
}

const pos = (n: number) => (Number.isFinite(n) && n > 0 ? n : undefined);
const parseLevels = (v: string | undefined) => {
  if (v === undefined) return undefined;
  const n = Number(v.trim().replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

export function buildingKind(tags: Tags | undefined): { kind: string; isPart: boolean } | undefined {
  if (!tags) return undefined;
  const b = tags.building, p = tags["building:part"];
  if (b !== undefined && b !== "no") return { kind: b, isPart: false };
  if (p !== undefined && p !== "no") return { kind: p, isPart: true };
  return undefined;
}

export function buildingHeights(tags: Tags, kind: string): {
  height: number; minHeight: number; heightSource: HeightSource; levels: number | null;
} {
  const levels = parseLevels(tags["building:levels"]);
  const tagged = parseHeight(tags.height ?? tags["building:height"]);
  let height: number, heightSource: HeightSource;
  if (tagged !== undefined) [height, heightSource] = [tagged, "height"];
  else if (levels !== undefined && levels > 0) [height, heightSource] = [levels * LEVEL_HEIGHT, "levels"];
  else [height, heightSource] = [DEFAULT_HEIGHT[kind] ?? FALLBACK_HEIGHT, "default"];

  const minLevel = parseLevels(tags["building:min_level"]);
  let minHeight = parseHeight(tags.min_height) ?? (minLevel !== undefined ? minLevel * LEVEL_HEIGHT : 0);
  // An untagged height above a lifted bottom: stack the estimate on top of it.
  if (heightSource !== "height" && minHeight > 0) height += minHeight;
  if (minHeight >= height) minHeight = 0;
  return { height, minHeight, heightSource, levels: levels ?? null };
}

/**
 * Joins member ways into closed rings by matching endpoints. Ways that never
 * close are dropped. Returns node id lists, each closed (first = last).
 */
export function assembleRings(ways: number[][]): number[][] {
  const pending = ways.filter((w) => w.length >= 2).map((w) => [...w]);
  const rings: number[][] = [];
  while (pending.length > 0) {
    const ring = pending.pop()!;
    let grown = true;
    while (ring[0] !== ring.at(-1) && grown) {
      grown = false;
      for (let i = 0; i < pending.length; i++) {
        const w = pending[i]!;
        const end = ring.at(-1)!;
        if (w[0] === end) ring.push(...w.slice(1));
        else if (w.at(-1) === end) ring.push(...w.slice(0, -1).reverse());
        else continue;
        pending.splice(i, 1);
        grown = true;
        break;
      }
    }
    if (ring.length >= 4 && ring[0] === ring.at(-1)) rings.push(ring);
  }
  return rings;
}

export function pointInRing(x: number, y: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!, [xj, yj] = ring[j]!;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function extractBuildings(elements: OsmElement[]): { buildings: OsmBuilding[]; stats: BuildingStats } {
  const nodes = new Map<number, OsmNode>();
  const ways = new Map<number, OsmWay>();
  const relations: OsmRelation[] = [];
  for (const e of elements) {
    if (e.type === "node") nodes.set(e.id, e);
    else if (e.type === "way") ways.set(e.id, e);
    else if (e.tags?.type === "multipolygon" && buildingKind(e.tags)) relations.push(e);
  }

  const coords = (ids: number[]): [number, number][] | undefined => {
    const out: [number, number][] = [];
    for (const id of ids) {
      const n = nodes.get(id);
      if (!n) return undefined;
      out.push([n.lon, n.lat]);
    }
    return out;
  };

  const buildings: OsmBuilding[] = [];
  let skipped = 0;
  const make = (osmType: "way" | "relation", osmId: number, tags: Tags, polygons: [number, number][][][]) => {
    const { kind, isPart } = buildingKind(tags)!;
    buildings.push({
      osmType, osmId, kind, isPart, name: tags.name ?? null,
      ...buildingHeights(tags, kind), polygons, tags,
    });
  };

  for (const w of ways.values()) {
    if (!buildingKind(w.tags)) continue;
    const ring = w.nodes.length >= 4 && w.nodes[0] === w.nodes.at(-1) ? coords(w.nodes) : undefined;
    if (!ring) { skipped++; continue; }
    make("way", w.id, w.tags!, [[ring]]);
  }

  for (const r of relations) {
    const members = (role: string) => r.members
      .filter((m) => m.type === "way" && m.role === role && ways.has(m.ref))
      .map((m) => ways.get(m.ref)!.nodes);
    const outers = assembleRings(members("outer")).map(coords);
    const inners = assembleRings(members("inner")).map(coords);
    if (outers.length === 0 || outers.some((o) => !o) || inners.some((i) => !i)) { skipped++; continue; }
    const polygons: [number, number][][][] = outers.map((o) => [o!]);
    for (const inner of inners) {
      const [x, y] = inner![0]!;
      const owner = polygons.find((p) => pointInRing(x, y, p[0]!));
      owner?.push(inner!);
    }
    make("relation", r.id, r.tags!, polygons);
  }

  const byHeightSource: Record<HeightSource, number> = { height: 0, levels: 0, default: 0 };
  for (const b of buildings) byHeightSource[b.heightSource]++;
  return {
    buildings,
    stats: { buildings: buildings.filter((b) => !b.isPart).length, parts: buildings.filter((b) => b.isPart).length, byHeightSource, skipped },
  };
}
