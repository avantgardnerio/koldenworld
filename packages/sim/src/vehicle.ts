// A drivable car (arcade handling), stepped in a local flat frame (x east,
// y north, m). Pure: the world comes in as callbacks, the ground's height and
// the wall segments near a box, so the sim knows nothing of cells or frames.
//
// Handling: the velocity lives in the frame; each step splits it into the
// car's forward and sideways parts. Throttle, brake, drag, engine braking and
// the slope act on the forward part (brake, then reverse only once stopped
// for REVERSE_DELAY with the brake still held); grip damps the sideways part (less with the handbrake
// on, so the car slides). The heading turns at speed × tan(steer) / wheelbase
// (a bicycle model); steering is rate-limited, and limited more at speed.
//
// The ground: the car sits on the heights under its four wheels (height,
// pitch, roll). Walls: the car is a rectangle; against each wall segment
// near it, the separating axis test finds the shallowest way out; the car is
// pushed out along it, its velocity into the wall bounced back a little and
// along the wall scrubbed.

/** One car's state, in the local frame. */
export interface Vehicle {
  x: number;
  y: number;
  z: number;          // the ground under it, m
  heading: number;    // radians, counterclockwise from east (x)
  vx: number;         // m/s
  vy: number;
  steer: number;      // the front wheels' angle, radians (left positive)
  pitch: number;      // radians, nose up positive
  roll: number;       // radians, right side up positive
  stopped: number;    // s it has been stopped with the brake held (reverse after REVERSE_DELAY)
}

export interface DriveInput {
  throttle: number;   // −1 (brake, then reverse) .. 1
  steer: number;      // −1 (left) .. 1 (right)
  handbrake: boolean;
}

export interface VehicleWorld {
  /** The ground's height at a point, m. */
  height(x: number, y: number): number;
  /** Every wall segment (a building's edge) that may touch a box (x0, y0)–(x1, y1). */
  walls(x0: number, y0: number, x1: number, y1: number, visit: (ax: number, ay: number, bx: number, by: number) => void): void;
}

export const VEHICLE = {
  halfLength: 2.3, halfWidth: 0.95, wheelbase: 2.7, track: 1.6,
  accel: 5, brake: 12, reverseMax: 7, maxSpeed: 50,   // m/s², m/s
  drag: 0.0012, engineBrake: 1.8, coastDrag: 0.3,      // 1/m (air, ∝ v²); m/s² off the throttle: from 10 m/s up, and on top
  reverseDelay: 0.3,                                   // s stopped, brake held, before backing up
  maxSteer: 0.55, steerRate: 2.2, steerFalloff: 18,    // rad, rad/s, m/s: steering halves at this speed
  grip: 9, slideGrip: 1.2,                             // 1/s: how fast sideways speed dies
  bounce: 0.15, scrub: 0.25,                           // hitting a wall: velocity into it kept, reversed; along it lost
  gravity: 9.81,
};
const MAX_STEP = 1 / 120;

/** A car at rest at a point, facing `heading`. */
export function placeVehicle(x: number, y: number, heading: number, world: VehicleWorld): Vehicle {
  const v: Vehicle = { x, y, z: 0, heading, vx: 0, vy: 0, steer: 0, pitch: 0, roll: 0, stopped: 0 };
  settle(v, world);
  return v;
}

/** Advances a car by dt seconds (in substeps of at most MAX_STEP). */
export function stepVehicle(v: Vehicle, input: DriveInput, dt: number, world: VehicleWorld): void {
  const n = Math.max(1, Math.ceil(dt / MAX_STEP));
  for (let k = 0; k < n; k++) substep(v, input, dt / n, world);
}

/** Forward speed, m/s (negative in reverse). */
export const forwardSpeed = (v: Vehicle) => v.vx * Math.cos(v.heading) + v.vy * Math.sin(v.heading);

function substep(v: Vehicle, input: DriveInput, dt: number, world: VehicleWorld): void {
  const C = VEHICLE;
  const [fx, fy] = [Math.cos(v.heading), Math.sin(v.heading)];
  let forward = v.vx * fx + v.vy * fy;
  let side = -v.vx * fy + v.vy * fx;

  // Forward: throttle, or brake (down to a stop, then reverse once stopped a moment); drag, engine braking, the slope.
  const t = Math.max(-1, Math.min(1, input.throttle));
  const toward = (target: number, rate: number) => {
    forward += Math.sign(target - forward) * Math.min(Math.abs(target - forward), rate * dt);
  };
  if (t < 0 && forward > 0.05) {
    toward(0, C.brake * -t);
    v.stopped = 0;
  } else if (t < 0) {
    v.stopped += dt;
    if (v.stopped >= C.reverseDelay) forward -= C.accel * -t * dt;
    else toward(0, C.brake);
  } else if (t > 0 && forward < -0.05) {
    toward(0, C.brake * t);  // throttle while backing up: brake first
  } else {
    v.stopped = 0;
    forward += C.accel * t * dt;
  }
  forward -= C.drag * forward * Math.abs(forward) * dt;
  // Off the throttle: engine braking fades toward walking pace, so a car still rolls down a hill.
  if (t === 0) toward(0, C.coastDrag + C.engineBrake * Math.min(1, Math.abs(forward) / 10));
  forward -= C.gravity * Math.sin(v.pitch) * dt;
  forward = Math.max(-C.reverseMax, Math.min(C.maxSpeed, forward));
  if (input.handbrake) forward -= Math.sign(forward) * Math.min(Math.abs(forward), C.brake * 0.5 * dt);

  // Sideways: grip pulls it toward nothing.
  side *= Math.exp(-(input.handbrake ? C.slideGrip : C.grip) * dt);

  // Steering: toward the input, less at speed, at a limited rate; the heading follows.
  const target = -Math.max(-1, Math.min(1, input.steer)) * C.maxSteer / (1 + Math.abs(forward) / C.steerFalloff);
  const ds = target - v.steer;
  v.steer += Math.sign(ds) * Math.min(Math.abs(ds), C.steerRate * dt);
  v.heading += (forward * Math.tan(v.steer) / C.wheelbase) * dt;

  v.vx = forward * fx - side * fy;
  v.vy = forward * fy + side * fx;
  v.x += v.vx * dt;
  v.y += v.vy * dt;
  collide(v, world);
  settle(v, world);
}

/** Sits the car on the ground under its four wheels. */
function settle(v: Vehicle, world: VehicleWorld): void {
  const [fx, fy] = [Math.cos(v.heading), Math.sin(v.heading)];
  const [hl, ht] = [VEHICLE.wheelbase / 2, VEHICLE.track / 2];
  const front = world.height(v.x + fx * hl, v.y + fy * hl), back = world.height(v.x - fx * hl, v.y - fy * hl);
  const left = world.height(v.x - fy * ht, v.y + fx * ht), right = world.height(v.x + fy * ht, v.y - fx * ht);
  v.z = (front + back + left + right) / 4;
  v.pitch = Math.atan2(front - back, VEHICLE.wheelbase);
  v.roll = Math.atan2(left - right, VEHICLE.track);
}

/** Pushes the car out of every wall it overlaps (a few passes), bouncing and scrubbing its velocity. */
function collide(v: Vehicle, world: VehicleWorld): void {
  const C = VEHICLE;
  const reach = C.halfLength + 0.5;
  for (let pass = 0; pass < 3; pass++) {
    let hit = false;
    world.walls(v.x - reach, v.y - reach, v.x + reach, v.y + reach, (ax, ay, bx, by) => {
      const mtv = rectangleSegment(v.x, v.y, v.heading, C.halfLength, C.halfWidth, ax, ay, bx, by);
      if (!mtv) return;
      hit = true;
      const [nx, ny, depth] = mtv;
      v.x += nx * depth;
      v.y += ny * depth;
      const into = v.vx * nx + v.vy * ny;
      if (into < 0) {
        // Along the wall, scrubbed; into it, reversed and mostly lost.
        const [tx, ty] = [v.vx - into * nx, v.vy - into * ny];
        v.vx = tx * (1 - C.scrub) - into * C.bounce * nx;
        v.vy = ty * (1 - C.scrub) - into * C.bounce * ny;
      }
    });
    if (!hit) return;
  }
}

/**
 * The separating axis test, a rectangle (center, heading, half sizes) against a segment: undefined when they don't
 * overlap, else the shallowest way out for the rectangle, [unit x, unit y, depth].
 */
export function rectangleSegment(
  cx: number, cy: number, heading: number, hl: number, hw: number, ax: number, ay: number, bx: number, by: number,
): [number, number, number] | undefined {
  const [fx, fy] = [Math.cos(heading), Math.sin(heading)];
  const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
  if (len === 0) return undefined;
  const axes: [number, number][] = [[fx, fy], [-fy, fx], [-dy / len, dx / len]];
  let best: [number, number, number] | undefined;
  for (const [nx, ny] of axes) {
    // The rectangle's interval along the axis, and the segment's.
    const c = cx * nx + cy * ny, r = hl * Math.abs(fx * nx + fy * ny) + hw * Math.abs(-fy * nx + fx * ny);
    const [p, q] = [ax * nx + ay * ny, bx * nx + by * ny];
    const [s0, s1] = [Math.min(p, q), Math.max(p, q)];
    const overlap = Math.min(c + r - s0, s1 - (c - r));
    if (overlap <= 0) return undefined;
    if (!best || overlap < best[2]) {
      // Out the way the rectangle's center lies from the segment's.
      const side = c >= (s0 + s1) / 2 ? 1 : -1;
      best = [nx * side, ny * side, overlap];
    }
  }
  return best;
}
