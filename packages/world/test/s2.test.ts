import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  cellCenter, cellChildren, cellContains, cellCorners, cellEdgeNeighbors, cellFace, cellFromInt64, cellFromLatLon,
  cellFromToken, cellLevel, cellParent, cellToInt64, cellToken, type CellId,
} from "../src/index.ts";

// Reference values from s2sphere; see s2-golden.py.
interface Golden {
  points: {
    name: string; lat: number; lon: number; ids: Record<string, string>;
    token13: string; center13: [number, number]; corners10: [number, number][];
  }[];
  neighbors: { id: string; neighbors: string[] }[];
}
const golden = JSON.parse(readFileSync(new URL("./s2-golden.json", import.meta.url), "utf8")) as Golden;

/** Deterministic pseudo-random points, roughly uniform on the sphere. */
function* randomPoints(n: number): Generator<[lat: number, lon: number]> {
  let s = 12345;
  const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32);
  for (let k = 0; k < n; k++) yield [Math.asin(2 * rnd() - 1) * 180 / Math.PI, rnd() * 360 - 180];
}

describe("S2 cell ids match s2sphere", () => {
  for (const p of golden.points) {
    it(p.name, () => {
      for (const [level, id] of Object.entries(p.ids)) {
        expect(cellFromLatLon(p.lat, p.lon, Number(level)), `level ${level}`).toBe(BigInt(id));
      }
      const c13 = cellFromLatLon(p.lat, p.lon, 13);
      expect(cellToken(c13)).toBe(p.token13);
      const center = cellCenter(c13);
      expect(center.lat).toBeCloseTo(p.center13[0], 12);
      expect(center.lon).toBeCloseTo(p.center13[1], 12);
      cellCorners(cellFromLatLon(p.lat, p.lon, 10)).forEach((c, k) => {
        expect(c.lat).toBeCloseTo(p.corners10[k]![0], 12);
        // At the poles every longitude is the same point.
        if (Math.abs(c.lat) < 89.9999) expect(c.lon).toBeCloseTo(p.corners10[k]![1], 12);
      });
    });
  }

  it("edge neighbors, including across faces", () => {
    expect(golden.neighbors.length).toBeGreaterThan(50);
    for (const g of golden.neighbors) {
      expect(cellEdgeNeighbors(BigInt(g.id)).map(String), g.id).toEqual(g.neighbors);
    }
  });
});

describe("S2 hierarchy", () => {
  const denver = cellFromLatLon(39.758861, -104.964699);

  it("levels, parents and faces", () => {
    expect(cellLevel(denver)).toBe(30);
    for (let l = 0; l <= 30; l++) {
      const c = cellParent(denver, l);
      expect(cellLevel(c)).toBe(l);
      expect(cellContains(c, denver)).toBe(true);
      expect(cellFace(c)).toBe(cellFace(denver));
    }
  });

  it("children partition their parent, in Hilbert order", () => {
    const c = cellParent(denver, 12);
    const kids = cellChildren(c);
    expect(kids.map((k) => cellParent(k, 12))).toEqual([c, c, c, c]);
    expect([...kids].sort((a, b) => (a < b ? -1 : 1))).toEqual(kids);
    expect(kids.filter((k) => cellContains(k, denver))).toHaveLength(1);
    expect(cellContains(kids[0], kids[1])).toBe(false);
    expect(() => cellChildren(denver)).toThrow();
  });

  it("neighbors are symmetric and at the same level everywhere", () => {
    for (const [lat, lon] of randomPoints(300)) {
      for (const level of [1, 7, 16]) {
        const c = cellFromLatLon(lat, lon, level);
        for (const n of cellEdgeNeighbors(c)) {
          expect(cellLevel(n)).toBe(level);
          expect(cellEdgeNeighbors(n)).toContain(c);
        }
      }
    }
  });

  it("a point's cell center is within the cell's size of the point", () => {
    for (const [lat, lon] of randomPoints(500)) {
      const c = cellCenter(cellFromLatLon(lat, lon, 20));
      // Level-20 cells are ≤ ~16 m across; check the round trip lands in the same cell.
      expect(cellFromLatLon(c.lat, c.lon, 20)).toBe(cellFromLatLon(lat, lon, 20));
    }
  });
});

describe("S2 encodings", () => {
  it("tokens round-trip", () => {
    for (const [lat, lon] of randomPoints(100)) {
      for (const level of [0, 9, 30]) {
        const c = cellFromLatLon(lat, lon, level);
        expect(cellFromToken(cellToken(c))).toBe(c);
      }
    }
    expect(cellToken(0n)).toBe("X");
  });

  it("signed 64-bit for Postgres round-trips and fits", () => {
    const ids: CellId[] = [...randomPoints(100)].map(([lat, lon]) => cellFromLatLon(lat, lon));
    for (const id of ids) {
      const v = cellToInt64(id);
      expect(v >= -(2n ** 63n) && v < 2n ** 63n).toBe(true);
      expect(cellFromInt64(v)).toBe(id);
    }
  });
});
