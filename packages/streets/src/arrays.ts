// Growable typed arrays, the vertex table and rings: everything in this package
// is columns of numbers and indices into them (decision 1), never an object per
// point.

/** A growable Int32Array. */
export class I32 {
  data: Int32Array;
  length = 0;
  constructor(capacity = 64) { this.data = new Int32Array(capacity); }
  push(v: number): void {
    if (this.length === this.data.length) {
      const next = new Int32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = v;
  }
  view(): Int32Array { return this.data.subarray(0, this.length); }
}

/** A growable Float64Array. */
export class F64 {
  data: Float64Array;
  length = 0;
  constructor(capacity = 64) { this.data = new Float64Array(capacity); }
  push(v: number): void {
    if (this.length === this.data.length) {
      const next = new Float64Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = v;
  }
  view(): Float64Array { return this.data.subarray(0, this.length); }
}

/**
 * The vertex table: x, y, z per vertex, by index. A vertex is its index; points
 * that are the same are the same index. z is NaN where a vertex has no height
 * (e.g. a clipping window's corners).
 */
export class Verts {
  xyz: Float64Array;
  count = 0;
  constructor(capacity = 1024) { this.xyz = new Float64Array(3 * capacity); }
  push(x: number, y: number, z: number): number {
    if (3 * this.count === this.xyz.length) {
      const next = new Float64Array(this.xyz.length * 2);
      next.set(this.xyz);
      this.xyz = next;
    }
    const i = this.count++;
    this.xyz[3 * i] = x;
    this.xyz[3 * i + 1] = y;
    this.xyz[3 * i + 2] = z;
    return i;
  }
  x(i: number): number { return this.xyz[3 * i]!; }
  y(i: number): number { return this.xyz[3 * i + 1]!; }
  z(i: number): number { return this.xyz[3 * i + 2]!; }
}

/** Rings of vertex indices, CSR: ring r is verts[start[r] .. start[r + 1]). */
export interface Rings {
  start: Int32Array;  // count + 1
  verts: Int32Array;
}

/** Builds Rings a vertex at a time. */
export class RingsBuilder {
  start = new I32();
  verts = new I32();
  constructor() { this.start.push(0); }
  add(v: number): void { this.verts.push(v); }
  close(): void { this.start.push(this.verts.length); }
  /** Drops the ring being built (back to the last close). */
  discard(): void { this.verts.length = this.start.data[this.start.length - 1]!; }
  rings(): Rings { return { start: this.start.view().slice(), verts: this.verts.view().slice() }; }
}

export const ringCount = (r: Rings) => r.start.length - 1;

/** Signed area of ring k (counterclockwise positive). */
export function ringArea(V: Verts, r: Rings, k: number): number {
  let s = 0;
  const a = r.start[k]!, b = r.start[k + 1]!;
  for (let i = a; i < b; i++) {
    const p = r.verts[i]!, q = r.verts[i + 1 < b ? i + 1 : a]!;
    s += V.x(p) * V.y(q) - V.x(q) * V.y(p);
  }
  return s / 2;
}

/** All rings of `parts`, one after the other, as one Rings. */
export function concatRings(...parts: Rings[]): Rings {
  const b = new RingsBuilder();
  for (const r of parts) {
    for (let k = 0; k < ringCount(r); k++) {
      for (let i = r.start[k]!; i < r.start[k + 1]!; i++) b.add(r.verts[i]!);
      b.close();
    }
  }
  return b.rings();
}

// Sorting index arrays by a key column, with no closure per call.
let sortKey: Float64Array = new Float64Array(0);
const byKey = (a: number, b: number) => sortKey[a]! - sortKey[b]!;
/** Sorts `idx` (indices into `key`) by key, ascending. */
export function sortBy(idx: Int32Array, key: Float64Array): void {
  sortKey = key;
  idx.sort(byKey);
}
