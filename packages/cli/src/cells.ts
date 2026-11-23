// Cells on demand (decision 22). Asking for a cell's files:
//   1. makes sure OSM data covers the cell plus a margin: each level-FETCH_LEVEL
//      cell around it is fetched and imported into Postgres once, by the Rust
//      cell generator (GET /ensure/<token> on cellgen serve; CELLGEN_SERVER
//      overrides http://127.0.0.1:5175);
//   2. exports the cell (buildCell) from Postgres;
//   3. caches the files under data/export/cells/<token>/.
// Concurrent requests for the same cell or the same download share one promise.

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadBuildings, loadRoadWays, loadWater, type Bbox } from "@game/db";
import {
  BUILDINGS_VERSION, buildCell, carveWater, cellFromLatLon, drapeCell, groundSampler, enuUnprojection, type CellContents, CELL_TABLES, CELL_VERSION, cellCenter, cellCorners, cellLevel, cellsWithin, cellToArrow,
  cellToken, geodeticToEcef, ROAD_GRAPH_VERSION, type CellFiles, type CellId,
} from "@game/world";
import { Elevation } from "./elevation.ts";
import { DATA_DIR } from "./paths.ts";

/** Download unit: about 2.3 km across, a few MB to ~15 MB of raw OSM in a downtown. */
export const FETCH_LEVEL = 12;
/** Data needed around a cell, m: objects it owns reach past its edge, and ways are cut at neighbors' nodes. */
const MARGIN_M = 300;
const MANIFEST_VERSION = { cellVersion: CELL_VERSION, roadGraphVersion: ROAD_GRAPH_VERSION, buildingsVersion: BUILDINGS_VERSION };

const cellsDir = path.join(DATA_DIR, "export", "cells");
const cellgenServer = process.env.CELLGEN_SERVER ?? "http://127.0.0.1:5175";
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

/** A lat/lon box around everything a built cell owns (its objects reach past its edge), padded by a margin. */
function contentBox(c: CellContents, marginM: number): Bbox {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const pts of [c.graph.points, c.buildings.points]) {
    for (let i = 0; i < pts.length; i += 2) {
      x0 = Math.min(x0, pts[i]!); x1 = Math.max(x1, pts[i]!);
      y0 = Math.min(y0, pts[i + 1]!); y1 = Math.max(y1, pts[i + 1]!);
    }
  }
  const box = cellBox(c.cell, marginM);
  if (x0 > x1) return box;
  const back = enuUnprojection(c.frame);
  const corners = [back(x0 - marginM, y0 - marginM), back(x1 + marginM, y1 + marginM), back(x0 - marginM, y1 + marginM), back(x1 + marginM, y0 - marginM)];
  return {
    south: Math.min(box.south, ...corners.map((p) => p[1])), north: Math.max(box.north, ...corners.map((p) => p[1])),
    west: Math.min(box.west, ...corners.map((p) => p[0])), east: Math.max(box.east, ...corners.map((p) => p[0])),
  };
}

/** A box covering every cell (at `level`) that overlaps a box, whole. */
function cellsBox(b: Bbox, level: number): Bbox {
  const out = { ...b };
  const dLat = 150 / 111_000, dLon = dLat / Math.cos((((b.south + b.north) / 2) * Math.PI) / 180);
  const seen = new Set<CellId>();
  for (let lat = b.south; lat <= b.north + dLat; lat += dLat) {
    for (let lon = b.west; lon <= b.east + dLon; lon += dLon) {
      const c = cellFromLatLon(Math.min(lat, b.north), Math.min(lon, b.east), level);
      if (seen.has(c)) continue;
      seen.add(c);
      const cb = cellBox(c, 20);
      out.south = Math.min(out.south, cb.south); out.north = Math.max(out.north, cb.north);
      out.west = Math.min(out.west, cb.west); out.east = Math.max(out.east, cb.east);
    }
  }
  return out;
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

/** A cell's files from the disk cache, when they're there and current; no building. */
export async function cachedCell(cell: CellId): Promise<CellFiles | null> {
  const dir = path.join(cellsDir, cellToken(cell)), manifest = path.join(dir, "manifest.json");
  if (!existsSync(manifest)) return null;
  const m = JSON.parse(await readFile(manifest, "utf8")) as typeof MANIFEST_VERSION;
  if (!Object.entries(MANIFEST_VERSION).every(([k, v]) => m[k as keyof typeof m] === v)) return null;
  const files = await Promise.all(CELL_TABLES.map((t) => readFile(path.join(dir, `${t}.arrow`))));
  return Object.fromEntries(CELL_TABLES.map((t, i) => [t, files[i]!])) as unknown as CellFiles;
}

export class CellService {
  private fetches = new Map<CellId, Promise<void>>();
  private elevation: Elevation;
  private builds = new Map<CellId, Promise<CellFiles>>();

  private log: (msg: string) => void;
  private fetcher?: (fetchCell: CellId) => Promise<void>;

  /** fetcher: who makes sure OSM is downloaded (a worker asks the main thread, so each area downloads once). */
  constructor(log: (msg: string) => void, opts: { elevationBlocks?: number; fetcher?: (fetchCell: CellId) => Promise<void> } = {}) {
    this.log = log;
    this.elevation = new Elevation(opts.elevationBlocks);
    this.fetcher = opts.fetcher;
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
    return (await cachedCell(cell)) ?? this.build(cell, dir, path.join(dir, "manifest.json"));
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
    const flat = buildCell(cell, ways, buildingInputs);
    lap("build");
    // Objects reach into neighbors and are placed on the neighbors' terrain lattices, which need
    // elevation (and water, for carving) over those whole cells.
    const region = cellsBox(contentBox(flat, 100), cellLevel(cell));
    const [dem, water] = await Promise.all([this.elevation.region(region), loadWater(region)]);
    lap("dem+water");
    const ground = groundSampler(dem, cellLevel(cell), carveWater(water.areas));
    const draped = drapeCell(flat, ground);
    lap("drape");
    // The drawn ground (pavement, markings, grass, sidewalks, lots and water) comes from the Rust generator.
    const contents = draped;
    const files = cellToArrow(contents);
    lap("arrow");
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

  /** Makes sure the fetch cell's OSM is downloaded and imported, once. */
  ensureFetched(fetchCell: CellId): Promise<void> {
    if (this.fetcher) return this.fetcher(fetchCell);
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

  /** Asks the Rust cell generator to fetch and import the area (it does each once, one download at a time). */
  private async fetch(fetchCell: CellId): Promise<void> {
    const token = cellToken(fetchCell);
    const res = await fetch(`${cellgenServer}/ensure/${token}`);
    if (!res.ok) throw new Error(`area ${token}: ${res.status} ${await res.text()}`);
  }
}
