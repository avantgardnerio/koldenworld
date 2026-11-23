// Traffic (decision 28): cars on the road graph, one row each in a Table.
//
// A car is on (cell, edge) travelling in direction dir (+1 from → to, −1
// to → from), in a lane counted from the left of its direction (0 is next to
// the center line), `s` meters past the node it entered at. Cars drive
// through each other for now: no following, no right of way.
//
// Speed comes from the road, not the driver: the speed limit in the rightmost
// lane, 10 mph faster for each lane to its left, as people actually drive.
// Cars accelerate and brake toward that at fixed rates, never above their cap:
// what something ahead of them (the player's car) allows, set from outside
// each step (Infinity: nothing ahead).
//
// A car knows the road it came from and the one it takes next (decision 30):
// the way onward is picked when it enters a road, so the renderer can draw it
// turning through the junction ahead, and still finish the turn it began at
// the last one. Picking: no U-turns unless it's a dead end; the lane keeps its
// place counted from the right, spreading over lanes the new road adds.
//
// The step is a batch pass over the columns (speed and distance for every
// car) followed by a row pass with a cursor for the few cars that reached the
// end of their road: move on to the road picked, or leave the simulation if
// there was none.

import type { Rng } from "./rng.ts";
import { Table } from "./table.ts";

export const MPH = 0.44704;               // m/s
export const LANE_BONUS = 10 * MPH;       // per lane left of the rightmost
export const ACCELERATION = 2.5;          // m/s²
export const BRAKING = 4;                 // m/s²

/** In pcell / ncell: no road before (a car that started here) or after (it leaves at the end). */
export const NONE = 0xffff;

export const CAR = {
  model: Uint8Array,
  cell: Uint16Array,    // the viewer's slot for the cell the car's edge belongs to
  edge: Uint32Array,
  dir: Int8Array,
  lane: Uint8Array,     // from the left of its direction
  s: Float32Array,      // m past the entry node
  speed: Float32Array,  // m/s
  length: Float32Array, // m, the current edge's (copied on entry, so the batch pass needs no lookups)
  target: Float32Array, // m/s, the current lane's
  cap: Float32Array,    // m/s, what's ahead allows (Infinity: nothing); set from outside
  pcell: Uint16Array,   // the road it came from (NONE: none)
  pedge: Uint32Array,
  pdir: Int8Array,
  plane: Uint8Array,
  ncell: Uint16Array,   // the road it takes next (NONE: none)
  nedge: Uint32Array,
  ndir: Int8Array,
  nlane: Uint8Array,
} as const;
export type Cars = Table<typeof CAR>;
export const createCars = (capacity = 1024): Cars => new Table(CAR, capacity);

/** The road network the sim drives on: edges of the loaded cells, joined at shared OSM nodes. */
export interface RoadNet {
  length(cell: number, edge: number): number;
  speedLimit(cell: number, edge: number): number;   // m/s
  lanes(cell: number, edge: number, dir: number): number;
  /** Ways onward from the end of (cell, edge) travelled in dir: appends (cell, edge, dir) triples to out. */
  exits(cell: number, edge: number, dir: number, out: number[]): void;
}

/** Target speed in a lane: the limit on the right, +10 mph per lane further left. */
export const laneSpeed = (limit: number, lanes: number, lane: number) => limit + LANE_BONUS * (lanes - 1 - lane);

/**
 * The lane on the next road: the same place counted from the right (the
 * left lanes merge where lanes end), or one of the lanes the new road adds
 * on the left.
 */
export function nextLane(lane: number, lanes: number, nextLanes: number, rng: Rng): number {
  const fromRight = lanes - 1 - lane + rng.int(Math.max(0, nextLanes - lanes) + 1);
  return Math.max(0, nextLanes - 1 - fromRight);
}

export interface CarStart {
  model: number;
  cell: number;
  edge: number;
  dir: number;
  lane: number;
  s: number;
}

/** Adds a car at rest, with its way onward picked. Returns its row. */
export function spawnCar(cars: Cars, net: RoadNet, a: CarStart, rng: Rng): number {
  const i = cars.add();
  const c = cars.c, lanes = net.lanes(a.cell, a.edge, a.dir);
  c.model[i] = a.model;
  c.cell[i] = a.cell;
  c.edge[i] = a.edge;
  c.dir[i] = a.dir;
  c.lane[i] = Math.min(a.lane, lanes - 1);
  c.s[i] = a.s;
  c.length[i] = net.length(a.cell, a.edge);
  c.target[i] = laneSpeed(net.speedLimit(a.cell, a.edge), lanes, c.lane[i]!);
  c.cap[i] = Infinity;
  c.pcell[i] = NONE;
  planNext(cars, net, i, rng);
  return i;
}

/** Removes every car whose cell fails the test (cells left behind). */
export function removeCars(cars: Cars, keepCell: (cell: number) => boolean): void {
  const cell = cars.c.cell;
  for (let i = cars.count - 1; i >= 0; i--) if (!keepCell(cell[i]!)) cars.remove(i);
}

const exits: number[] = [];

/** Picks car i's way onward from the end of its road (ncell NONE if there is none). */
function planNext(cars: Cars, net: RoadNet, i: number, rng: Rng): void {
  const c = cars.c, cell = c.cell[i]!, edge = c.edge[i]!, dir = c.dir[i]!;
  exits.length = 0;
  net.exits(cell, edge, dir, exits);
  // Onward, not back the way it came, unless that is the only way.
  let options = 0;
  for (let k = 0; k < exits.length; k += 3) {
    const uTurn = exits[k] === cell && exits[k + 1] === edge && exits[k + 2] === -dir;
    if (!uTurn) exits[3 * options] = exits[k]!, exits[3 * options + 1] = exits[k + 1]!, exits[3 * options++ + 2] = exits[k + 2]!;
  }
  if (options === 0 && exits.length === 0) {
    c.ncell[i] = NONE;
    return;
  }
  const k = 3 * (options > 0 ? rng.int(options) : 0);
  c.ncell[i] = exits[k]!;
  c.nedge[i] = exits[k + 1]!;
  c.ndir[i] = exits[k + 2]!;
  c.nlane[i] = nextLane(c.lane[i]!, net.lanes(cell, edge, dir), net.lanes(exits[k]!, exits[k + 1]!, exits[k + 2]!), rng);
}

export function stepTraffic(cars: Cars, net: RoadNet, dt: number, rng: Rng): void {
  // Batch: speed toward the lane's target, then distance. Every car, no branching on state.
  const { speed, target, cap, s, length } = cars.c;
  const n = cars.count, up = ACCELERATION * dt, down = -BRAKING * dt;
  for (let i = 0; i < n; i++) {
    const v = speed[i]!;
    const nv = Math.max(0, v + Math.min(up, Math.max(down, Math.min(target[i]!, cap[i]!) - v)));
    speed[i] = nv;
    s[i]! += nv * dt;
  }

  // Rows: cars past the end of their edge move on (possibly across several short edges in one step).
  // Downward, so a removal moves an already-handled row into the current slot.
  const car = cars.cursor();
  for (let i = n - 1; i >= 0; i--) {
    if (s[i]! < length[i]!) continue;
    car.i = i;
    while (car.s >= car.length) {
      if (car.ncell === NONE) {
        cars.remove(i);
        break;
      }
      car.s -= car.length;
      car.pcell = car.cell;
      car.pedge = car.edge;
      car.pdir = car.dir;
      car.plane = car.lane;
      car.cell = car.ncell;
      car.edge = car.nedge;
      car.dir = car.ndir;
      car.lane = car.nlane;
      const lanes = net.lanes(car.cell, car.edge, car.dir);
      car.length = net.length(car.cell, car.edge);
      car.target = laneSpeed(net.speedLimit(car.cell, car.edge), lanes, car.lane);
      planNext(cars, net, i, rng);
    }
  }
}
