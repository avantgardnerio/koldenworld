import { describe, expect, it } from "vitest";
import { CellStreamer } from "../src/streaming.ts";

/** A streamer whose loads resolve or fail when the test says so. */
function setup(concurrency = 2) {
  const pending = new Map<bigint, { resolve: (v: string) => void; reject: (e: Error) => void }>();
  const disposed: string[] = [];
  let changes = 0, now = 0;
  const s = new CellStreamer<string>({
    load: (c) => new Promise((resolve, reject) => pending.set(c, { resolve, reject })),
    dispose: (d) => disposed.push(d),
    onChange: () => changes++,
    concurrency,
    retryMs: 1000,
    now: () => now,
  });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { s, pending, disposed, changes: () => changes, setNow: (t: number) => { now = t; }, tick };
}

describe("CellStreamer", () => {
  it("loads nearest first, a few at a time", async () => {
    const t = setup(2);
    t.s.update([1n, 2n, 3n], new Set([1n, 2n, 3n]));
    expect([...t.pending.keys()]).toEqual([1n, 2n]);
    expect(t.s.counts()).toMatchObject({ loading: 2, queued: 1 });
    t.pending.get(2n)!.resolve("two");
    await t.tick();
    expect([...t.pending.keys()]).toEqual([1n, 2n, 3n]);
    expect([...t.s.ready()]).toEqual([[2n, "two"]]);
    expect(t.changes()).toBe(1);
    expect(t.s.settled).toBe(false);
    t.pending.get(1n)!.resolve("one");
    t.pending.get(3n)!.resolve("three");
    await t.tick();
    expect(t.s.settled).toBe(true);
  });

  it("disposes cells that leave the keep set, even mid-load", async () => {
    const t = setup(2);
    t.s.update([1n, 2n], new Set([1n, 2n]));
    t.pending.get(1n)!.resolve("one");
    await t.tick();
    t.s.update([], new Set());
    expect(t.disposed).toEqual(["one"]);
    t.pending.get(2n)!.resolve("two");  // arrives after it was dropped
    await t.tick();
    expect(t.disposed).toEqual(["one", "two"]);
    expect([...t.s.ready()]).toEqual([]);
  });

  it("retries a failed cell after a while", async () => {
    const t = setup(1);
    t.s.update([1n], new Set([1n]));
    t.pending.get(1n)!.reject(new Error("502"));
    await t.tick();
    expect(t.s.counts().failed).toBe(1);
    t.pending.clear();
    t.s.update([1n], new Set([1n]));
    expect(t.pending.size).toBe(0);  // too soon
    t.setNow(2000);
    t.s.update([1n], new Set([1n]));
    expect([...t.pending.keys()]).toEqual([1n]);
  });
});
