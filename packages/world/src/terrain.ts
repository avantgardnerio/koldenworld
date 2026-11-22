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
import { edgeExtents, nodeRadii } from "./road-surface.ts";
import { ROAD_STRUCTURES, type RoadGraph } from "./road-graph.ts";
import { cellFractions, cellFractionsFn, cellFromLatLon, cellLattice, type CellId } from "./s2.ts";
import type { Buildings } from "./buildings.ts";

/** Lattice subdivisions per cell edge: ~17 m spacing at level 13. */
export const TERRAIN_N = 64;

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

/** Height at lattice coordinates (x, y) ∈ [0, n]², on the two triangles per square the ground is draped on. */
function latticeHeight(t: CellTerrain, x: number, y: number): number {
  x = Math.min(t.n, Math.max(0, x));
  y = Math.min(t.n, Math.max(0, y));
  const i = Math.min(t.n - 1, Math.floor(x)), j = Math.min(t.n - 1, Math.floor(y));
  const u = x - i, v = y - j, w = t.n + 1, h = t.heights;
  const a = h[j * w + i]!, b = h[j * w + i + 1]!, c = h[(j + 1) * w + i]!, d = h[(j + 1) * w + i + 1]!;
  // Each square is split along its (i, j)–(i + 1, j + 1) diagonal, as the ground generator drapes it (crates/cellgen terrain.rs).
  return u >= v ? a + u * (b - a) + v * (d - b) : a + u * (d - c) + v * (c - a);
}

/** The ground's height at a point in (or near) the cell, on the surface the full-detail mesh draws. */
export function terrainHeightAt(cell: CellId, t: CellTerrain, lat: number, lon: number): number {
  const [fs, ft] = cellFractions(cell, lat, lon);
  return latticeHeight(t, fs * t.n, ft * t.n);
}

/** The drawn ground anywhere: see groundSampler. */
export interface GroundSampler extends HeightFn {
  level: number;
  terrain(cell: CellId): CellTerrain;
  /** cellFractions for a cell, decoded once and kept. */
  fractions(cell: CellId): (lat: number, lon: number) => [number, number];
}

/**
 * The drawn ground anywhere, from a raw height source: the lattice of whichever
 * cell (at `level`) contains the point, sampled once per cell (then adjusted by
 * `carve`, e.g. lowered under lakes) and interpolated as the mesh draws it.
 * Everything placed with it sits on the terrain that is drawn, in this cell
 * and in its neighbors, which compute the same lattices.
 */
export function groundSampler(
  height: HeightFn, level: number, carve?: (cell: CellId, t: CellTerrain) => CellTerrain,
): GroundSampler {
  const lattices = new Map<CellId, CellTerrain>();
  const fracs = new Map<CellId, (lat: number, lon: number) => [number, number]>();
  const fractions = (cell: CellId) => {
    let f = fracs.get(cell);
    if (!f) fracs.set(cell, (f = cellFractionsFn(cell)));
    return f;
  };
  const terrain = (cell: CellId) => {
    let t = lattices.get(cell);
    if (!t) {
      t = sampleTerrain(cell, height);
      if (carve) t = carve(cell, t);
      lattices.set(cell, t);
    }
    return t;
  };
  const fn = (lat: number, lon: number) => {
    const cell = cellFromLatLon(lat, lon, level), t = terrain(cell);
    const [fs, ft] = fractions(cell)(lat, lon);
    return latticeHeight(t, fs * t.n, ft * t.n);
  };
  return Object.assign(fn, { level, terrain, fractions });
}

/**
 * The highest point of the drawn ground over a convex polygon (lon, lat
 * corners). Exact: a piecewise-planar surface peaks at a polygon corner, a
 * lattice vertex inside, or where an edge crosses a triangle edge (the
 * lattice's rows, columns and diagonals). A polygon spanning two cells is
 * sampled every ~1 m instead.
 */
export function footprintMax(ground: GroundSampler, poly: [lon: number, lat: number][]): number {
  const cell = cellFromLatLon(poly[0]![1], poly[0]![0], ground.level);
  const t = ground.terrain(cell), n = t.n, frac = ground.fractions(cell);
  const pts = poly.map(([lon, lat]) => {
    const [fs, ft] = frac(lat, lon);
    return [fs * n, ft * n] as [number, number];
  });
  if (pts.some(([x, y]) => x < 0 || y < 0 || x > n || y > n)) return sampledMax(ground, poly);

  let m = -Infinity;
  for (const [x, y] of pts) m = Math.max(m, latticeHeight(t, x, y));
  // Lattice vertices inside (convex polygon, either orientation).
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const inside = (x: number, y: number) => {
    let pos = false, neg = false;
    for (let k = 0; k < pts.length; k++) {
      const [ax, ay] = pts[k]!, [bx, by] = pts[(k + 1) % pts.length]!;
      const c = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
      if (c > 1e-12) pos = true;
      else if (c < -1e-12) neg = true;
    }
    return !(pos && neg);
  };
  for (let j = Math.ceil(Math.min(...ys)); j <= Math.floor(Math.max(...ys)); j++) {
    for (let i = Math.ceil(Math.min(...xs)); i <= Math.floor(Math.max(...xs)); i++) {
      if (inside(i, j)) m = Math.max(m, t.heights[j * (n + 1) + i]!);
    }
  }
  // Edge crossings with lattice lines x = k, y = k and x − y = k.
  for (let k = 0; k < pts.length; k++) {
    const [ax, ay] = pts[k]!, [bx, by] = pts[(k + 1) % pts.length]!;
    const lines: [number, number][] = [[ax, bx], [ay, by], [ax - ay, bx - by]];  // the coordinate along each family
    for (const [p, q] of lines) {
      if (p === q) continue;
      for (let c = Math.ceil(Math.min(p, q)); c <= Math.floor(Math.max(p, q)); c++) {
        const f = (c - p) / (q - p);
        m = Math.max(m, latticeHeight(t, ax + (bx - ax) * f, ay + (by - ay) * f));
      }
    }
  }
  return m;
}

function sampledMax(ground: HeightFn, poly: [number, number][]): number {
  const lons = poly.map((p) => p[0]), lats = poly.map((p) => p[1]);
  const lat0 = Math.min(...lats), lat1 = Math.max(...lats), lon0 = Math.min(...lons), lon1 = Math.max(...lons);
  const dLat = 1 / 111_000, dLon = dLat / Math.max(0.01, Math.cos((lat0 * Math.PI) / 180));
  let m = -Infinity;
  for (const [lon, lat] of poly) m = Math.max(m, ground(lat, lon));
  for (let lat = lat0; lat <= lat1; lat += dLat) {
    for (let lon = lon0; lon <= lon1; lon += dLon) {
      let pos = false, neg = false;
      for (let k = 0; k < poly.length; k++) {
        const [ax, ay] = poly[k]!, [bx, by] = poly[(k + 1) % poly.length]!;
        const c = (bx - ax) * (lat - ay) - (by - ay) * (lon - ax);
        if (c > 0) pos = true;
        else if (c < 0) neg = true;
      }
      if (!(pos && neg)) m = Math.max(m, ground(lat, lon));
    }
  }
  return m;
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
 * Puts a cell's roads and buildings on the drawn ground and takes its terrain
 * from it (decision 29). `ground` (groundSampler) must cover everything the
 * cell owns: its objects reach into neighbors.
 *
 * Roads: every cross-section sits at the highest point of the ground under
 * the road around it (footprintMax over the segments on either side), so a
 * road is never below the terrain and stays level across. Each node's disc
 * sits at the highest point under it, and edges start and end at their nodes'
 * heights, so junctions stay joined (also across cells: a node's height only
 * depends on the ground). Points are added where a road leaves a node's disc
 * and every maxSegment m between. `drop` records how far a road's lower edge is
 * above the ground there, for fill skirts. Bridges and tunnels run straight
 * between their nodes instead, with no skirts. Pure: returns new tables.
 */
export function drapeCell(c: CellContents, ground: GroundSampler, maxSegment = 8): CellContents {
  const { place, groundAt } = placing(c.frame, ground);
  return {
    ...c,
    graph: drapeRoadGraph(c.graph, c.frame, ground, maxSegment),
    buildings: drapeBuildings(c.buildings, place, groundAt),
    terrain: ground.terrain(c.cell),
  };
}

/**
 * Puts any road graph in `frame` on the drawn ground, as drapeCell does: e.g. every road around a
 * cell, so its neighbors' roads come out as they draw them (a road's heights depend only on the ground).
 */
export function drapeRoadGraph(g: RoadGraph, frame: Frame, ground: GroundSampler, maxSegment = 8): RoadGraph {
  const { place, groundAt, toLonLat } = placing(frame, ground);
  const maxOver = (corners: [number, number][]) => footprintMax(ground, corners.map(([x, y]) => toLonLat(x, y)));
  return drapeGraph(g, place, groundAt, maxOver, maxSegment);
}

function placing(frame: Frame, ground: GroundSampler) {
  const toLonLat = enuUnprojection(frame);
  const groundAt = (x: number, y: number) => {
    const [lon, lat] = toLonLat(x, y);
    return ground(lat, lon);
  };
  const place = (x: number, y: number, h?: number): Vec3 => {
    const [lon, lat] = toLonLat(x, y);
    return ecefToLocal(frame, geodeticToEcef({ lat, lon, h: h ?? ground(lat, lon) }));
  };
  return { toLonLat, groundAt, place };
}

type Place = (x: number, y: number, h?: number) => Vec3;
const DISC_SIDES = 16;

function drapeGraph(
  g: RoadGraph, place: Place, groundAt: (x: number, y: number) => number,
  maxOver: (corners: [number, number][]) => number, maxSegment: number,
): RoadGraph {
  const radius = nodeRadii(g);
  // Node heights: the highest ground under a square around its disc (it covers where roads leave the disc).
  const nodeH = new Float64Array(g.nodes.count), nodeDrop = new Float32Array(g.nodes.count);
  for (let n = 0; n < g.nodes.count; n++) {
    const x = g.nodes.x[n]!, y = g.nodes.y[n]!, r = Math.max(1, radius[n]!);
    const ring: [number, number][] = Array.from({ length: DISC_SIDES }, (_, k) => {
      const a = (2 * Math.PI * k) / DISC_SIDES;
      return [x + r * Math.SQRT2 * Math.cos(a), y + r * Math.SQRT2 * Math.sin(a)];
    });
    nodeH[n] = maxOver(ring);
    let low = Infinity;
    for (let k = 0; k < DISC_SIDES; k++) {
      const a = (2 * Math.PI * k) / DISC_SIDES;
      low = Math.min(low, groundAt(x + r * Math.cos(a), y + r * Math.sin(a)));
    }
    nodeDrop[n] = Math.max(0, nodeH[n]! - low);
  }

  const xy: number[] = [], z: number[] = [], drop: number[] = [];
  const pointStart = new Int32Array(g.edges.count + 1);
  for (let e = 0; e < g.edges.count; e++) {
    pointStart[e] = z.length;
    const from = g.edges.from[e]!, to = g.edges.to[e]!, [wl, wr] = edgeExtents(g, e);  // sidewalks included
    // The edge's centerline as arc length → point.
    const p0 = g.edges.pointStart[e]!, p1 = g.edges.pointStart[e + 1]!;
    const cum = [0];
    for (let p = p0 + 1; p < p1; p++) cum.push(cum.at(-1)! + Math.hypot(g.points[2 * p]! - g.points[2 * p - 2]!, g.points[2 * p + 1]! - g.points[2 * p - 1]!));
    const length = cum.at(-1)!;
    const at = (s: number): [number, number] => {
      let k = 1;
      while (k < cum.length - 1 && cum[k]! < s) k++;
      const seg = cum[k]! - cum[k - 1]!, f = seg > 0 ? (s - cum[k - 1]!) / seg : 0;
      const a = p0 + k - 1, b = p0 + k;
      return [g.points[2 * a]! + (g.points[2 * b]! - g.points[2 * a]!) * f, g.points[2 * a + 1]! + (g.points[2 * b + 1]! - g.points[2 * a + 1]!) * f];
    };
    // Stations: the original points, where the road leaves each disc, and every maxSegment m.
    const ra = radius[from]!, rb = radius[to]!;
    const st = new Set<number>(cum);
    if (ra > 0 && ra < length - rb) st.add(ra);
    if (rb > 0 && length - rb > ra) st.add(length - rb);
    const sorted = [...st].sort((a, b) => a - b);
    const stations: number[] = [];
    for (const s of sorted) {
      const prev = stations.at(-1);
      if (prev !== undefined) {
        const steps = Math.ceil((s - prev) / maxSegment);
        for (let k = 1; k < steps; k++) stations.push(prev + ((s - prev) * k) / steps);
      }
      if (prev === undefined || s - prev > 1e-6) stations.push(s);
    }
    const pts = stations.map(at);
    const n = pts.length;
    // Cross-sections: the road's edges (or its sidewalks' outer edges) at each station.
    const sides = pts.map(([x, y], k) => {
      const [ax, ay] = pts[Math.max(0, k - 1)]!, [bx, by] = pts[Math.min(n - 1, k + 1)]!;
      const len = Math.hypot(bx - ax, by - ay) || 1, rx = (by - ay) / len, ry = -(bx - ax) / len;
      return { l: [x - rx * wl, y - ry * wl] as [number, number], r: [x + rx * wr, y + ry * wr] as [number, number] };
    });
    const structure = ROAD_STRUCTURES[g.edges.structure[e]!];
    const H = new Float64Array(n), D = new Float32Array(n);
    if (structure === "ground") {
      // Each station at the highest ground under the segments on either side of it; ends at their nodes.
      const quad = Array.from({ length: n - 1 }, (_, k) => maxOver([sides[k]!.l, sides[k]!.r, sides[k + 1]!.r, sides[k + 1]!.l]));
      for (let k = 0; k < n; k++) H[k] = Math.max(k > 0 ? quad[k - 1]! : -Infinity, k < n - 1 ? quad[k]! : -Infinity);
      H[0] = nodeH[from]!;
      H[n - 1] = nodeH[to]!;
      for (let k = 1; k < n - 1; k++) D[k] = Math.max(0, H[k]! - Math.min(groundAt(...sides[k]!.l), groundAt(...sides[k]!.r)));
      D[0] = nodeDrop[from]!;
      D[n - 1] = nodeDrop[to]!;
    } else {
      // Bridges and tunnels: straight between their nodes.
      for (let k = 0; k < n; k++) H[k] = nodeH[from]! + ((nodeH[to]! - nodeH[from]!) * stations[k]!) / (length || 1);
    }
    for (let k = 0; k < n; k++) {
      const p = place(pts[k]![0], pts[k]![1], H[k]!);
      xy.push(p[0], p[1]);
      z.push(p[2]);
      drop.push(D[k]!);
    }
  }
  pointStart[g.edges.count] = z.length;

  const nodes = {
    ...g.nodes, x: new Float32Array(g.nodes.count), y: new Float32Array(g.nodes.count), z: new Float32Array(g.nodes.count),
    drop: nodeDrop,
  };
  for (let n = 0; n < g.nodes.count; n++) {
    const p = place(g.nodes.x[n]!, g.nodes.y[n]!, nodeH[n]!);
    nodes.x[n] = p[0];
    nodes.y[n] = p[1];
    nodes.z[n] = p[2];
  }
  return {
    ...g, nodes, edges: { ...g.edges, pointStart },
    points: Float32Array.from(xy), pointZ: Float32Array.from(z), pointDrop: Float32Array.from(drop),
  };
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
