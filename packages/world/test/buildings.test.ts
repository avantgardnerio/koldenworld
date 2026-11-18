import { describe, expect, it } from "vitest";
import {
  buildBuildings, buildingMesh, buildingsFromArrow, buildingsToArrow, idShade, signedArea2,
  type BuildingInput, type BuildingMesh,
} from "../src/index.ts";

const D = 0.0001;  // degrees; ≈ 11.12 m at the equator
const M = 11.1195;
const origin = { lat: 0, lon: 0 };
const square = (x0: number, y0: number, s: number, cw = false): [number, number][] => {
  const r: [number, number][] = [[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s], [x0, y0]];
  return (cw ? r.reverse() : r).map(([x, y]) => [x * D, y * D]);
};
const building = (osmId: number, polygons: [number, number][][][], extra: Partial<BuildingInput> = {}): BuildingInput => ({
  osmType: "way", osmId, kind: "house", isPart: false, height: 10, minHeight: 0, heightSource: "height", polygons, ...extra,
});

describe("buildBuildings", () => {
  it("projects, opens and orients rings: outer CCW, holes CW", () => {
    // Outer given clockwise, hole given counterclockwise: both get flipped.
    const t = buildBuildings([building(1, [[square(0, 0, 3, true), square(1, 1, 1)]])], origin);
    expect(t.count).toBe(1);
    expect(Array.from(t.ringStart)).toEqual([0, 2]);
    expect(Array.from(t.pointStart)).toEqual([0, 4, 8]);
    expect(signedArea2(t.points, 0, 4)).toBeGreaterThan(0);
    expect(signedArea2(t.points, 4, 8)).toBeLessThan(0);
    expect(signedArea2(t.points, 0, 4) / 2).toBeCloseTo((3 * M) ** 2, 1);
  });

  it("makes one row per polygon and shares kinds", () => {
    const t = buildBuildings([
      building(7, [[square(0, 0, 1)], [square(5, 0, 1)]], { osmType: "relation", kind: "commercial" }),
      building(8, [[square(0, 5, 1)]], { kind: "commercial" }),
      building(9, [[square(5, 5, 1)]]),
    ], origin);
    expect(t.count).toBe(4);
    expect(Array.from(t.osmId)).toEqual([7, 7, 8, 9]);
    expect(Array.from(t.osmType)).toEqual([1, 1, 0, 0]);
    expect(t.kinds).toEqual(["commercial", "house"]);
    expect(Array.from(t.kind)).toEqual([0, 0, 0, 1]);
  });

  it("drops degenerate rings", () => {
    const line: [number, number][] = [[0, 0], [D, 0], [0, 0]];
    const t = buildBuildings([building(1, [[line]]), building(2, [[square(0, 0, 1), line]])], origin);
    expect(t.count).toBe(1);
    expect(t.osmId[0]).toBe(2);
    expect(t.ringStart[1]).toBe(1);
  });
});

describe("buildings Arrow files", () => {
  const t = buildBuildings([
    building(1, [[square(0, 0, 3), square(1, 1, 1)]]),
    building(2, [[square(5, 0, 1)], [square(8, 0, 1)]], { osmType: "relation", kind: "church", isPart: true, minHeight: 4, heightSource: "levels" }),
  ], origin);
  const file = buildingsToArrow(t, { area: "test" });

  it("round-trip every column", () => {
    const { buildings: back, metadata } = buildingsFromArrow(file);
    expect(metadata).toEqual({ area: "test" });
    const { kinds, count, ...cols } = t;
    expect(back.count).toBe(count);
    expect(back.kinds).toEqual(kinds);
    for (const [k, v] of Object.entries(cols)) expect(back[k as keyof typeof cols], k).toEqual(v);
  });

  it("read columns as views onto the file bytes", () => {
    const { buildings: back } = buildingsFromArrow(file);
    expect(back.points.buffer).toBe(file.buffer);
    expect(back.pointStart.buffer).toBe(file.buffer);
  });

  it("are byte-for-byte reproducible", () => {
    expect(buildingsToArrow(t, { area: "test" })).toEqual(file);
  });
});

/** Sum of triangle areas projected on a plane, by normal direction. */
function areas(m: BuildingMesh) {
  let roof = 0, wall = 0;
  for (let i = 0; i < m.indices.length; i += 3) {
    const [a, b, c] = [m.indices[i]!, m.indices[i + 1]!, m.indices[i + 2]!].map((k) => [0, 1, 2].map((d) => m.positions[3 * k + d]!));
    const u = [b![0]! - a![0]!, b![1]! - a![1]!, b![2]! - a![2]!], w = [c![0]! - a![0]!, c![1]! - a![1]!, c![2]! - a![2]!];
    const n = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
    const area = Math.hypot(...n) / 2;
    // The geometric normal (from winding) must agree with the stored normal: front faces are CCW from outside.
    const stored = [0, 1, 2].map((d) => m.normals[4 * m.indices[i]! + d]! / 127);
    expect(n[0]! * stored[0]! + n[1]! * stored[1]! + n[2]! * stored[2]!).toBeGreaterThan(0);
    if (stored[2]! > 0.5) roof += area; else wall += area;
  }
  return { roof, wall };
}

describe("buildingMesh", () => {
  it("extrudes walls and covers the roof, minus holes", () => {
    const t = buildBuildings([building(1, [[square(0, 0, 3), square(1, 1, 1)]], { height: 12, minHeight: 2 })], origin);
    const m = buildingMesh(t);
    const { roof, wall } = areas(m);
    const s = 3 * M, h = M;
    expect(roof).toBeCloseTo(s * s - h * h, 0);
    expect(wall).toBeCloseTo((4 * s + 4 * h) * 10, 0);
    const zs = new Set(Array.from({ length: m.positions.length / 3 }, (_, k) => m.positions[3 * k + 2]));
    expect([...zs].sort((a, b) => a! - b!)).toEqual([2, 12]);
  });

  it("points wall normals away from the building, including into holes", () => {
    const t = buildBuildings([building(1, [[square(0, 0, 3), square(1, 1, 1)]])], origin);
    const m = buildingMesh(t);
    const cx = 1.5 * M, cy = 1.5 * M;
    let outward = 0, inward = 0;
    for (let v = 0; v < m.material.length; v++) {
      if (m.normals[4 * v + 2] !== 0) continue;
      const dx = m.positions[3 * v]! - cx, dy = m.positions[3 * v + 1]! - cy;
      const dot = dx * m.normals[4 * v]! + dy * m.normals[4 * v + 1]!;
      if (Math.hypot(dx, dy) > M) { if (dot > 0) outward++; } else if (dot < 0) inward++;
    }
    expect(outward).toBe(16);  // outer walls: 4 faces × 4 vertices, facing out
    expect(inward).toBe(16);   // courtyard walls face the courtyard center
  });

  it("skips buildings with no height and tags materials by group", () => {
    const t = buildBuildings([
      building(1, [[square(0, 0, 1)]], { height: 0 }),
      building(2, [[square(5, 0, 1)]], { kind: "garage" }),
    ], origin);
    const m = buildingMesh(t);
    expect(new Set(m.material)).toEqual(new Set([8, 9]));  // utility walls, utility roof
    expect(new Set(m.shade)).toEqual(new Set([idShade(2)]));
  });

  it("is deterministic", () => {
    const t = buildBuildings([building(1, [[square(0, 0, 3), square(1, 1, 1)]])], origin);
    expect(buildingMesh(t)).toEqual(buildingMesh(t));
  });
});
