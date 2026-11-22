import { describe, expect, it } from "vitest";
import {
  buildCell, CELL_LEVEL, CELL_TABLES, CELL_VERSION, cellCenter, cellEdgeNeighbors, cellFromArrow, cellFromLatLon, cellsWithin,
  cellToArrow, ecefToLocal, enuFrame, enuUnprojection, frameToFrame, geodeticToEcef, horizonDistance, packCellFiles, transformPoint,
  unpackCellFiles, type BuildingInput, type CellFiles, type RoadWayInput, type Vec3,
} from "../src/index.ts";

// Two neighboring level-13 cells in Denver, and helpers to place things in
// meters around the point on their shared edge.
const a = cellFromLatLon(39.758861, -104.964699, CELL_LEVEL);
const [, b] = cellEdgeNeighbors(a);  // to the "right" in (i, j)
const ca = cellCenter(a), cb = cellCenter(b);
const mid = enuFrame({ lat: (ca.lat + cb.lat) / 2, lon: (ca.lon + cb.lon) / 2, h: 0 });
const ll = enuUnprojection(mid);

const road = (osmWayId: number, nodeIds: number[], xy: [number, number][]): RoadWayInput => ({
  osmWayId, nodeIds, points: xy.map(([x, y]) => ll(x, y)),
  class: "residential", name: null, lanesFwd: 1, lanesBack: 1, speedLimitMps: 11,
});
const building = (osmId: number, x: number, y: number): BuildingInput => ({
  osmType: "way", osmId, kind: "house", isPart: false, height: 6, minHeight: 0, heightSource: "default",
  polygons: [[[[x, y], [x + 10, y], [x + 10, y + 10], [x, y + 10], [x, y]].map(([px, py]) => ll(px!, py!))]],
});

// A grid of streets every 100 m across the shared edge, meeting at shared nodes.
const ways: RoadWayInput[] = [];
for (let k = -5; k <= 5; k++) {
  ways.push(road(1000 + k, Array.from({ length: 11 }, (_, i) => 100 * (k + 5) + i), Array.from({ length: 11 }, (_, i) => [100 * (i - 5), 100 * k])));
  ways.push(road(2000 + k, Array.from({ length: 11 }, (_, i) => 100 * (i) + (k + 5)), Array.from({ length: 11 }, (_, i) => [100 * k, 100 * (i - 5)])));
}
const buildings = Array.from({ length: 100 }, (_, i) => building(i + 1, 97 * ((i % 10) - 5) + 13, 97 * (Math.floor(i / 10) - 5) + 29));

describe("buildCell", () => {
  const A = buildCell(a, ways, buildings), B = buildCell(b, ways, buildings);
  const edgeKeys = (c: typeof A) => Array.from({ length: c.graph.edges.count }, (_, e) =>
    `${c.graph.edges.osmWayId[e]}:${c.graph.nodes.osmId[c.graph.edges.from[e]!]}-${c.graph.nodes.osmId[c.graph.edges.to[e]!]}`);

  it("splits ownership: no edge or building in both cells", () => {
    const ka = new Set(edgeKeys(A)), kb = new Set(edgeKeys(B));
    expect(ka.size).toBeGreaterThan(10);
    expect(kb.size).toBeGreaterThan(10);
    for (const k of ka) expect(kb.has(k)).toBe(false);
    const ba = new Set(A.buildings.osmId), bb = new Set(B.buildings.osmId);
    expect(ba.size).toBeGreaterThan(5);
    expect(bb.size).toBeGreaterThan(5);
    for (const id of ba) expect(bb.has(id)).toBe(false);
  });

  it("cuts every way at the same nodes whichever cell exports it", () => {
    // 22 ways, each cut at 9 shared interior nodes into 10 edges.
    const all = [...edgeKeys(A), ...edgeKeys(B), ...cellEdgeNeighbors(a).concat(cellEdgeNeighbors(b))
      .filter((c) => c !== a && c !== b).flatMap((c) => edgeKeys(buildCell(c, ways, buildings)))];
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBeLessThanOrEqual(22 * 10);
  });

  it("puts a node shared across the edge at the same place from both cells", () => {
    const shared = [...A.graph.nodes.osmId].filter((id) => B.graph.nodes.osmId.includes(id));
    expect(shared.length).toBeGreaterThan(0);
    const toMid = (c: typeof A, id: number): Vec3 => {
      const n = c.graph.nodes.osmId.indexOf(id);
      return transformPoint(frameToFrame(c.frame, mid), [c.graph.nodes.x[n]!, c.graph.nodes.y[n]!, 0]);
    };
    for (const id of shared) {
      const pa = toMid(A, id), pb = toMid(B, id);
      // Road and building positions are 2D: each cell drops z (its curvature,
      // a few cm at its edges) until terrain brings real heights. The ground
      // mesh is 3D and meets exactly (below).
      expect(Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2])).toBeLessThan(0.05);
      expect(Math.hypot(pa[0] - pb[0], pa[1] - pb[1])).toBeLessThan(0.001);
    }
  });

  it("round-trips through Arrow with the cell in the metadata", () => {
    const back = cellFromArrow(cellToArrow(A, { source: "test" }));
    expect(back.cell).toBe(a);
    expect(back.metadata).toMatchObject({ cellVersion: CELL_VERSION, source: "test" });
    expect(back.graph.edges.count).toBe(A.graph.edges.count);
    expect(back.buildings.count).toBe(A.buildings.count);
  });
});

describe("cellsWithin", () => {
  const lat = 39.758861, lon = -104.964699;

  it("always includes the cell under the point, nearest first", () => {
    const r = cellsWithin(lat, lon, 0);
    expect(r[0]!.cell).toBe(cellFromLatLon(lat, lon, CELL_LEVEL));
    expect(r[0]!.distance).toBe(0);
  });

  it("covers the disk and nothing far outside it", () => {
    const radius = 3000;
    const r = cellsWithin(lat, lon, radius);
    const set = new Set(r.map((c) => c.cell));
    const here = enuFrame({ lat, lon, h: 0 }), back = enuUnprojection(here);
    for (let k = 0; k < 400; k++) {
      const ang = k * 2.399963, d = radius * Math.sqrt(((k * 0.618034) % 1));
      const [plon, plat] = back(d * Math.cos(ang), d * Math.sin(ang));
      expect(set.has(cellFromLatLon(plat, plon, CELL_LEVEL))).toBe(true);
    }
    for (const c of r) {
      const p = ecefToLocal(here, geodeticToEcef({ ...cellCenter(c.cell), h: 0 }));
      expect(Math.hypot(p[0], p[1])).toBeLessThan(radius + 1200);
    }
    expect(r.map((c) => c.distance)).toEqual([...r.map((c) => c.distance)].sort((x, y) => x - y));
  });
});

describe("horizon and ground", () => {
  it("sees about 4.7 km from eye height and much farther to a tower", () => {
    expect(horizonDistance(1.7)).toBeCloseTo(4654, -1);
    expect(horizonDistance(1.7, 200)).toBeCloseTo(4654 + 50_478, -2);
  });

});

describe("packCellFiles", () => {
  it("round-trips every table, empty ones included", () => {
    const files = Object.fromEntries(CELL_TABLES.map((t, i) => [t, Uint8Array.from({ length: i * 3 }, (_, k) => k + i)])) as unknown as CellFiles;
    const back = unpackCellFiles(packCellFiles(files));
    for (const t of CELL_TABLES) expect(Array.from(back[t])).toEqual(Array.from(files[t]));
  });

  it("refuses a truncated blob", () => {
    const files = Object.fromEntries(CELL_TABLES.map((t) => [t, new Uint8Array(5)])) as unknown as CellFiles;
    expect(() => unpackCellFiles(packCellFiles(files).subarray(0, 20))).toThrow(/ends/);
  });
});
