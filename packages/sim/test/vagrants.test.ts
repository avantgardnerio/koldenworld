import { describe, expect, it } from "vitest";
import { createVagrants, ROAM, Rng, spawnVagrant, STATE, stepVagrants, type RoamWorld } from "../src/index.ts";

const open: RoamWorld = { blocked: () => false };

function crowd(n: number, seed: number) {
  const v = createVagrants(), rng = new Rng(seed);
  for (let k = 0; k < n; k++) spawnVagrant(v, 0, 0, 0, 0, 0, rng);
  return { v, rng };
}

describe("vagrants", () => {
  it("do everything in time: run, shout, stagger, stand, sit and lie; only running, shouting and staggering move", () => {
    const { v, rng } = crowd(50, 1), seen = new Set<number>(), c = v.c;
    const [runMin, runMax] = ROAM.speed[STATE.run]!;
    for (let k = 0; k < 30 * 600; k++) {
      const before = [...c.x.subarray(0, v.count)];
      stepVagrants(v, open, 1 / 30, rng);
      for (let i = 0; i < v.count; i++) {
        seen.add(c.state[i]!);
        if (!ROAM.speed[c.state[i]!]) expect(c.speed[i]).toBe(0);
        if (c.state[i] === STATE.run) expect(c.speed[i]).toBeGreaterThanOrEqual(runMin);
        // Never faster than a run.
        expect(Math.abs(c.x[i]! - before[i]!)).toBeLessThanOrEqual(runMax / 30 + 1e-4);
      }
    }
    expect([...seen].sort()).toEqual(Object.values(STATE).sort());
  });

  it("spend half their time running or shouting, half sleeping, staggering or sitting, from the start and later", () => {
    const { v, rng } = crowd(600, 4), c = v.c;
    const shares = () => {
      const n = Object.values(STATE).map(() => 0);
      for (let i = 0; i < v.count; i++) n[c.state[i]!]!++;
      return n.map((k) => k / v.count);
    };
    for (const minutes of [0, 30]) {
      for (let k = 0; k < 30 * 60 * minutes; k++) stepVagrants(v, open, 1 / 30, rng);
      const s = shares();
      for (const state of Object.values(STATE)) {
        expect(Math.abs(s[state]! - ROAM.share[state]!), `state ${state} at ${minutes} min`).toBeLessThan(0.06);
      }
    }
  });

  it("stay near their anchor", () => {
    const { v, rng } = crowd(50, 2), c = v.c;
    let far = 0;
    for (let k = 0; k < 30 * 1200; k++) {
      stepVagrants(v, open, 1 / 30, rng);
      for (let i = 0; i < v.count; i++) far = Math.max(far, Math.hypot(c.x[i]!, c.y[i]!));
    }
    expect(far).toBeGreaterThan(40);
    expect(far).toBeLessThan(ROAM.leash + 10);
  });

  it("don't go through walls", () => {
    // A wall along x = 5, everywhere.
    const wall: RoamWorld = { blocked: (_c, x0, _y0, x1) => (x0 - 5) * (x1 - 5) <= 0 && x0 !== x1 };
    const { v, rng } = crowd(50, 3), c = v.c;
    for (let k = 0; k < 30 * 600; k++) {
      stepVagrants(v, wall, 1 / 30, rng);
      for (let i = 0; i < v.count; i++) expect(c.x[i]).toBeLessThan(5);
    }
  });
});
