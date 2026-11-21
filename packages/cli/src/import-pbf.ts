// Bulk import from an OSM PBF extract (Geofabrik): every level-12 download
// cell the extract fully covers is imported exactly as if it had been
// downloaded from Overpass (same extractors, same per-cell import, recorded
// in osm_fetches as area "s2:<token>"), so the cell server never needs
// Overpass there. Cells crossing the extract's boundary are left to Overpass.
//
//   npm run cli -- import-pbf --file data/osm/pbf/colorado-latest.osm.pbf
//        [--poly <file>] [--within lat,lon,km] [--force]
//
// The PBF is read in three passes (nodes, relations, ways; ~6 s each for
// Colorado). Node coordinates go into sorted typed arrays; ways that any
// extractor wants (and the member ways of building relations) are kept and
// bucketed by the download cells their nodes fall in.

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { fetchAreas } from "@game/db";
import {
  blobData, buildingKind, isRoad, pbfBlocks, readHeader, readPrimitiveBlock,
  type OsmElement, type OsmNode, type OsmRelation, type OsmWay, type PbfVisitor,
} from "@game/osm-import";
import { cellCorners, cellFromLatLon, cellsWithin, cellToken, type CellId } from "@game/world";
import { cellBox, FETCH_LEVEL } from "./cells.ts";
import { importSnapshot } from "./import.ts";

type Ring = [lon: number, lat: number][];

const inflate = (z: Uint8Array) => inflateSync(z);

/** Osmosis .poly: named sections of "lon lat" lines; sections starting with "!" are holes. */
export function parsePoly(text: string): { outers: Ring[]; holes: Ring[] } {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const outers: Ring[] = [], holes: Ring[] = [];
  let ring: Ring | null = null, hole = false;
  for (const line of lines.slice(1)) {
    if (ring === null) {
      if (line === "END") break;
      ring = [];
      hole = line.startsWith("!");
    } else if (line === "END") {
      (hole ? holes : outers).push(ring);
      ring = null;
    } else {
      const [lon, lat] = line.split(/\s+/).map(Number);
      ring.push([lon!, lat!]);
    }
  }
  return { outers, holes };
}

function inRing(lon: number, lat: number, r: Ring): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i]!, [xj, yj] = r[j]!;
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Sorted node ids with their coordinates; lookups by binary search. */
class NodeIndex {
  count = 0;
  ids = new Float64Array(1 << 20);
  lat = new Float64Array(1 << 20);
  lon = new Float64Array(1 << 20);

  add(id: number, lat: number, lon: number): void {
    if (this.count === this.ids.length) {
      for (const k of ["ids", "lat", "lon"] as const) {
        const next = new Float64Array(this.ids.length * 2);
        next.set(this[k]);
        this[k] = next;
      }
    }
    if (this.count > 0 && id <= this.ids[this.count - 1]!) throw new Error("PBF nodes are not sorted by id");
    this.ids[this.count] = id;
    this.lat[this.count] = lat;
    this.lon[this.count] = lon;
    this.count++;
  }

  find(id: number): number {
    let lo = 0, hi = this.count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1, v = this.ids[mid]!;
      if (v === id) return mid;
      if (v < id) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }
}

export interface ImportPbfOptions {
  file: string;
  poly?: string;                                    // default: <file without -latest.osm.pbf>.poly
  within?: { lat: number; lon: number; km: number };  // only cells within this disk
  force?: boolean;                                  // re-import cells already imported
  concurrency?: number;
}

export async function importPbf(o: ImportPbfOptions, log: (msg: string) => void): Promise<void> {
  const t0 = performance.now();
  const elapsed = () => `${((performance.now() - t0) / 1000).toFixed(0)} s`;
  const file = await readFile(o.file);
  const fileSha = createHash("sha256").update(file).digest("hex");
  const polyPath = o.poly ?? o.file.replace(/-latest\.osm\.pbf$/, ".poly");
  const poly = parsePoly(await readFile(polyPath, "utf8"));
  const inside = (lon: number, lat: number) =>
    poly.outers.some((r) => inRing(lon, lat, r)) && !poly.holes.some((r) => inRing(lon, lat, r));
  const fetchedAt = (await stat(o.file)).mtime.toISOString();

  const blocks = [...pbfBlocks(file)];
  const header = readHeader(blobData(blocks[0]!.blob, inflate));
  if (!header.optionalFeatures.includes("Sort.Type_then_ID")) throw new Error("PBF must be sorted by type then id");
  const pass = (v: PbfVisitor) => {
    for (const b of blocks) if (b.type === "OSMData") readPrimitiveBlock(blobData(b.blob, inflate), v);
  };
  log(`${path.basename(o.file)}: ${(file.length / 1e6).toFixed(0)} MB, OSM data as of ${header.replicationTimestamp ?? "unknown"}`);

  // Pass 1: node coordinates.
  const nodes = new NodeIndex();
  pass({ node: (id, lat, lon) => nodes.add(id, lat, lon) });
  log(`${nodes.count} nodes indexed (${elapsed()})`);

  // Pass 2: building relations, and the ways they need.
  const relations: OsmRelation[] = [];
  const memberWays = new Set<number>();
  pass({
    relation(r) {
      if (r.tags?.type !== "multipolygon" || !buildingKind(r.tags)) return;
      relations.push(r);
      for (const m of r.members) if (m.type === "way") memberWays.add(m.ref);
    },
  });

  // Pass 3: ways an extractor wants, bucketed by the download cells their nodes are in.
  const ways: OsmWay[] = [];
  const wayIndex = new Map<number, number>();
  const wayCells: CellId[][] = [];
  const buckets = new Map<CellId, { ways: number[]; relations: number[] }>();
  const bucket = (c: CellId) => {
    let b = buckets.get(c);
    if (!b) buckets.set(c, (b = { ways: [], relations: [] }));
    return b;
  };
  pass({
    way(w) {
      if (!isRoad(w.tags) && !buildingKind(w.tags) && !memberWays.has(w.id)) return;
      const cells = new Set<CellId>();
      let last = -1;
      for (const id of w.nodes) {
        const n = nodes.find(id);
        if (n < 0) continue;
        // Consecutive nodes are usually in the same cell; skip the S2 math when they are very close.
        if (last >= 0 && Math.abs(nodes.lat[n]! - nodes.lat[last]!) < 1e-4 && Math.abs(nodes.lon[n]! - nodes.lon[last]!) < 1e-4
            && cells.size === 1) continue;
        cells.add(cellFromLatLon(nodes.lat[n]!, nodes.lon[n]!, FETCH_LEVEL));
        last = n;
      }
      const i = ways.push(w) - 1;
      wayIndex.set(w.id, i);
      wayCells.push([...cells]);
      if (isRoad(w.tags) || buildingKind(w.tags)) for (const c of cells) bucket(c).ways.push(i);
    },
  });
  relations.forEach((r, ri) => {
    const cells = new Set<CellId>();
    for (const m of r.members) {
      const i = m.type === "way" ? wayIndex.get(m.ref) : undefined;
      if (i !== undefined) for (const c of wayCells[i]!) cells.add(c);
    }
    for (const c of cells) bucket(c).relations.push(ri);
  });
  log(`${ways.length} ways and ${relations.length} building relations kept, in ${buckets.size} download cells (${elapsed()})`);

  // Which cells: inside the extract (corners and edge midpoints), optionally near a point.
  const fullyInside = (c: CellId) => {
    const k = cellCorners(c);
    const pts = k.flatMap((p, i) => {
      const q = k[(i + 1) % 4]!;
      return [p, { lat: (p.lat + q.lat) / 2, lon: (p.lon + q.lon) / 2 }];
    });
    return pts.every((p) => inside(p.lon, p.lat));
  };
  let candidates: CellId[];
  if (o.within) {
    candidates = cellsWithin(o.within.lat, o.within.lon, o.within.km * 1000, FETCH_LEVEL).map((c) => c.cell);
  } else {
    // Every cell over the extract: start inside it and cover its bounding circle.
    const all = poly.outers.flat();
    const lats = all.map((p) => p[1]), lons = all.map((p) => p[0]);
    const lat = (Math.min(...lats) + Math.max(...lats)) / 2, lon = (Math.min(...lons) + Math.max(...lons)) / 2;
    const r = Math.hypot((Math.max(...lats) - lat) * 111_000, (Math.max(...lons) - lon) * 111_000 * Math.cos((lat * Math.PI) / 180));
    candidates = cellsWithin(lat, lon, r, FETCH_LEVEL).map((c) => c.cell);
  }
  const done = o.force ? new Set<string>() : await fetchAreas("s2:");
  const todo = candidates.filter((c) => fullyInside(c) && !done.has(`s2:${cellToken(c)}`));
  log(`${todo.length} cells to import (${candidates.length} candidates; ` +
      `${candidates.filter((c) => !fullyInside(c)).length} outside or on the extract's edge, left to Overpass) (${elapsed()})`);

  // Import, a few cells at a time.
  const osmNode = (id: number): OsmNode | undefined => {
    const n = nodes.find(id);
    return n < 0 ? undefined : { type: "node", id, lat: nodes.lat[n]!, lon: nodes.lon[n]! };
  };
  const elementsOf = (c: CellId): OsmElement[] => {
    const b = buckets.get(c);
    if (!b) return [];
    const wayIds = new Set(b.ways);
    const rels = b.relations.map((ri) => relations[ri]!);
    for (const r of rels) for (const m of r.members) {
      const i = m.type === "way" ? wayIndex.get(m.ref) : undefined;
      if (i !== undefined) wayIds.add(i);
    }
    const ws = [...wayIds].map((i) => ways[i]!);
    const nodeIds = new Set(ws.flatMap((w) => w.nodes));
    const ns = [...nodeIds].map(osmNode).filter((n): n is OsmNode => n !== undefined);
    return [...ns, ...ws, ...rels];
  };
  let next = 0, imported = 0;
  const worker = async () => {
    while (next < todo.length) {
      const c = todo[next++]!;
      const token = cellToken(c);
      await importSnapshot(elementsOf(c), {
        area: `s2:${token}`, bbox: cellBox(c, 50), source: path.basename(o.file),
        osmBaseTimestamp: header.replicationTimestamp ?? null, fetchedAt,
        sha256: createHash("sha256").update(`${fileSha}:${token}`).digest("hex"),
      }, () => {}, { deleteMissing: false });  // batches are by cell, not by box: see ImportOptions
      if (++imported % 500 === 0 || imported === todo.length) log(`imported ${imported} / ${todo.length} cells (${elapsed()})`);
    }
  };
  await Promise.all(Array.from({ length: o.concurrency ?? 8 }, worker));
  log(`done (${elapsed()})`);
}
