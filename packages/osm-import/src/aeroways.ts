// Raw OSM → airport surfaces (decision 32): runways, taxiways and aprons.
//
// Areas: closed ways and multipolygon relations tagged aeroway=apron, and
// runways or taxiways mapped as areas (closed, area=yes, or a relation).
// Lines: aeroway=runway/taxiway/taxilane/stopway as center lines, with
// width=* when tagged, else a typical width by kind. Taxilanes (inside aprons)
// are taxiways here; stopways are drawn like runways.

import { assembleRings, pointInRing } from "./buildings.ts";
import type { OsmElement, OsmNode, OsmRelation, OsmWay, Tags } from "./osm.ts";

export type AerowayKind = "runway" | "taxiway" | "apron";

export interface AerowayArea {
  osmType: "way" | "relation";
  osmId: number;
  kind: AerowayKind;
  polygons: [lon: number, lat: number][][][];  // polygon → rings (outer first) → points
  tags: Tags;
}

export interface AerowayLine {
  osmWayId: number;
  kind: AerowayKind;
  ref: string | null;  // a runway's designators ("16R/34L"), a taxiway's letter
  width: number;       // m
  points: [lon: number, lat: number][];
  tags: Tags;
}

const LINE_KINDS: Record<string, Exclude<AerowayKind, "apron">> = {
  runway: "runway", stopway: "runway", taxiway: "taxiway", taxilane: "taxiway",
};

/** m, when untagged: a large airport's runway and taxiway; taxilanes between gates are narrower */
export const AEROWAY_WIDTH: Record<string, number> = { runway: 45, stopway: 45, taxiway: 23, taxilane: 15 };

/** Whether a closed way's tags make it a paved area, and of which kind. */
export function aerowayAreaKind(tags: Tags | undefined): AerowayKind | undefined {
  if (!tags?.aeroway) return undefined;
  if (tags.aeroway === "apron") return "apron";
  if (tags.area === "yes" || tags.type === "multipolygon") return LINE_KINDS[tags.aeroway];
  return undefined;
}

/** Whether a way is an airport center line (runway, taxiway, …). */
export function isAerowayLine(tags: Tags | undefined): boolean {
  return tags?.aeroway !== undefined && tags.aeroway in LINE_KINDS && tags.area !== "yes";
}

function parseWidth(v: string | undefined): number | undefined {
  const m = v === undefined ? null : /^(\d+(?:\.\d+)?)\s*(m)?$/.exec(v.trim());
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 && n < 500 ? n : undefined;
}

export interface AerowayStats {
  areas: number;
  lines: number;
  skipped: number;  // missing nodes, rings that never close
}

export function extractAeroways(elements: OsmElement[]): { areas: AerowayArea[]; lines: AerowayLine[]; stats: AerowayStats } {
  const nodes = new Map<number, OsmNode>();
  const ways = new Map<number, OsmWay>();
  const relations: OsmRelation[] = [];
  for (const e of elements) {
    if (e.type === "node") nodes.set(e.id, e);
    else if (e.type === "way") ways.set(e.id, e);
    else if (e.tags?.type === "multipolygon" && aerowayAreaKind(e.tags)) relations.push(e);
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

  const areas: AerowayArea[] = [];
  const lines: AerowayLine[] = [];
  let skipped = 0;
  for (const w of ways.values()) {
    const closed = w.nodes.length >= 4 && w.nodes[0] === w.nodes.at(-1);
    const kind = closed ? aerowayAreaKind(w.tags) : undefined;
    if (kind) {
      const ring = coords(w.nodes);
      if (ring) areas.push({ osmType: "way", osmId: w.id, kind, polygons: [[ring]], tags: w.tags! });
      else skipped++;
    } else if (isAerowayLine(w.tags)) {
      const pts = coords(w.nodes);
      if (!pts || pts.length < 2) { skipped++; continue; }
      const t = w.tags!;
      lines.push({
        osmWayId: w.id, kind: LINE_KINDS[t.aeroway!]!, ref: t.ref ?? null,
        width: parseWidth(t.width) ?? AEROWAY_WIDTH[t.aeroway!]!, points: pts, tags: t,
      });
    } else if (w.tags?.aeroway === "apron") {
      skipped++;  // an apron that isn't closed
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
    areas.push({ osmType: "relation", osmId: r.id, kind: aerowayAreaKind(r.tags)!, polygons, tags: r.tags! });
  }
  return { areas, lines, stats: { areas: areas.length, lines: lines.length, skipped } };
}
