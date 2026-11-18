// Postgres road ways and buildings → map tables → Arrow files in data/export/<area>/.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { latestFetch, loadBuildings, loadRoadWays } from "@game/db";
import {
  buildBuildings, buildingsFromArrow, buildingsToArrow, BUILDINGS_VERSION, buildRoadGraph, componentSizes,
  HEIGHT_SOURCES, ROAD_CLASSES, ROAD_GRAPH_VERSION, roadGraphFromArrow, roadGraphToArrow,
} from "@game/world";
import { exportDir } from "./paths.ts";

const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;

export async function exportArea(area: string, log: (msg: string) => void): Promise<void> {
  const fetch = await latestFetch(area);
  const ways = await loadRoadWays(fetch.bbox);
  const origin = {
    lat: (fetch.bbox.south + fetch.bbox.north) / 2,
    lon: (fetch.bbox.west + fetch.bbox.east) / 2,
  };
  const source = { fetchSha256: fetch.sha256, osmBaseTimestamp: fetch.osmBaseTimestamp };
  const graph = buildRoadGraph(ways, origin);
  const graphFiles = roadGraphToArrow(graph, { area, origin, bbox: fetch.bbox, roadGraphVersion: ROAD_GRAPH_VERSION, source });
  const buildingInputs = await loadBuildings(fetch.bbox);
  const buildings = buildBuildings(buildingInputs, origin);
  const buildingFile = buildingsToArrow(buildings, { area, origin, bbox: fetch.bbox, buildingsVersion: BUILDINGS_VERSION, source });
  const files: Record<string, Uint8Array> = { ...graphFiles, buildings: buildingFile };

  // Read back before writing anything: the files must reproduce the tables exactly.
  const back = roadGraphFromArrow(graphFiles).graph;
  if (back.nodes.count !== graph.nodes.count || back.edges.count !== graph.edges.count
      || back.points.length !== graph.points.length) {
    throw new Error("Arrow round-trip changed the graph");
  }
  const backB = buildingsFromArrow(buildingFile).buildings;
  if (backB.count !== buildings.count || backB.points.length !== buildings.points.length) {
    throw new Error("Arrow round-trip changed the buildings");
  }

  const dir = exportDir(area);
  await mkdir(dir, { recursive: true });
  const manifest: Record<string, { bytes: number; sha256: string }> = {};
  for (const [table, bytes] of Object.entries(files)) {
    await writeFile(path.join(dir, `${table}.arrow`), bytes);
    manifest[table] = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify({ area, origin, files: manifest }, null, 2) + "\n");

  const components = componentSizes(graph);
  const degree = new Map<number, number>();
  for (let n = 0; n < graph.nodes.count; n++) {
    const d = graph.nodes.edgeStart[n + 1]! - graph.nodes.edgeStart[n]!;
    degree.set(d, (degree.get(d) ?? 0) + 1);
  }
  const byClass = new Map<string, number>();
  for (let i = 0; i < graph.edges.count; i++) {
    const c = ROAD_CLASSES[graph.edges.class[i]!]!;
    byClass.set(c, (byClass.get(c) ?? 0) + 1);
  }

  log(`${ways.length} ways → ${graph.nodes.count} nodes, ${graph.edges.count} edges, ` +
      `${graph.points.length / 2} points, ${graph.names.length - 1} names`);
  log(`edges by class: ${[...byClass].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(", ")}`);
  const sources = new Map<string, number>();
  for (let i = 0; i < buildings.count; i++) {
    const k = HEIGHT_SOURCES[buildings.heightSource[i]!]!;
    sources.set(k, (sources.get(k) ?? 0) + 1);
  }
  log(`${buildingInputs.length} buildings and parts (outlines with parts left out) → ${buildings.count} polygons, ` +
      `${buildings.ringStart[buildings.count]} rings, ${buildings.points.length / 2} points; ` +
      `heights: ${[...sources].map(([k, n]) => `${k} ${n}`).join(", ")}`);
  log(`node degree: ${[...degree].sort((a, b) => a[0] - b[0]).map(([d, n]) => `${d}:${n}`).join("  ")}`);
  log(`components: ${components.length} (largest ${components.slice(0, 5).join(", ")}; ` +
      `${components.filter((s) => s <= 2).length} of size ≤ 2)`);
  for (const [table, bytes] of Object.entries(files)) {
    log(`${table}.arrow: ${kb(bytes.length)} raw, ${kb(gzipSync(bytes).length)} gzip, ` +
        `${kb(brotliCompressSync(bytes).length)} brotli`);
  }
  log(`wrote ${dir}`);
}
