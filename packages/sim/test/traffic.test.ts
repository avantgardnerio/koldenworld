import { describe, expect, it } from "vitest";
import { createCars, LANE_BONUS, MPH, removeCars, Rng, spawnCar, stepTraffic, type RoadNet } from "../src/index.ts";

// A tiny network in one cell (0): a one-way loop of four 100 m edges (0→1→2→3→0, two lanes,
// 30 mph), and a two-way 50 m spur (edge 4, one lane each way) from node 0 to a dead end.
// Edge e of the loop runs node e → node e+1.
const LIMIT = 30 * MPH;
function net(): RoadNet & { exitCalls: number } {
  const n = {
    exitCalls: 0,
    length: (_c: number, e: number) => (e < 4 ? 100 : 50),
    speedLimit: () => LIMIT,
    lanes: (_c: number, e: number, dir: number) => (e < 4 ? (dir > 0 ? 2 : 0) : 1),
    exits(_c: number, e: number, dir: number, out: number[]) {
      n.exitCalls++;
      const node = e < 4 ? (dir > 0 ? (e + 1) % 4 : e) : (dir > 0 ? 9 : 0);  // node 9: the spur's dead end
      if (node === 0) out.push(0, 0, 1, 0, 4, 1);  // onto the loop, or onto the spur
      else if (node === 9) out.push(0, 4, -1);      // dead end: only back
      else out.push(0, node, 1);
    },
  };
  return n;
}

describe("traffic", () => {
  it("drives at the limit in the right lane and 10 mph faster per lane to the left", () => {
    const n = net(), cars = createCars();
    const right = spawnCar(cars, n, { model: 0, cell: 0, edge: 1, dir: 1, lane: 1, s: 0 });
    const left = spawnCar(cars, n, { model: 0, cell: 0, edge: 2, dir: 1, lane: 0, s: 0 });
    expect(cars.c.target[right]).toBeCloseTo(LIMIT, 4);  // float32 columns
    expect(cars.c.target[left]).toBeCloseTo(LIMIT + LANE_BONUS, 4);
    // Starting from rest, they accelerate to their targets and hold them.
    const rng = new Rng(1);
    for (let k = 0; k < 60; k++) stepTraffic(cars, n, 0.05, rng);  // 3 s: not yet at speed
    expect(cars.c.speed[right]).toBeCloseTo(3 * 2.5, 3);
    for (let k = 0; k < 400; k++) stepTraffic(cars, n, 0.05, rng);
    // Lanes are re-picked on each new edge (so a car may be mid-acceleration): targets follow the lane.
    for (let i = 0; i < cars.count; i++) {
      expect(cars.c.target[i]).toBeCloseTo(LIMIT + LANE_BONUS * (1 - cars.c.lane[i]!), 4);
      expect(cars.c.speed[i]).toBeLessThanOrEqual(LIMIT + LANE_BONUS + 1e-4);
      expect(cars.c.speed[i]).toBeGreaterThanOrEqual(LIMIT - 1e-4);
    }
  });

  it("moves on to the next edge, carrying the distance over, and never U-turns unless it must", () => {
    const n = net(), cars = createCars();
    const i = spawnCar(cars, n, { model: 0, cell: 0, edge: 0, dir: 1, lane: 1, s: 99 });
    cars.c.speed[i] = cars.c.target[i]!;
    stepTraffic(cars, n, 0.1, new Rng(1));
    expect(cars.c.edge[i]).toBe(1);
    expect(cars.c.s[i]).toBeCloseTo(99 + LIMIT * 0.1 - 100, 4);
    // Down the spur: at its dead end the only way is back.
    const j = spawnCar(cars, n, { model: 0, cell: 0, edge: 4, dir: 1, lane: 0, s: 49 });
    cars.c.speed[j] = 10;
    stepTraffic(cars, n, 0.2, new Rng(1));
    expect([cars.c.edge[j], cars.c.dir[j]]).toEqual([4, -1]);
  });

  it("crosses several short edges in one long step", () => {
    const n = net(), cars = createCars();
    const i = spawnCar(cars, n, { model: 0, cell: 0, edge: 1, dir: 1, lane: 1, s: 0 });
    cars.c.speed[i] = 100;
    cars.c.target[i] = 100;
    stepTraffic(cars, n, 2.5, new Rng(1));  // 250 m: two and a half loop edges
    expect(cars.c.edge[i]).toBe(3);
    expect(cars.c.s[i]).toBeCloseTo(50, 3);
  });

  it("is deterministic for a seed", () => {
    const run = (seed: number) => {
      const n = net(), cars = createCars(), rng = new Rng(seed);
      for (let k = 0; k < 20; k++) spawnCar(cars, n, { model: k % 3, cell: 0, edge: k % 5, dir: 1, lane: 0, s: k * 2 });
      for (let k = 0; k < 2000; k++) stepTraffic(cars, n, 1 / 30, rng);
      return [...cars.c.edge.subarray(0, cars.count), ...cars.c.s.subarray(0, cars.count)];
    };
    expect(run(3)).toEqual(run(3));
    expect(run(3)).not.toEqual(run(4));
  });

  it("removes cars in cells that are left behind, keeping the rest packed", () => {
    const n = net(), cars = createCars();
    for (let k = 0; k < 6; k++) spawnCar(cars, n, { model: 0, cell: k % 2, edge: 0, dir: 1, lane: 0, s: k });
    removeCars(cars, (cell) => cell === 0);
    expect(cars.count).toBe(3);
    expect([...cars.c.cell.subarray(0, 3)]).toEqual([0, 0, 0]);
  });
});
