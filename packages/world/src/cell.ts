// Cells: the unit the world is cut into, exported, served and streamed
// (decisions 20, 21). A cell is an S2 cell at CELL_LEVEL; its contents are
// everything it owns, in meters in the cell's own ENU frame.
//
// Ownership is by one point per object, so every object lands in exactly one
// cell no matter which neighbors are exported or loaded:
// - a road edge by the middle of its points (see buildRoadGraph),
// - a building polygon by the centroid of its building's first outer ring.
// Objects reach past their cell's edge; positions are true positions, so they
// line up with whatever the neighbor draws.

import type { FileMetadata } from "./arrow-util.ts";
import { buildingsFromArrow, buildingsToArrow } from "./buildings-arrow.ts";
import { buildBuildings, BUILDINGS_VERSION, type BuildingInput, type Buildings } from "./buildings.ts";
import { ecefToLocal, geodeticToEcef, type Frame, type Vec3 } from "./geodesy.ts";
import { enuProjection } from "./projection.ts";
import { flatTerrain, terrainFromArrow, terrainToArrow, type CellTerrain } from "./terrain.ts";
import { buildPois, emptyPois, poisFromArrow, poisToArrow, type PoiInput, type Pois } from "./pois.ts";
import { roadGraphFromArrow, roadGraphToArrow } from "./road-graph-arrow.ts";
import { buildRoadGraph, ROAD_GRAPH_VERSION, type RoadGraph, type RoadWayInput } from "./road-graph.ts";
import {
  cellEdgeNeighbors, cellFrame, cellFromLatLon, cellFromToken, cellLevel, cellOutline, cellPoint, cellToken,
  type CellId,
} from "./s2.ts";

/** Level of exported cells: about 1.1 km across on average (0.8–1.6 km). */
export const CELL_LEVEL = 13;

/** Bump when a cell's contents change for the same input (ownership rules, layout). */
export const CELL_VERSION = 10;

export interface CellContents {
  cell: CellId;
  frame: Frame;
  graph: RoadGraph;
  buildings: Buildings;
  terrain: CellTerrain;  // flat (h = 0) until draped
  pois: Pois;            // points of interest in the cell's buildings
}

/** A point owning a building: the area centroid of its first outer ring (lon, lat). */
export function ownerPoint(b: BuildingInput): [lon: number, lat: number] {
  const ring = b.polygons[0]![0]!;
  const [x0, y0] = ring[0]!;
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    // Relative to the first point, so the cross products don't lose precision.
    const [ax, ay] = [ring[i]![0] - x0, ring[i]![1] - y0];
    const [bx, by] = [ring[i + 1]![0] - x0, ring[i + 1]![1] - y0];
    const c = ax * by - bx * ay;
    a += c;
    cx += (ax + bx) * c;
    cy += (ay + by) * c;
  }
  if (a === 0) return [x0, y0];
  return [x0 + cx / (3 * a), y0 + cy / (3 * a)];
}

/**
 * The part of the input a cell owns, in its frame. The input should cover the
 * cell with some margin, and include every way sharing a node with those ways,
 * so ways are cut at the same nodes as in the neighbors' exports.
 */
export function buildCell(cell: CellId, ways: RoadWayInput[], buildings: BuildingInput[], pois: PoiInput[] = []): CellContents {
  const level = cellLevel(cell);
  const owns = (lon: number, lat: number) => cellFromLatLon(lat, lon, level) === cell;
  const frame = cellFrame(cell);
  const project = enuProjection(frame);
  const owned = buildBuildings(buildings.filter((b) => owns(...ownerPoint(b))), project);
  return {
    cell,
    frame,
    graph: buildRoadGraph(ways, project, owns),
    buildings: owned,
    terrain: flatTerrain(),
    pois: buildPois(pois, owned, project),
  };
}

export interface CellFiles {
  nodes: Uint8Array;
  edges: Uint8Array;
  buildings: Uint8Array;
  terrain: Uint8Array;
  pois: Uint8Array;
}
export const CELL_TABLES = ["nodes", "edges", "buildings", "terrain", "pois"] as const satisfies readonly (keyof CellFiles)[];

/**
 * A cell's files as one blob, to send in one response (a browser has 6 connections per host, and
 * a file per table queued its cells behind each other): per table in CELL_TABLES order, its length
 * (uint32, little-endian), then its bytes.
 */
export function packCellFiles(files: CellFiles): Uint8Array {
  let n = 0;
  for (const t of CELL_TABLES) n += 4 + files[t].length;
  const out = new Uint8Array(n), view = new DataView(out.buffer);
  let at = 0;
  for (const t of CELL_TABLES) {
    view.setUint32(at, files[t].length, true);
    out.set(files[t], at + 4);
    at += 4 + files[t].length;
  }
  return out;
}

export function unpackCellFiles(bytes: Uint8Array): CellFiles {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), files: Partial<CellFiles> = {};
  let at = 0;
  for (const t of CELL_TABLES) {
    if (at + 4 > bytes.length) throw new Error(`cell blob ends before ${t}`);
    const n = view.getUint32(at, true);
    if (at + 4 + n > bytes.length) throw new Error(`cell blob ends inside ${t}`);
    files[t] = bytes.subarray(at + 4, at + 4 + n);
    at += 4 + n;
  }
  if (at !== bytes.length) throw new Error(`cell blob has ${bytes.length - at} bytes past its tables`);
  return files as CellFiles;
}

export function cellToArrow(c: CellContents, metadata: FileMetadata = {}): CellFiles {
  const meta = {
    cell: cellToken(c.cell), cellVersion: CELL_VERSION, roadGraphVersion: ROAD_GRAPH_VERSION,
    buildingsVersion: BUILDINGS_VERSION, ...metadata,
  };
  return {
    ...roadGraphToArrow(c.graph, meta), buildings: buildingsToArrow(c.buildings, meta), terrain: terrainToArrow(c.terrain, meta),
    pois: poisToArrow(c.pois, meta),
  };
}

export function cellFromArrow(files: CellFiles): CellContents & { metadata: FileMetadata } {
  const { graph, metadata } = roadGraphFromArrow(files);
  const { buildings } = buildingsFromArrow(files.buildings);
  if (typeof metadata.cell !== "string") throw new Error("cell files have no cell token in their metadata");
  const cell = cellFromToken(metadata.cell);
  return { cell, frame: cellFrame(cell), graph, buildings, terrain: terrainFromArrow(files.terrain), pois: poisFromArrow(files.pois), metadata };
}

// --- around a point -------------------------------------------------------------

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * Cells at `level` with any part within `radius` meters (straight-line, at the
 * ellipsoid surface) of a point, nearest first. Walks outward through edge
 * neighbors, so the cost is proportional to the answer.
 */
export function cellsWithin(lat: number, lon: number, radius: number, level = CELL_LEVEL): { cell: CellId; distance: number }[] {
  const p = geodeticToEcef({ lat, lon, h: 0 });
  const ecef = (q: { lat: number; lon: number }) => geodeticToEcef({ ...q, h: 0 });
  const start = cellFromLatLon(lat, lon, level);
  const seen = new Set<CellId>([start]);
  const queue = [start];
  const out: { cell: CellId; distance: number }[] = [];
  while (queue.length > 0) {
    const c = queue.pop()!;
    const o = cellOutline(c);
    const center = ecef(o.center);
    const reach = Math.max(...o.corners.map((k) => dist(center, ecef(k))));
    const d = Math.max(0, dist(center, p) - reach);
    if (d > radius && c !== start) continue;
    out.push({ cell: c, distance: d });
    for (const n of cellEdgeNeighbors(c)) {
      if (!seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  return out.sort((a, b) => a.distance - b.distance || (a.cell < b.cell ? -1 : 1));
}

/**
 * Distance to the horizon, m: how far a point at height `target` can be seen
 * from an eye at height `eye` over a smooth Earth (no refraction, no terrain).
 */
export function horizonDistance(eye: number, target = 0): number {
  const R = 6_371_000;
  return Math.sqrt(2 * R * Math.max(0, eye)) + Math.sqrt(2 * R * Math.max(0, target));
}

