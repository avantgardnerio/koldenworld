import { describe, expect, it } from "vitest";
import {
  buildCell, carveWater, CELL_LEVEL, cellCenter, cellEdgeNeighbors, cellFromLatLon, cellLattice, cellWater, clipPolygon,
  clipPolyline, enuFrame, enuUnprojection, frameToFrame, groundSampler, transformPoint, WATER_CARVE, WaterMaterial,
  waterFromArrow, waterToArrow, type HeightFn, type Vec3,
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

// Two neighboring cells in Denver; a lake straddling their shared edge and a stream along it.
const a = cellFromLatLon(39.758861, -104.964699, CELL_LEVEL);
const [, b] = cellEdgeNeighbors(a);
const ca = cellCenter(a), cb = cellCenter(b);
const mid0 = { lat: (ca.lat + cb.lat) / 2, lon: (ca.lon + cb.lon) / 2 };
const mid = enuFrame({ ...mid0, h: 0 });
const ll = enuUnprojection(mid);
const toLocal = (lat: number, lon: number): [number, number] => [(lon - mid0.lon) * 85_400, (lat - mid0.lat) * 111_030];
const ring = (pts: [number, number][]) => [...pts, pts[0]!].map(([x, y]) => ll(x, y));
const lake = { osmId: 1, kind: "lake" as const, polygons: [[ring([[-200, -100], [200, -100], [200, 100], [-200, 100]])]] };
const stream = { osmId: 2, kind: "stream", width: 3, points: [ll(-300, 300), ll(0, 300), ll(300, 300)] };
// Hydro-flattened: the lake is exactly 1550 m; the ground elsewhere slopes.
const inLake = (x: number, y: number) => Math.abs(x) < 200 && Math.abs(y) < 100;
const height: HeightFn = (lat, lon) => {
  const dx = (lon - (ca.lon + cb.lon) / 2) * 85_400, dy = (lat - (ca.lat + cb.lat) / 2) * 111_030;
  return inLake(dx, dy) ? 1550 : 1560 + dx * 0.05;
};

describe("cellWater", () => {
  const fa = buildCell(a, [], []).frame, fb = buildCell(b, [], []).frame;
  const heights = {
    dem: height, surface: groundSampler(height, CELL_LEVEL), ground: groundSampler(height, CELL_LEVEL, carveWater([lake])),
  };
  const wa = cellWater(a, fa, [lake], [stream], heights), wb = cellWater(b, fb, [lake], [stream], heights);
  const verts = (w: typeof wa, f: typeof fa, m: number): Vec3[] => {
    const out: Vec3[] = [];
    for (let v = 0; v < w.material.length; v++) {
      if (w.material[v] === m) out.push(transformPoint(frameToFrame(f, mid), [w.positions[3 * v]!, w.positions[3 * v + 1]!, w.positions[3 * v + 2]!]));
    }
    return out;
  };

  it("splits a lake across the cells, at one level in both", () => {
    const la = verts(wa, fa, WaterMaterial.Lake), lb = verts(wb, fb, WaterMaterial.Lake);
    expect(la.length).toBeGreaterThan(0);
    expect(lb.length).toBeGreaterThan(0);
    // Same level: z in the shared frame, near its origin, is the height above the ellipsoid (to curvature, mm here).
    const zs = [...la, ...lb].map((p) => p[2]);
    expect(Math.max(...zs) - Math.min(...zs)).toBeLessThan(0.05);
    expect(zs[0]).toBeCloseTo(1550, 0);
    // The two parts cover the lake: 400 × 200 m.
    const tri = (ps: Vec3[]) => { let s = 0; for (let i = 0; i < ps.length; i += 3) { const [p, q, r] = [ps[i]!, ps[i + 1]!, ps[i + 2]!]; s += Math.abs((q[0] - p[0]) * (r[1] - p[1]) - (r[0] - p[0]) * (q[1] - p[1])) / 2; } return s; };
    expect(tri(la) + tri(lb)).toBeCloseTo(400 * 200, -2);
  });

  it("follows the ground with a stream, level across it", () => {
    const s = [...verts(wa, fa, WaterMaterial.Stream), ...verts(wb, fb, WaterMaterial.Stream)];
    expect(s.length).toBeGreaterThan(0);
    // The ground rises 5 m per 100 m east; the stream's ends differ by about 30 m.
    const zs = s.map((p) => p[2]);
    expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(20);
    // Triangles: corners opposite each other across the stream share a height.
    for (let i = 0; i < s.length; i += 6) expect(Math.abs(s[i]![2] - s[i + 1]![2])).toBeLessThan(0.01);
  });

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

  it("round-trips through Arrow", () => {
    const back = waterFromArrow(waterToArrow(wa, {}));
    expect([...back.positions]).toEqual([...wa.positions]);
    expect([...back.material]).toEqual([...wa.material]);
  });
});
