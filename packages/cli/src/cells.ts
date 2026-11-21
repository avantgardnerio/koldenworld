// Cells on demand (decision 22). Asking for a cell's files:
//   1. makes sure OSM data covers the cell plus a margin: each level-FETCH_LEVEL
//      cell around it is downloaded from Overpass once (one download at a time,
//      to be polite), saved under data/osm/s2/ and imported into Postgres;
//   2. exports the cell (buildCell) from Postgres;
//   3. caches the files under data/export/cells/<token>/.
// Concurrent requests for the same cell or the same download share one promise.

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fetchAreas, hasFetch, loadBuildings, loadRoadWays, type Bbox } from "@game/db";
import type { OverpassResponse } from "@game/osm-import";
import {
  BUILDINGS_VERSION, buildCell, CELL_TABLES, CELL_VERSION, cellCenter, cellCorners, cellLevel, cellsWithin, cellToArrow,
  cellToken, geodeticToEcef, ROAD_GRAPH_VERSION, type CellFiles, type CellId,
} from "@game/world";
import { downloadOverpass } from "./fetch-osm.ts";
import { importSnapshot } from "./import.ts";
import { DATA_DIR } from "./paths.ts";

/** Download unit: about 2.3 km across, a few MB to ~15 MB of raw OSM in a downtown. */
export const FETCH_LEVEL = 12;
/** Data needed around a cell, m: objects it owns reach past its edge, and ways are cut at neighbors' nodes. */
const MARGIN_M = 300;
const MANIFEST_VERSION = { cellVersion: CELL_VERSION, roadGraphVersion: ROAD_GRAPH_VERSION, buildingsVersion: BUILDINGS_VERSION };

const cellsDir = path.join(DATA_DIR, "export", "cells");
const rawDir = path.join(DATA_DIR, "osm", "s2");
const fetchArea = (fetchCell: CellId) => `s2:${cellToken(fetchCell)}`;

/** A lat/lon box around a cell's corners, grown by a margin in meters. */
export function cellBox(cell: CellId, marginM: number): Bbox {
  const pts = cellCorners(cell);
  const lats = pts.map((p) => p.lat), lons = pts.map((p) => p.lon);
  const lat = cellCenter(cell).lat;
  if (Math.max(...lons) - Math.min(...lons) > 180) throw new Error(`cell ${cellToken(cell)} crosses the antimeridian; not supported yet`);
  const dLat = marginM / 110_574, dLon = marginM / (111_320 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
  return {
    south: Math.max(-90, Math.min(...lats) - dLat), north: Math.min(90, Math.max(...lats) + dLat),
    west: Math.min(...lons) - dLon, east: Math.max(...lons) + dLon,
  };
}

/** The download cells whose data a cell's export needs: everything within its reach plus the margin. */
export function fetchCellsFor(cell: CellId): CellId[] {
  const c = cellCenter(cell);
  const p = geodeticToEcef({ ...c, h: 0 });
  const reach = Math.max(...cellCorners(cell).map((k) => {
    const q = geodeticToEcef({ ...k, h: 0 });
    return Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
  }));
  return cellsWithin(c.lat, c.lon, reach + MARGIN_M, FETCH_LEVEL).map((f) => f.cell);
}

async function writeAtomic(file: string, data: Uint8Array | string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

export class CellService {
  private queue: Promise<unknown> = Promise.resolve();  // downloads, one at a time
  private fetches = new Map<CellId, Promise<void>>();
  private covered?: Promise<Set<string>>;  // areas already imported, loaded once
  private builds = new Map<CellId, Promise<CellFiles>>();

  private log: (msg: string) => void;

  constructor(log: (msg: string) => void) {
    this.log = log;
  }

  /** The cell's files: from the disk cache, or generated (which may download OSM first). */
  files(cell: CellId): Promise<CellFiles> {
    let p = this.builds.get(cell);
    if (!p) {
      p = this.cachedOrBuild(cell).finally(() => this.builds.delete(cell));
      this.builds.set(cell, p);
    }
    return p;
  }

  private async cachedOrBuild(cell: CellId): Promise<CellFiles> {
    const dir = path.join(cellsDir, cellToken(cell));
    const manifest = path.join(dir, "manifest.json");
    if (existsSync(manifest)) {
      const m = JSON.parse(await readFile(manifest, "utf8")) as typeof MANIFEST_VERSION;
      if (Object.entries(MANIFEST_VERSION).every(([k, v]) => m[k as keyof typeof m] === v)) {
        const [nodes, edges, buildings] = await Promise.all(CELL_TABLES.map((t) => readFile(path.join(dir, `${t}.arrow`))));
        return { nodes: nodes!, edges: edges!, buildings: buildings! };
      }
    }
    return this.build(cell, dir, manifest);
  }

  private async build(cell: CellId, dir: string, manifest: string): Promise<CellFiles> {
    const token = cellToken(cell);
    const t0 = performance.now();
    const stage: string[] = [];
    let t = t0;
    const lap = (name: string) => {
      const now = performance.now();
      stage.push(`${name} ${(now - t).toFixed(0)}`);
      t = now;
    };
    await Promise.all(fetchCellsFor(cell).map((f) => this.ensureFetched(f)));
    lap("deps");
    const box = cellBox(cell, MARGIN_M);
    const [ways, buildingInputs] = await Promise.all([
      loadRoadWays(box).then((w) => { lap("roads"); return w; }),
      loadBuildings(box).then((b) => { lap("buildings"); return b; }),
    ]);
    const contents = buildCell(cell, ways, buildingInputs);
    const files = cellToArrow(contents);
    lap("build");
    await mkdir(dir, { recursive: true });
    for (const t of CELL_TABLES) await writeAtomic(path.join(dir, `${t}.arrow`), files[t]);
    await writeAtomic(manifest, JSON.stringify({
      cell: token, level: cellLevel(cell), ...MANIFEST_VERSION,
      edges: contents.graph.edges.count, buildings: contents.buildings.count,
      bytes: Object.fromEntries(CELL_TABLES.map((t) => [t, files[t].length])),
    }, null, 2) + "\n");
    lap("write");
    this.log(`cell ${token}: ${contents.graph.edges.count} edges, ${contents.buildings.count} buildings ` +
             `(${ways.length} ways, ${buildingInputs.length} buildings loaded; ${(performance.now() - t0).toFixed(0)} ms: ` +
             `${stage.join(", ")})`);
    return files;
  }

  private ensureFetched(fetchCell: CellId): Promise<void> {
    let p = this.fetches.get(fetchCell);
    if (!p) {
      p = this.fetch(fetchCell).catch((err: unknown) => {
        this.fetches.delete(fetchCell);  // let a later request try again
        throw err;
      });
      this.fetches.set(fetchCell, p);
    }
    return p;
  }

  private async fetch(fetchCell: CellId): Promise<void> {
    const area = fetchArea(fetchCell);
    this.covered ??= fetchAreas("s2:");
    if ((await this.covered).has(area) || await hasFetch(area)) return;
    const run = this.queue.then(() => this.download(fetchCell, area));
    this.queue = run.catch(() => {});
    await run;
  }

  private async download(fetchCell: CellId, area: string): Promise<void> {
    const token = cellToken(fetchCell);
    const bbox = cellBox(fetchCell, 50);  // cell edges are great-circle arcs: pad past the corner box
    this.log(`fetch ${token}: downloading from Overpass...`);
    const t0 = performance.now();
    const d = await downloadOverpass(bbox, this.log);
    const fetchedAt = new Date().toISOString();
    await mkdir(rawDir, { recursive: true });
    await writeAtomic(path.join(rawDir, `${token}.json`), d.body);
    await writeAtomic(path.join(rawDir, `${token}.meta.json`), JSON.stringify({
      cell: token, level: FETCH_LEVEL, bbox, query: d.query, source: d.source, osmBaseTimestamp: d.osmBaseTimestamp,
      fetchedAt, elements: d.elements, bytes: d.body.length, sha256: d.sha256,
    }, null, 2) + "\n");
    this.log(`fetch ${token}: ${d.elements} elements, ${(d.body.length / 1e6).toFixed(1)} MB in ` +
             `${((performance.now() - t0) / 1000).toFixed(0)} s; importing`);
    const raw = JSON.parse(d.body.toString("utf8")) as OverpassResponse;
    await importSnapshot(raw.elements, { area, bbox, source: d.source, osmBaseTimestamp: d.osmBaseTimestamp, fetchedAt, sha256: d.sha256 },
      (m) => this.log(`fetch ${token}: ${m}`));
  }
}
