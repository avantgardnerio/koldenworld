// Terrain (decision 24): each cell carries the ground's height on an
// (n + 1) × (n + 1) lattice over its S2 square (cellLattice). Heights are
// meters above the WGS84 ellipsoid. Lattice points are exact positions on the
// globe, so neighbors share their edge points and sample the same heights
// there: terrain meets without cracks at full detail.
//
// Draping puts a cell's roads and buildings on the ground: road centerlines
// are densified and every point gets the ground's height; each building sits
// on the lowest ground under its outer ring. Points are re-placed at their true
// height (not raised straight up from the tangent plane: "up" tilts across a
// cell, ~25 cm horizontally at 1 km from the anchor and 1,600 m elevation).
//
// The mesh keeps every lattice vertex once and offers index buffers at a few
// levels of detail, plus skirts: short walls hanging from the cell's edges
// that hide the cracks where neighbors are drawn at different levels.

import type { FileMetadata } from "./arrow-util.ts";
import { f32, readTable, toIPC, values, column } from "./arrow-util.ts";
import type { CellContents } from "./cell.ts";
import { ecefToLocal, geodeticToEcef, type Frame, type Vec3 } from "./geodesy.ts";
import { enuUnprojection } from "./projection.ts";
import type { RoadGraph } from "./road-graph.ts";
import { cellFractions, cellLattice, type CellId } from "./s2.ts";
import type { Buildings } from "./buildings.ts";

/** Lattice subdivisions per cell edge: ~17 m spacing at level 13. */
export const TERRAIN_N = 64;
/** Mesh levels of detail: lattice steps. */
export const TERRAIN_LOD_STEPS = [1, 2, 4, 8] as const;
const SKIRT_DEPTH = 50;  // m

/** Ground height in meters above the ellipsoid at a point. */
export type HeightFn = (lat: number, lon: number) => number;

export interface CellTerrain {
  n: number;
  heights: Float32Array;  // (n + 1)², row by row (t outer, s inner), m above the ellipsoid
}

export const flatTerrain = (n = TERRAIN_N): CellTerrain => ({ n, heights: new Float32Array((n + 1) ** 2) });

export function sampleTerrain(cell: CellId, height: HeightFn, n = TERRAIN_N): CellTerrain {
  const ll = cellLattice(cell, n);
  const heights = new Float32Array((n + 1) ** 2);
  for (let k = 0; k < heights.length; k++) heights[k] = height(ll[2 * k]!, ll[2 * k + 1]!);
  return { n, heights };
}

/** The ground's height at a point in (or near) the cell: bilinear on the lattice, clamped to its edge. */
export function terrainHeightAt(cell: CellId, t: CellTerrain, lat: number, lon: number): number {
  const [fs, ft] = cellFractions(cell, lat, lon);
  const x = Math.min(t.n, Math.max(0, fs * t.n)), y = Math.min(t.n, Math.max(0, ft * t.n));
  const i = Math.min(t.n - 1, Math.floor(x)), j = Math.min(t.n - 1, Math.floor(y));
  const u = x - i, v = y - j, w = t.n + 1, h = t.heights;
  const a = h[j * w + i]!, b = h[j * w + i + 1]!, c = h[(j + 1) * w + i]!, d = h[(j + 1) * w + i + 1]!;
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

// --- Arrow -----------------------------------------------------------------------
//   terrain.arrow: h float32, (n + 1)² rows; metadata: terrainN

export function terrainToArrow(t: CellTerrain, metadata: FileMetadata): Uint8Array {
  return toIPC({ h: f32(t.heights) }, t.heights.length, { ...metadata, terrainN: t.n });
}

export function terrainFromArrow(bytes: Uint8Array): CellTerrain {
  const { table, metadata } = readTable(bytes, "terrain");
  const n = metadata.terrainN;
  if (typeof n !== "number" || table.numRows !== (n + 1) ** 2) throw new Error("terrain: bad lattice size");
  return { n, heights: values(column(table, "h", "terrain"), table.numRows, Float32Array, "terrain.h") };
}

// --- draping ---------------------------------------------------------------------

/**
 * Puts a cell's roads and buildings on the ground and samples its terrain.
 * `height` must cover everything the cell owns (its objects reach past its
 * edge). Pure: returns new tables.
 */
export function drapeCell(c: CellContents, height: HeightFn, maxSegment = 20): CellContents {
  const toLonLat = enuUnprojection(c.frame);
  const place = (x: number, y: number, h?: number): Vec3 => {
    const [lon, lat] = toLonLat(x, y);
    return ecefToLocal(c.frame, geodeticToEcef({ lat, lon, h: h ?? height(lat, lon) }));
  };
  return {
    ...c,
    graph: drapeGraph(c.graph, place, maxSegment),
    buildings: drapeBuildings(c.buildings, place, (x, y) => {
      const [lon, lat] = toLonLat(x, y);
      return height(lat, lon);
    }),
    terrain: sampleTerrain(c.cell, height),
  };
}

type Place = (x: number, y: number, h?: number) => Vec3;

/** Densifies every edge to segments of at most maxSegment m and places each point on the ground. */
function drapeGraph(g: RoadGraph, place: Place, maxSegment: number): RoadGraph {
  const xy: number[] = [], z: number[] = [];
  const pointStart = new Int32Array(g.edges.count + 1);
  const put = (x: number, y: number) => {
    const p = place(x, y);
    xy.push(p[0], p[1]);
    z.push(p[2]);
  };
  for (let e = 0; e < g.edges.count; e++) {
    pointStart[e] = z.length;
    const a = g.edges.pointStart[e]!, b = g.edges.pointStart[e + 1]!;
    for (let p = a; p < b; p++) {
      const x = g.points[2 * p]!, y = g.points[2 * p + 1]!;
      if (p > a) {
        const x0 = g.points[2 * p - 2]!, y0 = g.points[2 * p - 1]!;
        const steps = Math.ceil(Math.hypot(x - x0, y - y0) / maxSegment);
        for (let k = 1; k < steps; k++) put(x0 + ((x - x0) * k) / steps, y0 + ((y - y0) * k) / steps);
      }
      put(x, y);
    }
  }
  pointStart[g.edges.count] = z.length;

  const nodes = { ...g.nodes, x: new Float32Array(g.nodes.count), y: new Float32Array(g.nodes.count), z: new Float32Array(g.nodes.count) };
  for (let n = 0; n < g.nodes.count; n++) {
    const p = place(g.nodes.x[n]!, g.nodes.y[n]!);
    nodes.x[n] = p[0];
    nodes.y[n] = p[1];
    nodes.z[n] = p[2];
  }
  return { ...g, nodes, edges: { ...g.edges, pointStart }, points: Float32Array.from(xy), pointZ: Float32Array.from(z) };
}

/** Each building on the lowest ground under its outer ring; its points re-placed at that height. */
function drapeBuildings(b: Buildings, place: Place, groundAt: (x: number, y: number) => number): Buildings {
  const points = new Float32Array(b.points.length);
  const base = new Float32Array(b.count);
  for (let i = 0; i < b.count; i++) {
    const r0 = b.ringStart[i]!, p0 = b.pointStart[r0]!, p1 = b.pointStart[r0 + 1]!;
    let low = Infinity;
    for (let p = p0; p < p1; p++) low = Math.min(low, groundAt(b.points[2 * p]!, b.points[2 * p + 1]!));
    let z = 0;
    for (let p = p0; p < b.pointStart[b.ringStart[i + 1]!]!; p++) {
      const q = place(b.points[2 * p]!, b.points[2 * p + 1]!, low);
      points[2 * p] = q[0];
      points[2 * p + 1] = q[1];
      if (p === p0) z = q[2];
    }
    base[i] = z;
  }
  return { ...b, points, base };
}

// --- mesh ------------------------------------------------------------------------

export interface TerrainMesh {
  positions: Float32Array;  // x, y, z in the cell frame: the lattice, then the skirt
  normals: Int8Array;       // x, y, z, 0 per vertex; ×127
  height: Float32Array;     // m above the ellipsoid, per vertex (for elevation-based color)
  noise: Uint8Array;        // smooth value noise 0..255 from lat/lon: breaks up color bands, same on both sides of an edge
  indices: Uint32Array;     // every level of detail, back to back
  lods: { start: number; count: number }[];  // per TERRAIN_LOD_STEPS entry, into indices
}

export function terrainMesh(cell: CellId, frame: Frame, t: CellTerrain): TerrainMesh {
  const n = t.n, w = n + 1, ll = cellLattice(cell, n);
  const edge: number[] = [];  // lattice indices around the border, in order
  for (let i = 0; i < n; i++) edge.push(i);
  for (let j = 0; j < n; j++) edge.push(j * w + n);
  for (let i = n; i > 0; i--) edge.push(n * w + i);
  for (let j = n; j > 0; j--) edge.push(j * w);
  const count = w * w + edge.length;
  const positions = new Float32Array(3 * count);
  const height = new Float32Array(count);
  const noise = new Uint8Array(count);
  for (let k = 0; k < w * w; k++) {
    const lat = ll[2 * k]!, lon = ll[2 * k + 1]!;
    positions.set(ecefToLocal(frame, geodeticToEcef({ lat, lon, h: t.heights[k]! })), 3 * k);
    height[k] = t.heights[k]!;
    noise[k] = Math.round(255 * groundNoise(lat, lon));
  }
  edge.forEach((k, s) => {
    const v = w * w + s;
    positions[3 * v] = positions[3 * k]!;
    positions[3 * v + 1] = positions[3 * k + 1]!;
    positions[3 * v + 2] = positions[3 * k + 2]! - SKIRT_DEPTH;
    height[v] = height[k]!;
    noise[v] = noise[k]!;
  });

  // Normals from central differences on the lattice (one-sided at the border).
  const normals = new Int8Array(4 * count);
  const P = (i: number, j: number) => 3 * (Math.min(n, Math.max(0, j)) * w + Math.min(n, Math.max(0, i)));
  let flip = false;
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const a = P(i + 1, j), b = P(i - 1, j), c = P(i, j + 1), d = P(i, j - 1);
      const sx = [positions[a]! - positions[b]!, positions[a + 1]! - positions[b + 1]!, positions[a + 2]! - positions[b + 2]!];
      const tx = [positions[c]! - positions[d]!, positions[c + 1]! - positions[d + 1]!, positions[c + 2]! - positions[d + 2]!];
      let nx = sx[1]! * tx[2]! - sx[2]! * tx[1]!, ny = sx[2]! * tx[0]! - sx[0]! * tx[2]!, nz = sx[0]! * tx[1]! - sx[1]! * tx[0]!;
      if (i === 0 && j === 0) flip = nz < 0;  // (s, t) may run clockwise seen from above
      if (flip) { nx = -nx; ny = -ny; nz = -nz; }
      const len = Math.hypot(nx, ny, nz) || 1;
      normals.set([Math.round((127 * nx) / len), Math.round((127 * ny) / len), Math.round((127 * nz) / len)], 4 * (j * w + i));
    }
  }
  edge.forEach((k, s) => normals.set(normals.subarray(4 * k, 4 * k + 4), 4 * (w * w + s)));

  // Index buffers per level of detail: the lattice at a step, and the skirt along the same border points.
  const tri = (out: number[], a: number, b: number, c: number) => (flip ? out.push(a, c, b) : out.push(a, b, c));
  const all: number[] = [];
  const lods: { start: number; count: number }[] = [];
  for (const step of TERRAIN_LOD_STEPS) {
    const start = all.length;
    for (let j = 0; j < n; j += step) {
      for (let i = 0; i < n; i += step) {
        const a = j * w + i, b = a + step, c = a + step * w, d = c + step;
        tri(all, a, b, d);
        tri(all, a, d, c);
      }
    }
    // Skirt quads between consecutive border points at this step, facing outward.
    for (let s = 0; s < edge.length; s += step) {
      const s2 = (s + step) % edge.length;
      const a = edge[s]!, b = edge[s2]!, a2 = w * w + s, b2 = w * w + s2;
      tri(all, a, a2, b2);
      tri(all, a, b2, b);
    }
    lods.push({ start, count: all.length - start });
  }

  return { positions, normals, height, noise, indices: Uint32Array.from(all), lods };
}

// --- noise -----------------------------------------------------------------------

/** A hash of two integers to [0, 1). */
function hash2(i: number, j: number): number {
  let h = Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(j | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 2 ** 32;
}

/** Value noise on a lat/lon grid of `cell` degrees, smoothstepped between grid points. */
function valueNoise(lat: number, lon: number, cell: number): number {
  const x = lon / cell, y = lat / cell, i = Math.floor(x), j = Math.floor(y);
  const s = (t: number) => t * t * (3 - 2 * t);
  const u = s(x - i), v = s(y - j);
  return (hash2(i, j) * (1 - u) + hash2(i + 1, j) * u) * (1 - v) + (hash2(i, j + 1) * (1 - u) + hash2(i + 1, j + 1) * u) * v;
}

/** Smooth noise in [0, 1] over the ground: ~1 km and ~250 m features. Pure function of the point. */
export function groundNoise(lat: number, lon: number): number {
  return 0.65 * valueNoise(lat, lon, 0.01) + 0.35 * valueNoise(lat, lon, 0.0025);
}
