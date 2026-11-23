import { describe, expect, it } from "vitest";
import { LocalWorld } from "../src/local-world.ts";

// Flat ground at 0 and no cells; one wall across x = 20 (y from −10 to 10), `top` m high, as an obstacle.
function world(top: number): LocalWorld {
  const w = new LocalWorld(0, 0, { groundAt: () => 0, walls: () => undefined });
  w.setObstacles(new Float64Array(0), 0, w.anchorFrame, [0, 0], [20, -10, 20, 10, top]);
  return w;
}

describe("local world raycast", () => {
  it("stops a shot at a wall", () => {
    const r = world(10).raycast([0, 0, 1.5], [1, 0, 0], 200);
    expect(r.hit).toBe(true);
    expect(r.t).toBeCloseTo(20, 6);
  });

  it("lets a shot over a wall lower than it, and through where there's none", () => {
    expect(world(1).raycast([0, 0, 1.5], [1, 0, 0], 200)).toEqual({ t: 200, hit: false });
    expect(world(10).raycast([0, 0, 1.5], [0, 1, 0], 200)).toEqual({ t: 200, hit: false });
  });

  it("stops a shot at the ground, to a few cm", () => {
    const d = Math.SQRT1_2;
    const r = world(10).raycast([0, 0, 1.5], [0, -d, -d], 200);  // down at 45°, away from the wall: lands 1.5 m out
    expect(r.hit).toBe(true);
    expect(r.t * d).toBeCloseTo(1.5, 1);
  });
});
