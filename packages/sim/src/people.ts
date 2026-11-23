// People: pedestrians on the sidewalks, one row each in a Table.
//
// A person walks the sidewalk of (cell, edge) on a side (1: right of the
// edge's from → to, −1: left), in direction dir (+1 from → to, −1 to → from),
// `s` meters past the node they entered at, `across` m right of the
// sidewalk's middle as they walk (so people keep right, and pass each other).
// Each walks at their own pace, around WALK.speed.
//
// Sidewalks stop short of the junctions at their ends (the net's enter and
// leave). There a person takes a passage through the junction: round the
// corner onto the next sidewalk, or across a road (xcell, xedge, from its
// xside) and onto a sidewalk on the far corner, or, where there is no way on,
// round and back. The net offers the ways on with weights and lengths; the
// person picks one. In a passage (leg PASSAGE), (cell, edge, dir, side) is
// still the sidewalk they came from, s counts along the passage and `end` is
// its length; then they walk on along (ncell, nedge, ndir, nside).
//
// The walk phase (radians; a full turn is two steps, WALK.stride m) advances
// with distance, not time, so feet don't slide at any pace.
//
// The step is a batch pass over the columns (distance and phase for everyone)
// followed by a row pass for the few who reached the end of their leg.

import type { Rng } from "./rng.ts";
import { Table, type Cursor } from "./table.ts";

export const WALK = {
  speed: 1.4,    // m/s, the average pace
  spread: 0.25,  // m/s, either side of it
  stride: 1.5,   // m per walk cycle (two steps)
  keep: 0.4,     // m right of the sidewalk's middle
} as const;

/** The leg a person is on. */
export const SIDEWALK_LEG = 0, PASSAGE = 1;
/** In xcell: the passage crosses no road. */
export const NO_CROSSING = 0xffff;

export const PERSON = {
  cell: Uint16Array,    // the viewer's slot for the cell the edge belongs to
  edge: Uint32Array,
  side: Int8Array,      // 1: right of from → to, −1: left
  dir: Int8Array,
  leg: Uint8Array,      // SIDEWALK_LEG or PASSAGE
  s: Float32Array,      // m: past the entry node on a sidewalk, along a passage
  end: Float32Array,    // m: where the leg ends (the sidewalk's leave, the passage's length)
  speed: Float32Array,  // m/s
  across: Float32Array, // m right of the sidewalk's middle, as they walk
  phase: Float32Array,  // radians, 0 .. 2π
  xcell: Uint16Array,   // in a passage: the road crossed (NO_CROSSING: none), from its side xside
  xedge: Uint32Array,
  xside: Int8Array,
  ncell: Uint16Array,   // in a passage: the sidewalk after it
  nedge: Uint32Array,
  ndir: Int8Array,
  nside: Int8Array,
} as const;
export type People = Table<typeof PERSON>;
export const createPeople = (capacity = 1024): People => new Table(PERSON, capacity);

/** Ways on, as SidewalkNet.onward appends them: weight, length, then the crossing and the sidewalk after. */
export const WAY = 9;

/** The sidewalks the sim walks: edges of the loaded cells, joined at their junctions. */
export interface SidewalkNet {
  /** Where walking (cell, edge) in dir starts and stops, m past its entry node: short of the junctions at either end. */
  enter(cell: number, edge: number, dir: number): number;
  leave(cell: number, edge: number, dir: number): number;
  /**
   * The ways on from the end of a sidewalk, walked `across` m right of its middle: appends WAY numbers each to out
   * (weight, passage length m, xcell, xedge, xside, ncell, nedge, ndir, nside). Always at least one: back the way
   * they came, if nothing else.
   */
  onward(cell: number, edge: number, dir: number, side: number, across: number, out: number[]): void;
}

export interface PersonStart {
  cell: number;
  edge: number;
  side: number;
  dir: number;
  s: number;  // clamped to where the sidewalk can be walked
}

/** Adds a person at their own pace, mid-stride somewhere. Returns their row. */
export function spawnPerson(people: People, net: SidewalkNet, a: PersonStart, rng: Rng): number {
  const i = people.add(), c = people.c;
  const lo = net.enter(a.cell, a.edge, a.dir), hi = net.leave(a.cell, a.edge, a.dir);
  c.cell[i] = a.cell;
  c.edge[i] = a.edge;
  c.side[i] = a.side;
  c.dir[i] = a.dir;
  c.leg[i] = SIDEWALK_LEG;
  c.s[i] = Math.max(lo, Math.min(hi, a.s));
  c.end[i] = hi;
  c.speed[i] = WALK.speed + WALK.spread * (2 * rng.next() - 1);
  c.across[i] = WALK.keep;
  c.phase[i] = 2 * Math.PI * rng.next();
  return i;
}

/** Removes everyone on, crossing or heading for a cell that fails the test (cells left behind). */
export function removePeople(people: People, keepCell: (cell: number) => boolean): void {
  const { cell, leg, xcell, ncell } = people.c;
  for (let i = people.count - 1; i >= 0; i--) {
    const passing = leg[i] === PASSAGE;
    const keep = keepCell(cell[i]!) && (!passing || (keepCell(ncell[i]!) && (xcell[i] === NO_CROSSING || keepCell(xcell[i]!))));
    if (!keep) people.remove(i);
  }
}

const ways: number[] = [];

export function stepPeople(people: People, net: SidewalkNet, dt: number, rng: Rng): void {
  // Batch: distance, and the phase with it.
  const { s, end, speed, phase } = people.c;
  const n = people.count, turn = (2 * Math.PI) / WALK.stride;
  for (let i = 0; i < n; i++) {
    const d = speed[i]! * dt;
    s[i]! += d;
    phase[i] = (phase[i]! + d * turn) % (2 * Math.PI);
  }
  // Rows: at the end of a sidewalk, into a passage; at the end of a passage, onto the next sidewalk.
  const p = people.cursor();
  for (let i = 0; i < n; i++) {
    if (s[i]! < end[i]!) continue;
    p.i = i;
    while (p.s >= p.end) {
      const over = p.s - p.end;
      if (p.leg === SIDEWALK_LEG) {
        pickWay(p, net, rng);
        p.leg = PASSAGE;
        p.s = over;
      } else {
        [p.cell, p.edge, p.dir, p.side] = [p.ncell, p.nedge, p.ndir, p.nside];
        p.leg = SIDEWALK_LEG;
        p.s = net.enter(p.cell, p.edge, p.dir) + over;
        p.end = net.leave(p.cell, p.edge, p.dir);
      }
    }
  }
}

/** Picks a way on from the end of p's sidewalk, by weight: the passage's crossing, the sidewalk after it, its length. */
function pickWay(p: Cursor<typeof PERSON>, net: SidewalkNet, rng: Rng): void {
  ways.length = 0;
  net.onward(p.cell, p.edge, p.dir, p.side, p.across, ways);
  let total = 0;
  for (let k = 0; k < ways.length; k += WAY) total += ways[k]!;
  let r = rng.next() * total, k = 0;
  while (k + WAY < ways.length && (r -= ways[k]!) >= 0) k += WAY;
  // A passage is never empty, so a step always moves someone on.
  p.end = Math.max(0.01, ways[k + 1]!);
  [p.xcell, p.xedge, p.xside] = [ways[k + 2]!, ways[k + 3]!, ways[k + 4]!];
  [p.ncell, p.nedge, p.ndir, p.nside] = [ways[k + 5]!, ways[k + 6]!, ways[k + 7]!, ways[k + 8]!];
}
