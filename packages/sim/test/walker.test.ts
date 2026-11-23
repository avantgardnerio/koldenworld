import { describe, expect, it } from "vitest";
import { placeWalker, stepWalker, WALKER, walkerGait, type VehicleWorld, type WalkInput } from "../src/index.ts";

// Flat ground with a wall along x = 10 (y from −50 to 50); or a slope rising 1 m per 10 m east.
const flat: VehicleWorld = { height: () => 0, walls: (_x0, _y0, x1, _y1, visit) => { if (x1 >= 9) visit(10, -50, 10, 50); } };
const slope: VehicleWorld = { height: (x) => x / 10, walls: () => {} };
const go = (dx: number, dy: number, run = false, jump = false): WalkInput => ({ dx, dy, run, jump });

function walk(world: VehicleWorld, input: WalkInput, seconds: number, start = 0) {
  const w = placeWalker(start, 0, 0, world);
  for (let k = 0; k < seconds * 60; k++) stepWalker(w, input, 1 / 60, world);
  return w;
}

describe("walker", () => {
  it("walks and runs at their paces, facing where they go", () => {
    const w = walk(flat, go(0, 1), 3), r = walk(flat, go(0, 1, true), 3);
    expect(Math.hypot(w.vx, w.vy)).toBeCloseTo(WALKER.walk, 3);
    expect(Math.hypot(r.vx, r.vy)).toBeCloseTo(WALKER.run, 3);
    expect(w.heading).toBeCloseTo(Math.PI / 2, 3);
    expect(walkerGait(w)).toBeCloseTo(1, 3);
    expect(walkerGait(r)).toBeCloseTo(WALKER.runGait, 3);
  });

  it("stops when there's nowhere to go, and goes no faster on a diagonal", () => {
    const w = placeWalker(0, 0, 0, flat);
    for (let k = 0; k < 120; k++) stepWalker(w, go(1, 1), 1 / 60, flat);
    expect(Math.hypot(w.vx, w.vy)).toBeCloseTo(WALKER.walk, 3);
    for (let k = 0; k < 60; k++) stepWalker(w, go(0, 0), 1 / 60, flat);
    expect(Math.hypot(w.vx, w.vy)).toBe(0);
  });

  it("can't go through a wall: stops a radius short of it", () => {
    const w = walk(flat, go(1, 0, true), 5);
    expect(w.x).toBeLessThanOrEqual(10 - WALKER.radius + 1e-6);
    expect(w.x).toBeGreaterThan(10 - WALKER.radius - 0.05);
  });

  it("stands on the ground, and jumps off it and lands", () => {
    expect(walk(slope, go(1, 0), 2).z).toBeCloseTo(walk(slope, go(1, 0), 2).x / 10, 6);
    const w = placeWalker(0, 0, 0, flat);
    stepWalker(w, go(0, 0, false, true), 1 / 60, flat);
    let top = 0;
    for (let k = 0; k < 120; k++) {
      stepWalker(w, go(0, 0), 1 / 60, flat);
      top = Math.max(top, w.z);
    }
    expect(top).toBeGreaterThan(0.9);
    expect(top).toBeLessThan(1.1);  // v²/2g ≈ 1.03 m
    expect([w.z, w.air]).toEqual([0, false]);
  });

  it("advances the walk phase by distance: a full turn per stride", () => {
    const w = placeWalker(0, 0, 0, flat);
    [w.vx, w.phase] = [WALKER.walk, 0];
    const steps = Math.round((WALKER.stride / WALKER.walk) * 600);
    for (let k = 0; k < steps; k++) stepWalker(w, go(1, 0), 1 / 600, flat);
    expect(Math.min(w.phase, 2 * Math.PI - w.phase)).toBeLessThan(0.02);
  });
});
