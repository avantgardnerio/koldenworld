import { describe, expect, it } from "vitest";
import {
  buildCell, CELL_LEVEL, cellCenter, cellEdgeNeighbors, cellFromArrow, cellFromLatLon, cellToArrow, drapeCell, ecefToLocal,
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
  const A = drapeCell(buildCell(a, [road, other], [house]), slope);
  const B = drapeCell(buildCell(b, [road, other], [house]), slope);
  const local = (c: typeof A, lat: number, lon: number, h: number) => ecefToLocal(c.frame, geodeticToEcef({ lat, lon, h }));

  it("densifies roads and puts every point on the ground", () => {
    const g = A.graph.edges.count > 0 ? A.graph : B.graph;
    const c = A.graph.edges.count > 0 ? A : B;
    const back = enuUnprojection(c.frame);
    for (let e = 0; e < g.edges.count; e++) {
      for (let p = g.edges.pointStart[e]! + 1; p < g.edges.pointStart[e + 1]!; p++) {
        expect(Math.hypot(g.points[2 * p]! - g.points[2 * p - 2]!, g.points[2 * p + 1]! - g.points[2 * p - 1]!)).toBeLessThanOrEqual(20.01);
      }
    }
    for (let p = 0; p < g.pointZ.length; p += 7) {
      const [lon, lat] = back(g.points[2 * p]!, g.points[2 * p + 1]!);
      expect(g.pointZ[p]).toBeCloseTo(local(c, lat, lon, slope(lat, lon))[2], 1);
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
    expect([...back.terrain.heights]).toEqual([...c.terrain.heights]);
  });
});
