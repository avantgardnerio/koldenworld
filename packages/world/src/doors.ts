// Doors into buildings: where businesses' doors are (businesses.ts puts one
// under each sign), as columns, and the queries the building mesh and the
// walls need: a building's doors, and where along a wall they open. Pure.

/**
 * A door: this wide and tall, set this far into its wall's opening (the reveal is `reveal` deep), at least `margin`
 * from the wall's ends (m). A building starting higher than `street` m has none; nor one with floors lower than the
 * door plus `headroom`.
 */
export const DOOR = { width: 1.0, height: 2.2, inset: 0.12, reveal: 0.25, margin: 0.3, street: 1, headroom: 0.3 };

/**
 * Doors, as columns: each in building row `building`, its middle at the foot of the wall (x, y, z: m in the cell's
 * frame), the wall running (ux, uy) (as its ring: outward is (uy, −ux)).
 */
export interface Doors {
  count: number;
  building: Int32Array;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  ux: Float32Array;
  uy: Float32Array;
}

export const NO_DOORS: Doors = {
  count: 0, building: new Int32Array(0), x: new Float32Array(0), y: new Float32Array(0), z: new Float32Array(0),
  ux: new Float32Array(0), uy: new Float32Array(0),
};

/** Doors by building (CSR): building i's are order[start[i]] .. order[start[i + 1] − 1]. */
export interface DoorIndex {
  start: Uint32Array;
  order: Uint32Array;
}

export function doorIndex(d: Doors, buildings: number): DoorIndex {
  const start = new Uint32Array(buildings + 1), order = new Uint32Array(d.count);
  for (let k = 0; k < d.count; k++) start[d.building[k]! + 1]!++;
  for (let i = 0; i < buildings; i++) start[i + 1]! += start[i]!;
  const fill = start.slice(0, buildings);
  for (let k = 0; k < d.count; k++) order[fill[d.building[k]!]!++] = k;
  return { start, order };
}

/** How far a door's middle may be off a wall's line and still be on it, m. */
const ON_WALL = 0.01;
const along: number[] = [];

/**
 * Building i's doors on the wall from (x0, y0), `len` m along (dx, dy): their openings as (from, to) pairs, m along
 * it, in order, flat in an array reused by the next call.
 */
export function doorsAlong(
  d: Doors, index: DoorIndex, i: number, x0: number, y0: number, dx: number, dy: number, len: number,
): number[] {
  along.length = 0;
  for (let n = index.start[i]!; n < index.start[i + 1]!; n++) {
    const k = index.order[n]!, [rx, ry] = [d.x[k]! - x0, d.y[k]! - y0];
    const s = rx * dx + ry * dy;
    if (Math.abs(rx * dy - ry * dx) > ON_WALL || s - DOOR.width / 2 < 0 || s + DOOR.width / 2 > len) continue;
    along.push(s - DOOR.width / 2, s + DOOR.width / 2);
  }
  // Few per wall: sort the pairs by where they start.
  for (let a = 2; a < along.length; a += 2) {
    for (let b = a; b > 0 && along[b - 2]! > along[b]!; b -= 2) {
      [along[b - 2], along[b - 1], along[b], along[b + 1]] = [along[b]!, along[b + 1]!, along[b - 2]!, along[b - 1]!];
    }
  }
  return along;
}
