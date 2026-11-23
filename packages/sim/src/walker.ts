// The player on foot, stepped in a local flat frame (x east, y north, m), as
// the car is. Pure: the world comes in as callbacks (the ground's height,
// the walls near a box: sim's VehicleWorld).
//
// The input is a direction to go in the frame (length up to 1) and whether to
// run or jump. The velocity eases toward that direction at the walking or
// running pace; the heading turns toward where they're going. On the ground
// they stand on it; a jump leaves it, and gravity brings them back.
//
// Walls: they're a circle WALKER.radius across; against each wall segment
// near them they're pushed out to that far from it, and lose their velocity
// into it.
//
// The walk phase advances with distance (a stride per cycle, longer running),
// so feet don't slide; the gait (how far limbs swing) follows the speed.

import type { VehicleWorld } from "./vehicle.ts";

export interface Walker {
  x: number;
  y: number;
  z: number;        // their feet, m
  heading: number;  // radians counterclockwise from east (x)
  vx: number;       // m/s
  vy: number;
  vz: number;       // m/s, up positive
  air: boolean;     // in a jump
  phase: number;    // radians, 0 .. 2π
}

export interface WalkInput {
  dx: number;       // where to go: a direction in the frame, length 0 (stop) to 1
  dy: number;
  run: boolean;
  jump: boolean;
}

export const WALKER = {
  radius: 0.3,       // m
  walk: 1.6,         // m/s
  run: 5.5,
  accel: 12,         // m/s² toward the wanted velocity
  turn: 10,          // rad/s, the heading toward where they're going
  jump: 4.5,         // m/s up
  gravity: 9.81,
  stride: 1.5,       // m per walk cycle (two steps) walking
  runStride: 2.6,    // and running
  runGait: 1.7,      // how far limbs swing running (1: a walk's)
};

/** Someone standing at a point, facing `heading`. */
export function placeWalker(x: number, y: number, heading: number, world: VehicleWorld): Walker {
  return { x, y, z: world.height(x, y), heading, vx: 0, vy: 0, vz: 0, air: false, phase: 0 };
}

export function stepWalker(w: Walker, input: WalkInput, dt: number, world: VehicleWorld): void {
  const C = WALKER;
  // Toward the wanted velocity.
  const pace = input.run ? C.run : C.walk, len = Math.hypot(input.dx, input.dy), k = len > 1 ? 1 / len : 1;
  const [tx, ty] = [input.dx * k * pace, input.dy * k * pace];
  const [ex, ey] = [tx - w.vx, ty - w.vy], el = Math.hypot(ex, ey), step = Math.min(el, C.accel * dt);
  if (el > 0) [w.vx, w.vy] = [w.vx + (ex / el) * step, w.vy + (ey / el) * step];
  const speed = Math.hypot(w.vx, w.vy);
  // The heading follows where they're going (the short way round).
  if (speed > 0.2) {
    const d = Math.atan2(Math.sin(Math.atan2(w.vy, w.vx) - w.heading), Math.cos(Math.atan2(w.vy, w.vx) - w.heading));
    w.heading += Math.sign(d) * Math.min(Math.abs(d), C.turn * dt);
  }
  const [x0, y0] = [w.x, w.y];
  w.x += w.vx * dt;
  w.y += w.vy * dt;
  collide(w, world);
  // The walk, by how far they actually went.
  const moved = Math.hypot(w.x - x0, w.y - y0), running = speed > (C.walk + C.run) / 2;
  if (!w.air) w.phase = (w.phase + (moved * 2 * Math.PI) / (running ? C.runStride : C.stride)) % (2 * Math.PI);
  // Up and down: on the ground, or a jump and back.
  const ground = world.height(w.x, w.y);
  if (!w.air && input.jump) [w.air, w.vz] = [true, C.jump];
  if (w.air) {
    w.vz -= C.gravity * dt;
    w.z += w.vz * dt;
    if (w.z <= ground) [w.z, w.vz, w.air] = [ground, 0, false];
  } else w.z = ground;
}

/** How far their limbs swing (0 standing, 1 walking, WALKER.runGait running), by their speed. */
export function walkerGait(w: Walker): number {
  const C = WALKER, speed = Math.hypot(w.vx, w.vy);
  if (w.air) return 0.3;
  return speed <= C.walk ? speed / C.walk : 1 + (C.runGait - 1) * Math.min(1, (speed - C.walk) / (C.run - C.walk));
}

/** Pushes them out of every wall they're within WALKER.radius of (a few passes), dropping their velocity into it. */
function collide(w: Walker, world: VehicleWorld): void {
  const r = WALKER.radius;
  for (let pass = 0; pass < 3; pass++) {
    let hit = false;
    world.walls(w.x - r, w.y - r, w.x + r, w.y + r, (ax, ay, bx, by) => {
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((w.x - ax) * dx + (w.y - ay) * dy) / l2)) : 0;
      const [px, py] = [w.x - (ax + t * dx), w.y - (ay + t * dy)], d = Math.hypot(px, py);
      if (d >= r || d === 0) return;
      hit = true;
      const [nx, ny] = [px / d, py / d];
      w.x += nx * (r - d);
      w.y += ny * (r - d);
      const into = w.vx * nx + w.vy * ny;
      if (into < 0) [w.vx, w.vy] = [w.vx - into * nx, w.vy - into * ny];
    });
    if (!hit) return;
  }
}
