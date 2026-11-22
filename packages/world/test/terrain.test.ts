import { describe, expect, it } from "vitest";
import {
  buildCell, CELL_LEVEL, cellCenter, cellEdgeNeighbors, cellFromArrow, cellFromLatLon, cellToArrow, drapeCell, ecefToLocal, groundSampler,
  enuFrame, enuUnprojection, frameToFrame, geodeticToEcef, sampleTerrain, TERRAIN_LOD_STEPS, TERRAIN_N, terrainHeightAt,
  terrainMesh, transformPoint, type BuildingInput, type HeightFn, type RoadWayInput, type Vec3,
} from "../src/index.ts";

// Two neighboring cells in Denver on a tilted plane: rising 10 m per 100 m eastward, plus a gentle north slope.
const a = cellFromLatLon(39.758861, -104.964699, CELL_LEVEL);
const [, b] = cellEdgeNeighbors(a);
const ca = cellCenter(a), cb = cellCenter(b);
const mid = enuFrame({ lat: (ca.lat + cb.lat) / 2, lon: (ca.lon + cb.lon) / 2, h: 0 });
const ll = enuUnprojection(mid);
const slope: HeightFn = (lat, lon) => 1600 + (lon - ca.lon) * 85_000 * 0.1 + (lat - ca.lat) * 111_000 * 0.02;
const dist = (p: Vec3, q: Vec3) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);

describe("terrain lattice", () => {
  it("samples heights at the lattice and interpolates between them", () => {
    const t = sampleTerrain(a, slope);
    expect(t.heights.length).toBe((TERRAIN_N + 1) ** 2);
    // A plane is reproduced by bilinear interpolation (to the lattice's slight curvature).
    for (const [lat, lon] of [[ca.lat, ca.lon], [ca.lat + 0.001, ca.lon - 0.002]]) {
      expect(terrainHeightAt(a, t, lat!, lon!)).toBeCloseTo(slope(lat!, lon!), 1);
    }
  });

  it("meets the neighbor's terrain exactly along the shared edge, at every level of detail", () => {
    const fa = buildCell(a, [], []).frame, fb = buildCell(b, [], []).frame;
    const ma = terrainMesh(a, fa, sampleTerrain(a, slope)), mb = terrainMesh(b, fb, sampleTerrain(b, slope));
    const w = TERRAIN_N + 1;
    const p = (m: typeof ma, k: number): Vec3 => [m.positions[3 * k]!, m.positions[3 * k + 1]!, m.positions[3 * k + 2]!];
    for (let j = 0; j <= TERRAIN_N; j++) {
      // a's right column (i = n) is b's left column (i = 0).
      const pa = transformPoint(frameToFrame(fa, mid), p(ma, j * w + TERRAIN_N));
      const pb = transformPoint(frameToFrame(fb, mid), p(mb, j * w));
      expect(dist(pa, pb)).toBeLessThan(0.001);
    }
    expect(ma.lods.map((l) => l.count / 3)).toEqual(
      TERRAIN_LOD_STEPS.map((s) => 2 * (TERRAIN_N / s) ** 2 + 2 * (4 * TERRAIN_N) / s));
  });

  it("carries height and the same noise on both sides of a shared edge", () => {
    const fa = buildCell(a, [], []).frame, fb = buildCell(b, [], []).frame;
    const ma = terrainMesh(a, fa, sampleTerrain(a, slope)), mb = terrainMesh(b, fb, sampleTerrain(b, slope));
    const w = TERRAIN_N + 1;
    for (let j = 0; j <= TERRAIN_N; j++) {
      expect(ma.noise[j * w + TERRAIN_N]).toBe(mb.noise[j * w]);
      expect(ma.height[j * w + TERRAIN_N]).toBe(mb.height[j * w]);
    }
    expect(new Set(ma.noise).size).toBeGreaterThan(20);  // it varies
  });

  it("points normals up, tilted with the slope", () => {
    const m = terrainMesh(a, buildCell(a, [], []).frame, sampleTerrain(a, slope));
    const c = 4 * ((TERRAIN_N / 2) * (TERRAIN_N + 1) + TERRAIN_N / 2);
    const [nx, , nz] = [m.normals[c]!, m.normals[c + 1]!, m.normals[c + 2]!];
    expect(nz).toBeGreaterThan(120);
    expect(nx).toBeLessThan(-5);  // rising eastward: the normal leans west
  });
});

describe("drapeCell", () => {
  const road: RoadWayInput = {
    osmWayId: 1, nodeIds: [1, 2, 3], points: [ll(-600, 0), ll(0, 0), ll(600, 0)],
    class: "residential", name: null, lanesFwd: 1, lanesBack: 1, speedLimitMps: 11,
  };
  const other: RoadWayInput = { ...road, osmWayId: 2, nodeIds: [4, 2, 5], points: [ll(0, -300), ll(0, 0), ll(0, 300)] };
  const house: BuildingInput = {
    osmType: "way", osmId: 9, kind: "house", isPart: false, height: 6, minHeight: 0, heightSource: "default",
    polygons: [[[ll(-400, 20), ll(-380, 20), ll(-380, 40), ll(-400, 40), ll(-400, 20)]]],
  };
  // Bumpy ground: the plane plus ripples of a few meters at ~40–90 m wavelengths, crossing the roads.
  const bumpy: HeightFn = (lat, lon) => slope(lat, lon) + 3 * Math.sin(lon * 85_000 / 13) * Math.cos(lat * 111_000 / 29);
  const drape = (cell: typeof a, h: HeightFn, ways = [road, other]) => drapeCell(buildCell(cell, ways, [house]), groundSampler(h, CELL_LEVEL));
  const A = drape(a, slope), B = drape(b, slope);

  it("densifies roads to 8 m", () => {
    for (const c of [A, B]) {
      const g = c.graph;
      for (let e = 0; e < g.edges.count; e++) {
        for (let p = g.edges.pointStart[e]! + 1; p < g.edges.pointStart[e + 1]!; p++) {
          expect(Math.hypot(g.points[2 * p]! - g.points[2 * p - 2]!, g.points[2 * p + 1]! - g.points[2 * p - 1]!)).toBeLessThanOrEqual(8.01);
        }
      }
    }
  });

  it("never puts any part of a road's surface below the drawn ground, even on bumpy ground", () => {
    for (const cell of [a, b]) {
      const ground = groundSampler(bumpy, CELL_LEVEL);
      const c = drapeCell(buildCell(cell, [road, other], []), ground);
      const g = c.graph, back = enuUnprojection(c.frame);
      const hw = 4;  // residential, 1 + 1 lanes: 3 m lanes + 1 m shoulders
      let checked = 0;
      for (let e = 0; e < g.edges.count; e++) {
        for (let p = g.edges.pointStart[e]!; p + 1 < g.edges.pointStart[e + 1]!; p++) {
          const [x0, y0, x1, y1] = [g.points[2 * p]!, g.points[2 * p + 1]!, g.points[2 * p + 2]!, g.points[2 * p + 3]!];
          const len = Math.hypot(x1 - x0, y1 - y0), rx = (y1 - y0) / len, ry = -(x1 - x0) / len;
          for (const f of [0.1, 0.5, 0.9]) {
            for (const o of [-0.95 * hw, 0, 0.95 * hw]) {
              const x = x0 + (x1 - x0) * f + rx * o, y = y0 + (y1 - y0) * f + ry * o;
              const [lon, lat] = back(x, y);
              const z = g.pointZ[p]! + (g.pointZ[p + 1]! - g.pointZ[p]!) * f;  // the road surface there
              const groundZ = ecefToLocal(c.frame, geodeticToEcef({ lat, lon, h: ground(lat, lon) }))[2];
              expect(z).toBeGreaterThanOrEqual(groundZ - 0.02);  // float32 storage
              checked++;
            }
          }
        }
      }
      expect(checked).toBeGreaterThan(100);
    }
  });

  it("sits level across a side slope, with a fill skirt down to the ground on the low side", () => {
    // The plane rises 10 m per 100 m eastward: the north–south road crosses that slope.
    const c = A.graph.edges.count > 0 ? A : B;
    const g = c.graph;
    let max = 0;
    for (let p = 0; p < g.pointDrop.length; p++) max = Math.max(max, g.pointDrop[p]!);
    expect(max).toBeGreaterThan(0.5);  // 8 m across at 10%: ~0.8 m
    expect(max).toBeLessThan(1.5);
  });

  it("runs bridges straight between their nodes", () => {
    // A 400 m bridge across the bumps: straight in z, whatever the ground does.
    const bridge: RoadWayInput = { ...road, osmWayId: 7, nodeIds: [10, 11, 12], points: [ll(-200, 150), ll(0, 150), ll(200, 150)], structure: "bridge" };
    const c = [a, b].map((cell) => drape(cell, bumpy, [bridge])).find((x) => x.graph.edges.count > 0)!;
    const g = c.graph;
    for (let e = 0; e < g.edges.count; e++) {
      const p0 = g.edges.pointStart[e]!, p1 = g.edges.pointStart[e + 1]! - 1;
      const L = Math.hypot(g.points[2 * p1]! - g.points[2 * p0]!, g.points[2 * p1 + 1]! - g.points[2 * p0 + 1]!);
      for (let p = p0; p <= p1; p++) {
        const f = Math.hypot(g.points[2 * p]! - g.points[2 * p0]!, g.points[2 * p + 1]! - g.points[2 * p0 + 1]!) / L;
        expect(g.pointZ[p]).toBeCloseTo(g.pointZ[p0]! + (g.pointZ[p1]! - g.pointZ[p0]!) * f, 0);
        expect(g.pointDrop[p]).toBe(0);
      }
    }
  });

  it("places a node shared by both cells at the same 3D point", () => {
    const shared = [...A.graph.nodes.osmId].filter((id) => B.graph.nodes.osmId.includes(id));
    expect(shared.length).toBeGreaterThan(0);
    for (const id of shared) {
      const at = (c: typeof A): Vec3 => {
        const n = c.graph.nodes.osmId.indexOf(id);
        return transformPoint(frameToFrame(c.frame, mid), [c.graph.nodes.x[n]!, c.graph.nodes.y[n]!, c.graph.nodes.z[n]!]);
      };
      expect(dist(at(A), at(B))).toBeLessThan(0.001);
    }
  });

  it("sits a building on the lowest ground under it, and round-trips through Arrow", () => {
    const c = A.buildings.count ? A : B;
    // The house's west edge (x = -400) is lowest on a plane rising eastward.
    const [lon, lat] = ll(-400, 20);
    const low = ecefToLocal(c.frame, geodeticToEcef({ lat, lon, h: slope(lat, lon) }));
    expect(c.buildings.base[0]).toBeCloseTo(low[2], 0);
    const back = cellFromArrow(cellToArrow(c));
    expect([...back.buildings.base]).toEqual([...c.buildings.base]);
    expect([...back.graph.pointZ]).toEqual([...c.graph.pointZ]);
    expect([...back.graph.pointDrop]).toEqual([...c.graph.pointDrop]);
    expect([...back.terrain.heights]).toEqual([...c.terrain.heights]);
  });
});
