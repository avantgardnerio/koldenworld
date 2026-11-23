// Vagrants: people with nowhere to live, one row each in a Table. They keep
// to no sidewalk, road or rule: anywhere in the open within ROAM.leash m of
// the place they're near (their anchor, a shelter or soup kitchen), and only
// walls stop them.
//
// Each is doing one thing (STATE) for a while, then picks another: running
// in fits (fast, swerving), shouting (arms up, at a jog), staggering (slow,
// lurching), standing, sitting, or lying down (wherever they are, roads
// included; a long time, now and then for good). Picks are weighted so that
// over a while each takes its ROAM.share of their time: half running or
// shouting, half sleeping, staggering or sitting. Moving, their heading
// drifts at a turn rate that changes at random; past the leash they head back
// toward their anchor; a wall in the way turns them round.
//
// The walk phase advances with distance (ROAM.stride m per cycle, by what
// they're doing), so feet don't slide.
//
// The step is a batch pass over the columns (timers for everyone) followed by
// a row pass for those moving (walls are a per-row question) or whose time is
// up.

import type { Rng } from "./rng.ts";
import { Table, type Cursor } from "./table.ts";

export const STATE = { stand: 0, stagger: 1, run: 2, sit: 3, lie: 4, shout: 5 } as const;

/** By STATE: standing, staggering, running, sitting, lying, shouting (arms up, at a jog). */
export const ROAM = {
  /** m/s (none: still). */
  speed: [undefined, [0.4, 0.9], [2.8, 4.8], undefined, undefined, [1.2, 2.5]],
  /** s doing each. */
  time: [[1, 4], [5, 20], [2, 8], [20, 120], [60, 600], [3, 10]],
  /** The share of their time each takes, over a while: half running or shouting, half sleeping, staggering or sitting. */
  share: [0.03, 0.22, 0.3, 0.05, 0.2, 0.2],
  /** Lying down: how often it's for good (an hour). */
  forGood: 0.1,
  /** rad/s: the most the heading turns; and how often (per s) the turn rate changes. */
  turn: [0, 2.5, 3, 0, 0, 2],
  swerve: [0, 3, 1.5, 0, 0, 1.5],
  /** m per walk cycle (two steps). */
  stride: [1.5, 1.1, 2.4, 1.5, 1.5, 2],
  leash: 200,            // m from their anchor
} as const;

export const VAGRANT = {
  cell: Uint16Array,     // the viewer's slot for the cell they belong to (their coordinates are in its frame)
  x: Float32Array,
  y: Float32Array,
  heading: Float32Array, // radians counterclockwise from x
  turn: Float32Array,    // rad/s
  speed: Float32Array,   // m/s (0 unless walking or running)
  state: Uint8Array,     // STATE
  timer: Float32Array,   // s left at it
  ax: Float32Array,      // their anchor
  ay: Float32Array,
  phase: Float32Array,   // radians, 0 .. 2π
} as const;
export type Vagrants = Table<typeof VAGRANT>;
export const createVagrants = (capacity = 256): Vagrants => new Table(VAGRANT, capacity);

/** What stops them: whether a wall of a cell crosses the segment (x0, y0)–(x1, y1), in that cell's frame. */
export interface RoamWorld {
  blocked(cell: number, x0: number, y0: number, x1: number, y1: number): boolean;
}

/**
 * Adds a vagrant at (x, y), anchored at (ax, ay), part-way through something: each thing as likely as the share of
 * time it takes, so a crowd starts as it would look any time later. Returns their row.
 */
export function spawnVagrant(v: Vagrants, cell: number, x: number, y: number, ax: number, ay: number, rng: Rng): number {
  const i = v.add(), c = v.c;
  [c.cell[i], c.x[i], c.y[i], c.ax[i], c.ay[i]] = [cell, x, y, ax, ay];
  c.heading[i] = 2 * Math.PI * rng.next();
  c.phase[i] = 2 * Math.PI * rng.next();
  start(v.cursor(i), pick(rng, ROAM.share), rng);
  v.c.timer[i]! *= rng.next();
  return i;
}

/** Removes every vagrant whose cell fails the test. */
export function removeVagrants(v: Vagrants, keepCell: (cell: number) => boolean): void {
  for (let i = v.count - 1; i >= 0; i--) if (!keepCell(v.c.cell[i]!)) v.remove(i);
}

export function stepVagrants(v: Vagrants, world: RoamWorld, dt: number, rng: Rng): void {
  // Batch: everyone's time at what they're doing.
  const { timer, speed } = v.c, n = v.count;
  for (let i = 0; i < n; i++) timer[i]! -= dt;
  // Rows: the moving move; those whose time is up pick something else.
  const p = v.cursor();
  for (let i = 0; i < n; i++) {
    p.i = i;
    if (speed[i]! > 0) move(p, world, dt, rng);
    if (timer[i]! <= 0) start(p, pick(rng), rng);
  }
}

function move(p: Cursor<typeof VAGRANT>, world: RoamWorld, dt: number, rng: Rng): void {
  // A swerve now and then: a new turn rate.
  if (rng.next() < ROAM.swerve[p.state]! * dt) p.turn = (2 * rng.next() - 1) * ROAM.turn[p.state]!;
  p.heading += p.turn * dt;
  // Past the leash: back toward the anchor, give or take.
  const dx = p.ax - p.x, dy = p.ay - p.y;
  if (dx * dx + dy * dy > ROAM.leash * ROAM.leash) p.heading = Math.atan2(dy, dx) + (rng.next() - 0.5);
  const d = p.speed * dt, nx = p.x + Math.cos(p.heading) * d, ny = p.y + Math.sin(p.heading) * d;
  if (world.blocked(p.cell, p.x, p.y, nx, ny)) {
    // A wall: turn round, roughly.
    p.heading += Math.PI + (rng.next() - 0.5) * 1.5;
    return;
  }
  [p.x, p.y] = [nx, ny];
  p.phase = (p.phase + (d * 2 * Math.PI) / ROAM.stride[p.state]!) % (2 * Math.PI);
}

/** Starts doing `state`: for how long, how fast. */
function start(p: Cursor<typeof VAGRANT>, state: number, rng: Rng): void {
  const [t0, t1] = ROAM.time[state]!;
  p.state = state;
  p.timer = t0 + (t1 - t0) * rng.next();
  if (state === STATE.lie && rng.next() < ROAM.forGood) p.timer = 3600;
  const range = ROAM.speed[state];
  p.speed = range ? range[0] + (range[1] - range[0]) * rng.next() : 0;
  p.turn = 0;
}

/**
 * How likely each state is to be picked next: its share of time over how long it lasts on average (lying's average
 * counting the hour-long ones), so the shares come out as ROAM.share.
 */
const WEIGHT = ROAM.time.map(([t0, t1], s) => {
  const mean = (t0 + t1) / 2;
  return ROAM.share[s]! / (s === STATE.lie ? (1 - ROAM.forGood) * mean + ROAM.forGood * 3600 : mean);
});

/** A state, by weight (WEIGHT unless given). */
function pick(rng: Rng, weight: readonly number[] = WEIGHT): number {
  let r = rng.next() * weight.reduce((a, b) => a + b, 0), s = 0;
  while (s + 1 < weight.length && (r -= weight[s]!) >= 0) s++;
  return s;
}
