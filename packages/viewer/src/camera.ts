// Fly camera: a position and an orientation quaternion. Pure functions over a
// plain value; stepCamera(camera, input, dt) is the whole update, so the camera
// is tested in Node like the sim will be.
//
// World: a local frame, x east, y north, z up (m); globe-camera.ts puts this
// camera on the globe. Camera-local: x right, y forward, z up; the
// identity orientation looks north, level. Mouse yaw rotates about world up and
// pitch about the camera's right axis, so roll never accumulates; pitch is
// clamped to straight down / straight up.

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];  // x, y, z, w

export interface Camera {
  pos: Vec3;
  rot: Quat;
}

/** One frame of input, already decoded from devices. */
export interface CameraInput {
  move: Vec3;      // -1..1 along camera right, camera forward, world up
  look: [dx: number, dy: number];  // mouse movement, CSS px (y down)
  fast: boolean;
}

export const FOV_Y = (60 * Math.PI) / 180;
export const NEAR = 0.5;
export const FAR = 200_000;
export const MIN_ALTITUDE = 1;
export const LOOK_RADIANS_PER_PX = 0.0025;
const DEG = Math.PI / 180;
const HALF_PI = Math.PI / 2;

// --- quaternions ---------------------------------------------------------

export function axisAngle(axis: Vec3, angle: number): Quat {
  const s = Math.sin(angle / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
}

export function mul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function normalize(q: Quat): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

export function rotate(q: Quat, v: Vec3): Vec3 {
  // v + 2w(u × v) + 2u × (u × v), with u the vector part of q
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

export const right = (c: Camera) => rotate(c.rot, [1, 0, 0]);
export const forward = (c: Camera) => rotate(c.rot, [0, 1, 0]);
export const up = (c: Camera) => rotate(c.rot, [0, 0, 1]);

// --- yaw / pitch (for the URL and for clamping) ---------------------------

export function fromYawPitch(yaw: number, pitch: number): Quat {
  return normalize(mul(axisAngle([0, 0, 1], yaw), axisAngle([1, 0, 0], pitch)));
}

/** Yaw (counterclockwise from north) and pitch (up positive), radians. */
export function yawPitch(q: Quat): [yaw: number, pitch: number] {
  const r = rotate(q, [1, 0, 0]);  // always horizontal: there is no roll
  const f = rotate(q, [0, 1, 0]);
  // atan2, not asin: asin is ill-conditioned near ±90°, where its float error
  // fed back through the pitch clamp and compounded every frame.
  return [Math.atan2(r[1], r[0]), Math.atan2(f[2], Math.hypot(f[0], f[1]))];
}

// --- update -----------------------------------------------------------------

/** Base speed grows with altitude, so crossing a city from 1 km up is as quick as a street from 10 m. */
export function speed(c: Camera, fast: boolean): number {
  return Math.max(5, c.pos[2]) * (fast ? 4 : 1);
}

export function look(c: Camera, dx: number, dy: number): Camera {
  if (dx === 0 && dy === 0) return c;
  // Rebuilt from yaw and pitch rather than composed incrementally: composing
  // lets float error leak in as roll, which a pitch rotation cannot remove, and
  // the camera slowly tilts off the clamp. Rebuilding makes drift impossible.
  const [yaw, pitch] = yawPitch(c.rot);
  const p = Math.max(-HALF_PI, Math.min(HALF_PI, pitch - dy * LOOK_RADIANS_PER_PX));
  return { pos: c.pos, rot: fromYawPitch(yaw - dx * LOOK_RADIANS_PER_PX, p) };
}

export function stepCamera(c: Camera, input: CameraInput, dt: number): Camera {
  const looked = look(c, input.look[0], input.look[1]);
  const [mx, my, mz] = input.move;
  if (mx === 0 && my === 0 && mz === 0) return looked;
  const d = speed(looked, input.fast) * dt;
  const r = right(looked), f = forward(looked);
  return {
    pos: [
      looked.pos[0] + (r[0] * mx + f[0] * my) * d,
      looked.pos[1] + (r[1] * mx + f[1] * my) * d,
      Math.max(MIN_ALTITUDE, looked.pos[2] + (r[2] * mx + f[2] * my + mz) * d),
    ],
    rot: looked.rot,
  };
}

// --- projection -------------------------------------------------------------

/** World → clip, column-major 4×4. A farther `near` (from high up) keeps depth precise out at the far plane. */
export function viewProjection(c: Camera, aspect: number, near = NEAR): Float32Array {
  const r = right(c), u = up(c), f = forward(c);
  const [px, py, pz] = c.pos;
  // View: eye x = right, eye y = up, eye -z = forward (GL convention).
  const view = [
    r[0], u[0], -f[0], 0,
    r[1], u[1], -f[1], 0,
    r[2], u[2], -f[2], 0,
    -(r[0] * px + r[1] * py + r[2] * pz), -(u[0] * px + u[1] * py + u[2] * pz), f[0] * px + f[1] * py + f[2] * pz, 1,
  ];
  const t = 1 / Math.tan(FOV_Y / 2);
  const proj = [
    t / aspect, 0, 0, 0,
    0, t, 0, 0,
    0, 0, (FAR + near) / (near - FAR), -1,
    0, 0, (2 * FAR * near) / (near - FAR), 0,
  ];
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += proj[k * 4 + row]! * view[col * 4 + k]!;
      out[col * 4 + row] = s;
    }
  }
  return out;
}
