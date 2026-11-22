import { describe, expect, it } from "vitest";
import {
  carveWater, CELL_LEVEL, cellCenter, cellEdgeNeighbors, cellFromLatLon, cellLattice, clipPolygon, clipPolyline, enuFrame,
  enuUnprojection, groundSampler, WATER_CARVE, type HeightFn,
} from "../src/index.ts";

const square = [[0, 0], [10, 0], [10, 10], [0, 10]] as [number, number][];
const area = (p: [number, number][]) => p.reduce((s, [x, y], i) => s + (x * p[(i + 1) % p.length]![1] - p[(i + 1) % p.length]![0] * y), 0) / 2;

describe("clipping to a convex window", () => {
  it("clips a polygon, concave ones too", () => {
    expect(area(clipPolygon([[-5, -5], [5, -5], [5, 5], [-5, 5]], square))).toBeCloseTo(25, 9);
    // An L shape half outside: only the part inside counts.
    const L: [number, number][] = [[-5, 2], [8, 2], [8, 4], [2, 4], [2, 15], [-5, 15]];
    expect(area(clipPolygon(L, square))).toBeCloseTo(8 * 2 + 2 * 6, 9);
    expect(clipPolygon([[20, 20], [30, 20], [30, 30]], square)).toEqual([]);
  });

  it("clips a polyline into the pieces inside", () => {
    const pieces = clipPolyline([[-5, 5], [5, 5], [5, 15], [8, 15], [8, 5], [15, 5]], square);
    expect(pieces).toEqual([[[0, 5], [5, 5], [5, 10]], [[8, 10], [8, 5], [10, 5]]]);
  });
});

// Two neighboring cells in Denver; a lake straddling their shared edge.
const a = cellFromLatLon(39.758861, -104.964699, CELL_LEVEL);
const [, b] = cellEdgeNeighbors(a);
const ca = cellCenter(a), cb = cellCenter(b);
const mid0 = { lat: (ca.lat + cb.lat) / 2, lon: (ca.lon + cb.lon) / 2 };
const mid = enuFrame({ ...mid0, h: 0 });
const ll = enuUnprojection(mid);
const toLocal = (lat: number, lon: number): [number, number] => [(lon - mid0.lon) * 85_400, (lat - mid0.lat) * 111_030];
const ring = (pts: [number, number][]) => [...pts, pts[0]!].map(([x, y]) => ll(x, y));
const lake = { osmId: 1, kind: "lake" as const, polygons: [[ring([[-200, -100], [200, -100], [200, 100], [-200, 100]])]] };
// Hydro-flattened: the lake is exactly 1550 m; the ground elsewhere slopes.
const inLake = (x: number, y: number) => Math.abs(x) < 200 && Math.abs(y) < 100;
const height: HeightFn = (lat, lon) => {
  const dx = (lon - (ca.lon + cb.lon) / 2) * 85_400, dy = (lat - (ca.lat + cb.lat) / 2) * 111_030;
  return inLake(dx, dy) ? 1550 : 1560 + dx * 0.05;
};

describe("carveWater", () => {
  it("lowers the terrain inside the lake, identically in both cells along their shared edge", () => {
    const carved = carveWater([lake]), plain = groundSampler(height, CELL_LEVEL);
    let lowered = 0;
    for (const cell of [a, b]) {
      const t0 = plain.terrain(cell), t1 = carved(cell, t0), ll = cellLattice(cell, t0.n);
      for (let k = 0; k < t0.heights.length; k++) {
        const d = t0.heights[k]! - t1.heights[k]!;
        expect([0, WATER_CARVE]).toContainEqual(Math.round(d * 1000) / 1000);
        if (d > 0) {
          lowered++;
          // Only inside the lake: 400 × 200 m around the shared edge's midpoint.
          const [x, y] = toLocal(ll[2 * k]!, ll[2 * k + 1]!);
          expect(Math.abs(x)).toBeLessThan(200);
          expect(Math.abs(y)).toBeLessThan(100);
        }
      }
    }
    // ~80,000 m² at ~17 m spacing: a few hundred lattice points between the two cells.
    expect(lowered).toBeGreaterThan(150);
    expect(lowered).toBeLessThan(500);
    // Shared edge: a's right column (i = n) is b's left column (i = 0).
    const n = 64, w = n + 1, ta = carved(a, plain.terrain(a)), tb = carved(b, plain.terrain(b));
    for (let j = 0; j <= n; j++) expect(ta.heights[j * w + n]).toBe(tb.heights[j * w]);
  });
});
