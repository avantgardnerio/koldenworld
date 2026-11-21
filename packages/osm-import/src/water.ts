// Raw OSM → water: areas (lakes, reservoirs, ponds, river surfaces) and
// waterways mapped as lines (rivers, streams, canals, ditches).
//
// Areas: closed ways and multipolygon relations tagged natural=water,
// waterway=riverbank (the older tagging for river surfaces), or
// landuse=reservoir/basin. `kind` says how the surface is drawn: "lake" is
// flat at one level, "river" follows the ground downstream.
//
// Lines: waterway=river/stream/canal/ditch/drain, not tunnelled (culverts are
// underground). Width from width=* when tagged, else a default by kind.

import { assembleRings, pointInRing } from "./buildings.ts";
import type { OsmElement, OsmNode, OsmRelation, OsmWay, Tags } from "./osm.ts";

export type WaterAreaKind = "lake" | "river";

export interface WaterArea {
  osmType: "way" | "relation";
  osmId: number;
  kind: WaterAreaKind;
  name: string | null;
  polygons: [lon: number, lat: number][][][];  // polygon → rings (outer first) → points
  tags: Tags;
}

export interface Waterway {
  osmWayId: number;
  kind: string;       // waterway=* value
  name: string | null;
  width: number;      // m
  points: [lon: number, lat: number][];
  tags: Tags;
}

const RIVER_WATER = new Set(["river", "stream", "canal", "rapids", "ditch", "drain", "stream_pool", "oxbow"]);

/** Whether tags describe a water area, and how its surface is drawn. */
export function waterAreaKind(tags: Tags | undefined): WaterAreaKind | undefined {
  if (!tags) return undefined;
  if (tags.waterway === "riverbank") return "river";
  if (tags.natural === "water") return RIVER_WATER.has(tags.water ?? "") ? "river" : "lake";
  if (tags.landuse === "reservoir" || tags.landuse === "basin") return "lake";
  return undefined;
}

/** m; streams are narrow, rivers mapped only as a line are usually modest */
export const WATERWAY_WIDTH: Record<string, number> = {
  river: 12, canal: 6, stream: 2.5, ditch: 1.5, drain: 1.5,
};

export function isWaterway(tags: Tags | undefined): boolean {
  return tags?.waterway !== undefined && tags.waterway in WATERWAY_WIDTH
    && (tags.tunnel === undefined || tags.tunnel === "no") && tags.intermittent !== "yes";
}

function parseWidth(v: string | undefined): number | undefined {
  const m = v === undefined ? null : /^(\d+(?:\.\d+)?)\s*(m)?$/.exec(v.trim());
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 && n < 2000 ? n : undefined;
}

export interface WaterStats {
  areas: number;
  lines: number;
  skipped: number;  // missing nodes, rings that never close
}

export function extractWater(elements: OsmElement[]): { areas: WaterArea[]; lines: Waterway[]; stats: WaterStats } {
  const nodes = new Map<number, OsmNode>();
  const ways = new Map<number, OsmWay>();
  const relations: OsmRelation[] = [];
  for (const e of elements) {
    if (e.type === "node") nodes.set(e.id, e);
    else if (e.type === "way") ways.set(e.id, e);
    else if (e.tags?.type === "multipolygon" && waterAreaKind(e.tags)) relations.push(e);
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

  const areas: WaterArea[] = [];
  const lines: Waterway[] = [];
  let skipped = 0;
  for (const w of ways.values()) {
    const kind = waterAreaKind(w.tags);
    if (kind) {
      const ring = w.nodes.length >= 4 && w.nodes[0] === w.nodes.at(-1) ? coords(w.nodes) : undefined;
      if (ring) areas.push({ osmType: "way", osmId: w.id, kind, name: w.tags!.name ?? null, polygons: [[ring]], tags: w.tags! });
      else skipped++;
    } else if (isWaterway(w.tags)) {
      const pts = coords(w.nodes);
      if (!pts || pts.length < 2) { skipped++; continue; }
      const kind = w.tags!.waterway!;
      lines.push({
        osmWayId: w.id, kind, name: w.tags!.name ?? null,
        width: parseWidth(w.tags!.width) ?? WATERWAY_WIDTH[kind]!, points: pts, tags: w.tags!,
      });
    }
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
      polygons.find((p) => pointInRing(x, y, p[0]!))?.push(inner!);
    }
    areas.push({ osmType: "relation", osmId: r.id, kind: waterAreaKind(r.tags)!, name: r.tags!.name ?? null, polygons, tags: r.tags! });
  }
  return { areas, lines, stats: { areas: areas.length, lines: lines.length, skipped } };
}
