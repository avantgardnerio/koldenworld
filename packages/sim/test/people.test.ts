import { describe, expect, it } from "vitest";
import {
  createPeople, NO_CROSSING, PASSAGE, removePeople, Rng, SIDEWALK_LEG, spawnPerson, stepPeople, WALK, type SidewalkNet,
} from "../src/index.ts";

// A tiny net in cell 0: 50 m edges, walkable from 3 m to 47 m. From the end of edge 0, a 4 m passage round the corner
// onto edge 1 (weight 3), or a 10 m one across edge 2 onto edge 3 (weight 1); from anywhere else, back the way they came.
function net(): SidewalkNet {
  return {
    enter: () => 3,
    leave: () => 47,
    onward(cell, edge, dir, side, _across, out) {
      if (edge === 0 && dir === 1) out.push(3, 4, NO_CROSSING, 0, 0, 0, 1, 1, side, 1, 10, 0, 2, 1, 0, 3, -1, side);
      else out.push(1, 1, NO_CROSSING, 0, 0, cell, edge, -dir, side);
    },
  };
}
const start = { cell: 0, edge: 0, side: 1, dir: 1, s: 10 };

describe("people", () => {
  it("walk at their own pace near WALK.speed, keeping right, on the walkable part of the sidewalk", () => {
    const people = createPeople(), rng = new Rng(1), n = net();
    for (let k = 0; k < 100; k++) spawnPerson(people, n, { ...start, s: k }, rng);
    const { speed, across, s } = people.c;
    for (let i = 0; i < people.count; i++) {
      expect(Math.abs(speed[i]! - WALK.speed)).toBeLessThanOrEqual(WALK.spread);
      expect(across[i]).toBeCloseTo(WALK.keep, 6);
      expect(s[i]).toBeGreaterThanOrEqual(3);
      expect(s[i]).toBeLessThanOrEqual(47);
    }
    expect(Math.max(...speed.subarray(0, 100)) - Math.min(...speed.subarray(0, 100))).toBeGreaterThan(WALK.spread);
  });

  it("advances the phase with distance: a full turn per stride", () => {
    const people = createPeople(), n = net(), rng = new Rng(2), i = spawnPerson(people, n, start, rng);
    const { phase, speed, s } = people.c;
    phase[i] = 0;
    const steps = 100, dt = WALK.stride / speed[i]! / steps;
    for (let k = 0; k < steps; k++) stepPeople(people, n, dt, rng);
    expect(s[i]! - start.s).toBeCloseTo(WALK.stride, 4);
    const p = phase[i]!;
    expect(Math.min(p, 2 * Math.PI - p)).toBeLessThan(1e-3);
  });

  it("take a passage at the end of the sidewalk, then walk on along the sidewalk after it", () => {
    const people = createPeople(), n = net(), rng = new Rng(3), i = spawnPerson(people, n, { ...start, s: 46.5 }, rng);
    const c = people.c;
    stepPeople(people, n, 1 / c.speed[i]!, rng);  // 1 m: 0.5 m into the passage
    expect(c.leg[i]).toBe(PASSAGE);
    expect(c.s[i]).toBeCloseTo(0.5, 4);
    const [length, edge] = [c.end[i]!, c.nedge[i]!];
    expect([[4, 1], [10, 3]]).toContainEqual([length, edge]);
    stepPeople(people, n, length / c.speed[i]!, rng);  // through it: 0.5 m onto the next sidewalk
    expect(c.leg[i]).toBe(SIDEWALK_LEG);
    expect(c.edge[i]).toBe(edge);
    expect(c.s[i]).toBeCloseTo(3.5, 4);
    expect(c.end[i]).toBe(47);
  });

  it("pick ways on by weight", () => {
    const people = createPeople(), n = net(), rng = new Rng(4);
    for (let k = 0; k < 2000; k++) spawnPerson(people, n, { ...start, s: 47 }, rng);
    stepPeople(people, n, 0.001, rng);
    let corner = 0;
    for (let i = 0; i < people.count; i++) if (people.c.nedge[i] === 1) corner++;
    expect(corner / people.count).toBeGreaterThan(0.7);
    expect(corner / people.count).toBeLessThan(0.8);
  });

  it("leave with their cell, or the cells their passage reaches", () => {
    const people = createPeople(), n = net(), rng = new Rng(5);
    spawnPerson(people, n, start, rng);
    spawnPerson(people, n, { ...start, cell: 1 }, rng);
    const crossing = spawnPerson(people, n, { ...start, cell: 1 }, rng);
    Object.assign(people.cursor(crossing), { leg: PASSAGE, xcell: 2, ncell: 1 });
    removePeople(people, (cell) => cell === 1);
    expect(people.count).toBe(1);
    expect(people.c.cell[0]).toBe(1);
    expect(people.c.leg[0]).toBe(SIDEWALK_LEG);
  });
});
