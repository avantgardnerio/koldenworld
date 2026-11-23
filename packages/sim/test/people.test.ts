import { describe, expect, it } from "vitest";
import { createPeople, removePeople, Rng, spawnPerson, stepPeople, WALK } from "../src/index.ts";

const start = { cell: 0, edge: 3, side: 1, dir: 1, s: 0, length: 50 };

describe("people", () => {
  it("walk at their own pace near WALK.speed, keeping right", () => {
    const people = createPeople(), rng = new Rng(1);
    for (let k = 0; k < 100; k++) spawnPerson(people, start, rng);
    const { speed, across } = people.c;
    for (let i = 0; i < people.count; i++) {
      expect(Math.abs(speed[i]! - WALK.speed)).toBeLessThanOrEqual(WALK.spread);
      expect(across[i]).toBeCloseTo(WALK.keep, 6);
    }
    expect(Math.max(...speed.subarray(0, 100)) - Math.min(...speed.subarray(0, 100))).toBeGreaterThan(WALK.spread);
  });

  it("advances the phase with distance: a full turn per stride", () => {
    const people = createPeople(), i = spawnPerson(people, start, new Rng(2));
    const { phase, speed, s } = people.c;
    phase[i] = 0;
    // Exactly one stride, in small steps.
    const steps = 100, dt = WALK.stride / speed[i]! / steps;
    for (let k = 0; k < steps; k++) stepPeople(people, dt);
    expect(s[i]).toBeCloseTo(WALK.stride, 4);
    const p = phase[i]!;
    expect(Math.min(p, 2 * Math.PI - p)).toBeLessThan(1e-3);
  });

  it("turn round at the end of their edge and walk back", () => {
    const people = createPeople(), i = spawnPerson(people, { ...start, s: 49.5 }, new Rng(3));
    const { s, dir, speed } = people.c;
    stepPeople(people, 1 / speed[i]!);  // 1 m: 0.5 m past the end
    expect(dir[i]).toBe(-1);
    expect(s[i]).toBeCloseTo(0.5, 4);
  });

  it("leave with their cell", () => {
    const people = createPeople(), rng = new Rng(4);
    spawnPerson(people, start, rng);
    spawnPerson(people, { ...start, cell: 1 }, rng);
    removePeople(people, (cell) => cell === 1);
    expect(people.count).toBe(1);
    expect(people.c.cell[0]).toBe(1);
  });
});
