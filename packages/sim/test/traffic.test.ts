import { describe, expect, it } from "vitest";
import {
  CAR_LENGTH, createCars, GAP, LANE_BONUS, MPH, nextLane, NONE, removeCars, Rng, spawnCar, stepTraffic, type RoadNet,
} from "../src/index.ts";

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
    const n = net(), cars = createCars(), rng = new Rng(1);
    const right = spawnCar(cars, n, { model: 0, cell: 0, edge: 1, dir: 1, lane: 1, s: 0 }, rng);
    const left = spawnCar(cars, n, { model: 0, cell: 0, edge: 2, dir: 1, lane: 0, s: 0 }, rng);
    expect(cars.c.target[right]).toBeCloseTo(LIMIT, 4);  // float32 columns
    expect(cars.c.target[left]).toBeCloseTo(LIMIT + LANE_BONUS, 4);
    // Starting from rest, they accelerate to their targets and hold them.
    for (let k = 0; k < 60; k++) stepTraffic(cars, n, 0.05, rng);  // 3 s: not yet at speed
    expect(cars.c.speed[right]).toBeCloseTo(3 * 2.5, 3);
    for (let k = 0; k < 400; k++) stepTraffic(cars, n, 0.05, rng);
    // Lanes may change on a new edge (from the spur onto the loop): targets follow the lane.
    for (let i = 0; i < cars.count; i++) {
      expect(cars.c.target[i]).toBeCloseTo(LIMIT + LANE_BONUS * (1 - cars.c.lane[i]!), 4);
      expect(cars.c.speed[i]).toBeLessThanOrEqual(LIMIT + LANE_BONUS + 1e-4);
      expect(cars.c.speed[i]).toBeGreaterThanOrEqual(LIMIT - 1e-4);
    }
  });

  it("never goes faster than its cap: slows to it, stops at 0, and drives on once it's lifted", () => {
    const n = net(), cars = createCars(), rng = new Rng(1);
    const i = spawnCar(cars, n, { model: 0, cell: 0, edge: 1, dir: 1, lane: 1, s: 0 }, rng);
    expect(cars.c.cap[i]).toBe(Infinity);
    for (let k = 0; k < 200; k++) stepTraffic(cars, n, 0.05, rng);
    expect(cars.c.speed[i]).toBeCloseTo(LIMIT, 3);
    cars.c.cap[i] = 0;  // something stopped right ahead
    for (let k = 0; k < 100; k++) stepTraffic(cars, n, 0.05, rng);
    expect(cars.c.speed[i]).toBe(0);
    cars.c.cap[i] = Infinity;
    for (let k = 0; k < 20; k++) stepTraffic(cars, n, 0.05, rng);
    expect(cars.c.speed[i]).toBeGreaterThan(0);
  });

  it("queues behind a stopped car in its lane, keeping the gap", () => {
    const n = net(), cars = createCars(), rng = new Rng(1);
    const ahead = spawnCar(cars, n, { model: 0, cell: 0, edge: 1, dir: 1, lane: 1, s: 60 }, rng);
    const behind = spawnCar(cars, n, { model: 0, cell: 0, edge: 1, dir: 1, lane: 1, s: 0 }, rng);
    const other = spawnCar(cars, n, { model: 0, cell: 0, edge: 1, dir: 1, lane: 0, s: 0 }, rng);  // the next lane over
    cars.c.cap[ahead] = 0;  // stopped (something in front of it)
    for (let k = 0; k < 200; k++) stepTraffic(cars, n, 0.05, rng);
    expect(cars.c.speed[behind]).toBe(0);
    const gap = cars.c.s[ahead]! - cars.c.s[behind]! - CAR_LENGTH;
    expect(gap).toBeGreaterThanOrEqual(GAP - 0.01);
    expect(gap).toBeLessThan(GAP + 1);
    expect(cars.c.edge[other]).not.toBe(1);  // the other lane drove on past
  });

  it("follows the car on the road it turns onto, across the junction", () => {
    const n = net(), cars = createCars(), rng = new Rng(1);
    // Edge 1 leads onto edge 2 (the loop); a stopped car 3 m into edge 2, in the lane the follower takes.
    const behind = spawnCar(cars, n, { model: 0, cell: 0, edge: 1, dir: 1, lane: 1, s: 0 }, rng);
    const ahead = spawnCar(cars, n, { model: 0, cell: 0, edge: 2, dir: 1, lane: cars.c.nlane[behind]!, s: 3 }, rng);
    cars.c.cap[ahead] = 0;
    for (let k = 0; k < 300; k++) stepTraffic(cars, n, 0.05, rng);
    expect(cars.c.edge[behind]).toBe(1);  // stopped short of the junction
    expect(cars.c.speed[behind]).toBe(0);
    expect(100 - cars.c.s[behind]! + 3 - CAR_LENGTH).toBeGreaterThanOrEqual(GAP - 0.01);
  });

  it("picks its way onward on entry, then moves on to it, carrying the distance over", () => {
    const n = net(), cars = createCars(), rng = new Rng(1);
    const i = spawnCar(cars, n, { model: 0, cell: 0, edge: 0, dir: 1, lane: 1, s: 99 }, rng);
    expect(cars.c.pcell[i]).toBe(NONE);
    expect([cars.c.ncell[i], cars.c.nedge[i], cars.c.ndir[i], cars.c.nlane[i]]).toEqual([0, 1, 1, 1]);
    cars.c.speed[i] = cars.c.target[i]!;
    stepTraffic(cars, n, 0.1, rng);
    expect(cars.c.edge[i]).toBe(1);
    expect(cars.c.s[i]).toBeCloseTo(99 + LIMIT * 0.1 - 100, 4);
    // It remembers where it came from, and has picked the next road already.
    expect([cars.c.pcell[i], cars.c.pedge[i], cars.c.pdir[i], cars.c.plane[i]]).toEqual([0, 0, 1, 1]);
    expect([cars.c.nedge[i], cars.c.ndir[i]]).toEqual([2, 1]);
  });

  it("never U-turns unless it must, and leaves where there is no way on", () => {
    const n = net(), cars = createCars(), rng = new Rng(1);
    // Down the spur: at its dead end the only way is back.
    const j = spawnCar(cars, n, { model: 0, cell: 0, edge: 4, dir: 1, lane: 0, s: 49 }, rng);
    expect([cars.c.nedge[j], cars.c.ndir[j]]).toEqual([4, -1]);
    cars.c.speed[j] = 10;
    stepTraffic(cars, n, 0.2, rng);
    expect([cars.c.edge[j], cars.c.dir[j]]).toEqual([4, -1]);
    // With nowhere to go, it drives to the end and is gone.
    const none: RoadNet = { ...n, exits: () => {} };
    const k = spawnCar(cars, none, { model: 0, cell: 0, edge: 1, dir: 1, lane: 0, s: 99 }, rng);
    expect(cars.c.ncell[k]).toBe(NONE);
    cars.c.speed[k] = 20;
    const before = cars.count;
    stepTraffic(cars, none, 0.1, rng);
    expect(cars.count).toBe(before - 1);
  });

  it("keeps its lane counted from the right, spreading over lanes a road adds", () => {
    const rng = new Rng(5);
    expect(nextLane(1, 2, 2, rng)).toBe(1);  // right stays right
    expect(nextLane(0, 2, 2, rng)).toBe(0);
    expect(nextLane(0, 3, 1, rng)).toBe(0);  // lanes end: merge
    expect([1, 2]).toContain(nextLane(1, 2, 3, rng));  // the right lane, or the one the road adds next to it
    const seen = new Set<number>();
    for (let k = 0; k < 50; k++) seen.add(nextLane(0, 1, 3, rng));  // one lane into three: any of them
    expect([...seen].sort()).toEqual([0, 1, 2]);
  });

  it("crosses several short edges in one long step", () => {
    const n = net(), cars = createCars(), rng = new Rng(1);
    const i = spawnCar(cars, n, { model: 0, cell: 0, edge: 1, dir: 1, lane: 1, s: 0 }, rng);
    cars.c.speed[i] = 100;
    cars.c.target[i] = 100;
    stepTraffic(cars, n, 2.5, rng);  // 250 m: two and a half loop edges
    expect(cars.c.edge[i]).toBe(3);
    expect(cars.c.s[i]).toBeCloseTo(50, 3);
    expect(cars.c.pedge[i]).toBe(2);
  });

  it("is deterministic for a seed", () => {
    const run = (seed: number) => {
      const n = net(), cars = createCars(), rng = new Rng(seed);
      for (let k = 0; k < 20; k++) spawnCar(cars, n, { model: k % 3, cell: 0, edge: k % 5, dir: 1, lane: 0, s: k * 2 }, rng);
      for (let k = 0; k < 2000; k++) stepTraffic(cars, n, 1 / 30, rng);
      return [...cars.c.edge.subarray(0, cars.count), ...cars.c.s.subarray(0, cars.count)];
    };
    expect(run(3)).toEqual(run(3));
    expect(run(3)).not.toEqual(run(4));
  });

  it("removes cars in cells that are left behind, keeping the rest packed", () => {
    const n = net(), cars = createCars(), rng = new Rng(1);
    for (let k = 0; k < 6; k++) spawnCar(cars, n, { model: 0, cell: k % 2, edge: 0, dir: 1, lane: 0, s: k }, rng);
    removeCars(cars, (cell) => cell === 0);
    expect(cars.count).toBe(3);
    expect([...cars.c.cell.subarray(0, 3)]).toEqual([0, 0, 0]);
  });
});
