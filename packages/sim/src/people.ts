// People: pedestrians on the sidewalks, one row each in a Table.
//
// A person is on the sidewalk of (cell, edge) on a side (1: right of the
// edge's from → to, −1: left), walking in direction dir (+1 from → to, −1
// to → from), `s` meters past the node they entered at, `across` m right of
// the sidewalk's middle as they walk (so people keep right, and pass each
// other). Each walks at their own pace, around WALK.speed.
//
// The walk phase (radians; a full turn is two steps, WALK.stride m) advances
// with distance, not time, so feet don't slide at any pace.
//
// Not yet: corners and crossings. At the end of their edge a person turns
// round and walks back.
//
// The step is a batch pass over the columns (distance and phase for everyone)
// followed by a row pass for the few who reached the end of their edge.

import type { Rng } from "./rng.ts";
import { Table } from "./table.ts";

export const WALK = {
  speed: 1.4,    // m/s, the average pace
  spread: 0.25,  // m/s, either side of it
  stride: 1.5,   // m per walk cycle (two steps)
  keep: 0.4,     // m right of the sidewalk's middle
} as const;

export const PERSON = {
  cell: Uint16Array,    // the viewer's slot for the cell the edge belongs to
  edge: Uint32Array,
  side: Int8Array,      // 1: right of from → to, −1: left
  dir: Int8Array,
  s: Float32Array,      // m past the entry node
  length: Float32Array, // m, the edge's (copied on entry, so the batch pass needs no lookups)
  speed: Float32Array,  // m/s
  across: Float32Array, // m right of the sidewalk's middle, as they walk
  phase: Float32Array,  // radians, 0 .. 2π
} as const;
export type People = Table<typeof PERSON>;
export const createPeople = (capacity = 1024): People => new Table(PERSON, capacity);

export interface PersonStart {
  cell: number;
  edge: number;
  side: number;
  dir: number;
  s: number;
  length: number;  // the edge's, m
}

/** Adds a person at their own pace, mid-stride somewhere. Returns their row. */
export function spawnPerson(people: People, a: PersonStart, rng: Rng): number {
  const i = people.add(), c = people.c;
  c.cell[i] = a.cell;
  c.edge[i] = a.edge;
  c.side[i] = a.side;
  c.dir[i] = a.dir;
  c.s[i] = a.s;
  c.length[i] = a.length;
  c.speed[i] = WALK.speed + WALK.spread * (2 * rng.next() - 1);
  c.across[i] = WALK.keep;
  c.phase[i] = 2 * Math.PI * rng.next();
  return i;
}

/** Removes everyone whose cell fails the test (cells left behind). */
export function removePeople(people: People, keepCell: (cell: number) => boolean): void {
  const cell = people.c.cell;
  for (let i = people.count - 1; i >= 0; i--) if (!keepCell(cell[i]!)) people.remove(i);
}

export function stepPeople(people: People, dt: number): void {
  // Batch: distance, and the phase with it.
  const { s, speed, phase, length, dir } = people.c;
  const n = people.count, turn = (2 * Math.PI) / WALK.stride;
  for (let i = 0; i < n; i++) {
    const d = speed[i]! * dt;
    s[i]! += d;
    phase[i] = (phase[i]! + d * turn) % (2 * Math.PI);
  }
  // Rows: past the end of their edge, they turn round (the overshoot walked back).
  for (let i = 0; i < n; i++) {
    if (s[i]! < length[i]!) continue;
    s[i] = Math.min(length[i]!, s[i]! - length[i]!);
    dir[i] = -dir[i]!;
  }
}
