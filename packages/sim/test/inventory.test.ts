import { describe, expect, it } from "vitest";
import { createInventory, fire, held, ITEMS, reload, select, stepInventory } from "../src/index.ts";

const pistol = ITEMS.pistol.gun!;

describe("inventory", () => {
  it("starts with empty hands in hand and a loaded pistol; hands don't fire", () => {
    const inv = createInventory();
    expect(held(inv)).toBe("hands");
    expect(fire(inv)).toBe(false);
    select(inv, 1);
    expect(held(inv)).toBe("pistol");
    expect(inv.rounds[1]).toBe(pistol.magazine);
    select(inv, 5);  // no such slot
    expect(held(inv)).toBe("pistol");
  });

  it("fires a round a shot, no faster than its interval", () => {
    const inv = createInventory();
    select(inv, 1);
    expect(fire(inv)).toBe(true);
    expect(fire(inv)).toBe(false);  // too soon
    stepInventory(inv, pistol.interval);
    expect(fire(inv)).toBe(true);
    expect(inv.rounds[1]).toBe(pistol.magazine - 2);
  });

  it("runs dry, reloads on the next pull, and can't fire till it's done", () => {
    const inv = createInventory();
    select(inv, 1);
    for (let k = 0; k < pistol.magazine; k++) {
      expect(fire(inv)).toBe(true);
      stepInventory(inv, pistol.interval);
    }
    expect(fire(inv)).toBe(false);  // empty: starts reloading
    expect(inv.reloading).toBe(pistol.reload);
    stepInventory(inv, pistol.reload / 2);
    expect(fire(inv)).toBe(false);
    stepInventory(inv, pistol.reload / 2);
    expect(inv.rounds[1]).toBe(pistol.magazine);
    expect(fire(inv)).toBe(true);
  });

  it("reloads on demand unless full; switching away stops it", () => {
    const inv = createInventory();
    select(inv, 1);
    reload(inv);
    expect(inv.reloading).toBe(0);  // full
    fire(inv);
    reload(inv);
    expect(inv.reloading).toBe(pistol.reload);
    select(inv, 0);
    expect(inv.reloading).toBe(0);
    select(inv, 1);
    expect(inv.rounds[1]).toBe(pistol.magazine - 1);
  });
});
