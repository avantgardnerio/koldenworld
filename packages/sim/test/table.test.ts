import { describe, expect, it } from "vitest";
import { Table } from "../src/index.ts";

const SCHEMA = { x: Float32Array, id: Uint32Array, flag: Uint8Array };

describe("Table", () => {
  it("adds zeroed rows and grows by doubling, keeping values", () => {
    const t = new Table(SCHEMA, 2);
    for (let k = 0; k < 5; k++) {
      const i = t.add();
      t.c.id[i] = 100 + k;
    }
    expect(t.count).toBe(5);
    expect(t.capacity).toBe(8);
    expect([...t.c.id.subarray(0, 5)]).toEqual([100, 101, 102, 103, 104]);
    expect(t.c.x[4]).toBe(0);
  });

  it("removes by moving the last row in, so live rows stay packed", () => {
    const t = new Table(SCHEMA);
    for (let k = 0; k < 4; k++) t.c.id[t.add()] = k;
    t.remove(1);
    expect(t.count).toBe(3);
    expect([...t.c.id.subarray(0, 3)]).toEqual([0, 3, 2]);
    t.remove(2);  // the last row: just drops
    expect([...t.c.id.subarray(0, 2)]).toEqual([0, 3]);
  });

  it("gives a cursor that reads and writes the row it points at, and follows growth", () => {
    const t = new Table(SCHEMA, 1);
    const row = t.cursor(t.add());
    row.x = 1.5;
    row.id = 7;
    expect(t.c.x[0]).toBe(1.5);
    t.add();  // grows: columns are replaced
    row.i = 1;
    row.flag = 1;
    expect(t.c.flag[1]).toBe(1);
    row.i = 0;
    expect([row.x, row.id]).toEqual([1.5, 7]);
    // Cursors of the same schema share a class: one hidden class, fast property access.
    expect(Object.getPrototypeOf(t.cursor())).toBe(Object.getPrototypeOf(row));
  });
});
