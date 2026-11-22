import { describe, expect, it } from "vitest";
import {
  AEROWAY_LIFT, AerowayMaterial, aerowaysFromArrow, aerowaysToArrow, CELL_LEVEL, cellAeroways, cellCenter, cellFrame,
  cellFromLatLon, enuUnprojection, groundSampler,
} from "../src/index.ts";

const cell = cellFromLatLon(39.86, -104.67, CELL_LEVEL);
const frame = cellFrame(cell);
const c = cellCenter(cell);
const ll = enuUnprojection(frame);

describe("cellAeroways", () => {
  it("clips a runway crossing the cell to the cell, on the ground, above the taxiway and apron it crosses", () => {
    const runway = { osmId: 1, kind: "runway" as const, width: 60, points: [ll(-5000, 0), ll(5000, 0)] };
    const taxiway = { osmId: 2, kind: "taxiway" as const, width: 23, points: [ll(0, -300), ll(0, 300)] };
    const apron = { osmId: 3, kind: "apron" as const, polygons: [[[ll(-100, -100), ll(100, -100), ll(100, 100), ll(-100, 100), ll(-100, -100)]]] };
    const ground = groundSampler(() => 1600, CELL_LEVEL);
    const m = cellAeroways(cell, frame, [apron], [taxiway, runway], ground);
    expect(m.positions.length).toBe(3 * m.material.length);
    expect(m.material.length % 3).toBe(0);
    // Drawn in stacking order, each kind at its lift above the 1,600 m ground.
    const mats = [...m.material];
    expect(mats).toEqual([...mats].sort());
    const zOf = (mat: number) => {
      const i = mats.indexOf(mat);
      return m.positions[3 * i + 2]!;
    };
    const base = zOf(AerowayMaterial.Apron);
    expect(zOf(AerowayMaterial.Taxiway) - base).toBeCloseTo(AEROWAY_LIFT[1]!, 1);
    expect(zOf(AerowayMaterial.Runway) - base).toBeCloseTo(AEROWAY_LIFT[2]!, 1);
    // The 10 km runway is cut to this cell (~1–2 km across).
    let x0 = Infinity, x1 = -Infinity;
    for (let i = 0; i < mats.length; i++) {
      if (mats[i] !== AerowayMaterial.Runway) continue;
      x0 = Math.min(x0, m.positions[3 * i]!);
      x1 = Math.max(x1, m.positions[3 * i]!);
    }
    expect(x1 - x0).toBeGreaterThan(500);
    expect(x1 - x0).toBeLessThan(2500);
    expect(c.lat).toBeCloseTo(39.86, 1);
  });

  it("round-trips through Arrow", () => {
    const m = cellAeroways(cell, frame, [], [{ osmId: 1, kind: "taxiway", width: 20, points: [ll(-50, 0), ll(50, 0)] }]);
    const back = aerowaysFromArrow(aerowaysToArrow(m, {}));
    expect([...back.material]).toEqual([...m.material]);
    expect([...back.positions]).toEqual([...m.positions]);
  });
});
