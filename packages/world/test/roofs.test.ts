import { describe, expect, it } from "vitest";
import {
  buildBuildings, buildingMesh, enuFrame, enuProjection, enuUnprojection, pitchedRoof, WALL_PAINTS,
  type BuildingInput, type BuildingMesh,
} from "../src/index.ts";

const toLonLat = enuUnprojection(enuFrame({ lat: 0, lon: 0, h: 0 }));
const origin = enuProjection(enuFrame({ lat: 0, lon: 0, h: 0 }));
// A 10 × 8 m house, its long side east–west.
const rect = (x0: number, y0: number, x1: number, y1: number): [number, number][] =>
  [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]].map(([x, y]) => toLonLat(x!, y!));
const house = (osmId: number, extra: Partial<BuildingInput> = {}): BuildingInput => ({
  osmType: "way", osmId, kind: "house", isPart: false, height: 6, minHeight: 0, heightSource: "default",
  polygons: [[rect(0, 0, 10, 8)]], ...extra,
});
const RISE = 4 * Math.tan(Math.PI / 6);  // half the width, at 30°

/** The roof's triangles (material 1: residential roof): their area seen from above, and their heights. */
function roofOf(m: BuildingMesh) {
  let area = 0, z0 = Infinity, z1 = -Infinity;
  for (let t = 0; t < m.indices.length; t += 3) {
    const [a, b, c] = [m.indices[t]!, m.indices[t + 1]!, m.indices[t + 2]!];
    if (m.material[a] !== 1) continue;
    const p = (v: number) => [m.positions[3 * v]!, m.positions[3 * v + 1]!, m.positions[3 * v + 2]!];
    const [pa, pb, pc] = [p(a), p(b), p(c)];
    area += ((pb[0]! - pa[0]!) * (pc[1]! - pa[1]!) - (pc[0]! - pa[0]!) * (pb[1]! - pa[1]!)) / 2;
    for (const q of [pa, pb, pc]) [z0, z1] = [Math.min(z0, q[2]!), Math.max(z1, q[2]!)];
  }
  return { area, z0, z1 };
}

describe("pitched roofs", () => {
  it("rises from the long sides (gabled) or all four (hipped) to a ridge at the pitch", () => {
    // The rectangle's frame: center (5, 4), long axis along x, half sizes 5 and 4.
    const pts = Float64Array.of(0, 0, 10, 0, 10, 8, 0, 8);
    const gabled = pitchedRoof(pts, 0, 4, "gabled"), hipped = pitchedRoof(pts, 0, 4, "hipped");
    expect(gabled.faces.length).toBe(2);
    expect(hipped.faces.length).toBe(4);
    expect(gabled.rise(5, 4)).toBeCloseTo(RISE, 6);  // the ridge
    expect(gabled.rise(0, 4)).toBeCloseTo(RISE, 6);  // a gable end: the ridge runs to the wall
    expect(hipped.rise(0, 4)).toBeCloseTo(0, 6);     // a hip end: down at the eaves
    expect(gabled.rise(5, 0)).toBeCloseTo(0, 6);     // the eaves
    // An end wall crosses the ridge halfway up: the outline needs a vertex there.
    expect(gabled.breaks(0, 8, 0, 0)).toEqual([0.5]);
  });

  it("covers the footprint exactly, eaves to ridge", () => {
    for (const roofShape of ["gabled", "hipped"]) {
      const r = roofOf(buildingMesh(buildBuildings([house(1, { roofShape })], origin)));
      expect(r.area).toBeCloseTo(80, 3);
      expect(r.z0).toBeCloseTo(6, 3);
      expect(r.z1).toBeCloseTo(6 + RISE, 3);
    }
  });

  it("fills the gable ends: the walls meet the roof", () => {
    const m = buildingMesh(buildBuildings([house(1, { roofShape: "gabled" })], origin));
    // Wall vertices (normals level) at the west end, x = 0: the tallest reaches the ridge.
    let tallest = 0;
    for (let v = 0; v < m.material.length; v++) {
      if (m.normals[4 * v + 2] === 0 && Math.abs(m.positions[3 * v]!) < 1e-3) tallest = Math.max(tallest, m.positions[3 * v + 2]!);
    }
    expect(tallest).toBeCloseTo(6 + RISE, 3);
  });

  it("leaves big buildings, apartments, courtyards and tagged flat roofs flat", () => {
    const flat = (input: BuildingInput) => roofOf(buildingMesh(buildBuildings([input], origin))).z1;
    expect(flat(house(1, { polygons: [[rect(0, 0, 40, 30)]] }))).toBe(6);  // 1,200 m²
    expect(flat(house(2, { kind: "apartments" }))).toBe(6);
    expect(flat(house(3, { roofShape: "flat" }))).toBe(6);
  });

  it("paints houses by their OSM id, the same every time", () => {
    const paintOf = (id: number) => new Set(buildingMesh(buildBuildings([house(id)], origin)).paint);
    const walls = [...paintOf(7)].filter((p) => p >= 1 && p <= WALL_PAINTS);
    expect(walls.length).toBe(1);
    expect(paintOf(7)).toEqual(paintOf(7));
    const many = new Set(Array.from({ length: 40 }, (_, id) => [...paintOf(id + 1)].find((p) => p >= 1 && p <= WALL_PAINTS)));
    expect(many.size).toBeGreaterThan(4);  // houses differ
  });
});
