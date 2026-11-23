// On foot (F): the player as a person (sim's walker) on the loaded world,
// stepped in a LocalWorld (anchored where they started; re-anchored once
// they're far from it). Getting out of the car leaves it parked beside them:
// solid (its rectangle is four more walls), drawn where it stands, and theirs
// to get back into (F) within ENTER m of it.
//
// Controls, relative to the camera: W/S forward and back, A/D left and right,
// Shift to run, Space to jump; the mouse turns the camera (a third-person
// view behind and above them, looking where they look), and so the way
// forward. Walls: the fine cells' buildings, the parked car, and the traffic
// cars near them (setObstacles).
//
// They carry an inventory (sim's): the number keys pick what's in their hand.
// A gun is carried pointing at the ground: a pistol at the side (the right
// arm locked straight down: no swing, walking or running), a slung rifle in
// patrol ready (both hands on it in front of the chest, muzzle at the ground a
// foot in front of the left foot); only while the
// right mouse button is held is it aimed (the right arm straight out along
// the camera's line, facing where it looks, at a walk), and only then does
// the left fire. A shot goes from the camera through the crosshair (the
// middle of the screen): the first thing it hits (raycast) is where it stops;
// onShot hears of it (the muzzle and that point, in ECEF).

import { createInventory, fire, held, heldGun, placeWalker, reload, select, stepInventory, stepWalker, walkerGait, type Inventory, type ItemKind, type Walker } from "@game/sim";
import { geodeticToEcef, MUZZLE, SHOULDER, type Frame, type Vec3 } from "@game/world";
import { fromYawPitch, LOOK_RADIANS_PER_PX, type CameraInput } from "./camera.ts";
import type { Parked } from "./drive.ts";
import type { GlobeCamera } from "./globe-camera.ts";
import { CAR_TOP, LocalWorld, rectangle, type LoadedWorld } from "./local-world.ts";
import { POSE, type PersonInstances } from "./person-layer.ts";

/** The camera: this far behind (m, along where it looks) and up from their feet to where it looks, never under the ground. */
const VIEW = { back: 3.8, eye: 2.3, clearance: 0.5, pitch: [-1.2, 0.5] as const, start: -0.2 };
/** Getting out: how far from the car's middle, to its left (the driver's side), m. */
const DOOR = 1.7;
/** Getting back in: within this far of the car's middle, m. */
export const ENTER = 3.5;
/** After a shot, the arm holds the angle it was fired at this long (s), before following the camera again. */
const SHOT_HOLD = 0.3;

export class OnFoot {
  readonly walker: Walker;
  readonly local: LocalWorld;
  /** The car they got out of, parked: where (to drive it again), and in this frame (to draw it, and bump into it). */
  readonly car?: Parked;
  private carAt?: { x: number; y: number; heading: number };
  private half: readonly [number, number];
  private yaw: number;    // the camera's heading, radians counterclockwise from east
  private pitch = VIEW.start;
  private w: LoadedWorld;
  readonly inventory: Inventory = createInventory();
  /** Hears of each shot: the muzzle and where it stopped (ECEF), whether it hit something, and the gun. */
  onShot?: (muzzle: Vec3, end: Vec3, hit: boolean, gun: ItemKind) => void;
  private sinceShot = Infinity;  // s
  private aimPitch = 0;          // radians: the right arm's, aiming

  /**
   * Standing at a point facing `heading` (radians counterclockwise from east); or, out of a parked car (`car`, its
   * rectangle `half` long and wide), at its driver's door.
   */
  constructor(lat: number, lon: number, heading: number, w: LoadedWorld, car?: Parked, half: readonly [number, number] = [0, 0]) {
    this.w = w;
    this.local = new LocalWorld(lat, lon, w);
    this.half = half;
    let [x, y] = [0, 0];
    if (car) {
      // The anchor is where the car stands, so it's at the origin facing its own heading.
      this.car = car;
      this.carAt = { x: 0, y: 0, heading: car.heading };
      [x, y] = [-Math.sin(car.heading) * DOOR, Math.cos(car.heading) * DOOR];
      heading = car.heading + Math.PI / 2;  // stepping out, away from the car
    }
    this.walker = placeWalker(x, y, heading, this.local);
    this.yaw = car ? car.heading : heading;
    this.setObstacles(new Float64Array(0), 0, this.local.anchorFrame, [0, 0]);
  }

  step(input: CameraInput, dt: number): void {
    this.yaw -= input.look[0] * LOOK_RADIANS_PER_PX;
    this.pitch = Math.max(VIEW.pitch[0], Math.min(VIEW.pitch[1], this.pitch - input.look[1] * LOOK_RADIANS_PER_PX));
    stepInventory(this.inventory, dt);
    this.sinceShot += dt;
    this.aimHeld = !!input.aim;
    const aiming = this.aiming;
    // The trigger works only aimed: otherwise the gun stays pointed at the ground.
    if (aiming) for (let k = 0; k < (input.fire ?? 0); k++) if (fire(this.inventory)) this.shoot();
    if (aiming && this.sinceShot >= SHOT_HOLD) this.aimPitch = this.pitch;
    // Forward is where the camera looks, level; right is to its right.
    const [fx, fy] = [Math.cos(this.yaw), Math.sin(this.yaw)], [rx, ry] = [fy, -fx];
    const [m0, m1] = [input.move[0], input.move[1]];
    const run = input.fast && !aiming;
    stepWalker(this.walker, { dx: fx * m1 + rx * m0, dy: fy * m1 + ry * m0, run, jump: input.move[2] > 0 }, dt, this.local);
    // Aiming, they face where the camera looks, whichever way they're going.
    if (aiming) this.walker.heading = this.yaw;
    const r = this.local.reanchor(this.walker.x, this.walker.y);
    if (r) {
      const w = this.walker;
      [w.x, w.y] = r.point(w.x, w.y);
      [w.vx, w.vy] = r.vector(w.vx, w.vy);
      [w.heading, this.yaw] = [r.heading(w.heading), r.heading(this.yaw)];
      if (this.carAt) {
        [this.carAt.x, this.carAt.y] = r.point(this.carAt.x, this.carAt.y);
        this.carAt.heading = r.heading(this.carAt.heading);
      }
    }
  }

  /** The traffic cars near them (as TrafficView.yieldTo writes them, in `view`) become walls, as does the parked car. */
  setObstacles(near: Float64Array, n: number, view: Frame, half: readonly [number, number]): void {
    const extra: number[] = [];
    const c = this.carAt;
    if (c) rectangle(c.x, c.y, Math.cos(c.heading), Math.sin(c.heading), this.half, this.local.height(c.x, c.y) + CAR_TOP, extra);
    this.local.setObstacles(near, n, view, half, extra);
  }

  /** What's in their hand. */
  get holding(): ItemKind {
    return held(this.inventory);
  }

  /** Takes inventory slot i in hand. */
  select(i: number): void {
    select(this.inventory, i);
  }

  /** Reloads the gun in hand. */
  reload(): void {
    reload(this.inventory);
  }

  /** Whether the arm is up: a gun in hand and the aim button held. */
  get aiming(): boolean {
    return !!heldGun(this.inventory) && this.aimHeld;
  }
  private aimHeld = false;  // the aim button, as of the last step

  /**
   * A shot: from the camera along where it looks (through the crosshair), starting at them, to the first thing it
   * hits or as far as the gun carries; from the muzzle, the arm pointed at where it stopped.
   */
  private shoot(): void {
    const w = this.walker, gun = heldGun(this.inventory)!, cp = Math.cos(this.pitch);
    const d: Vec3 = [Math.cos(this.yaw) * cp, Math.sin(this.yaw) * cp, Math.sin(this.pitch)];
    // The camera, as camera() places it (without its ground clearance), and the ray from beside them.
    const eye: Vec3 = [w.x - d[0] * VIEW.back, w.y - d[1] * VIEW.back, w.z + VIEW.eye - Math.sin(this.pitch) * VIEW.back];
    const from: Vec3 = [eye[0] + d[0] * VIEW.back, eye[1] + d[1] * VIEW.back, eye[2] + d[2] * VIEW.back];
    const { t, hit } = this.local.raycast(from, d, gun.range);
    const end: Vec3 = [from[0] + d[0] * t, from[1] + d[1] * t, from[2] + d[2] * t];
    // Facing where the camera looks; the right shoulder, and the arm from it toward where the shot stopped.
    w.heading = this.yaw;
    const [fx, fy] = [Math.cos(this.yaw), Math.sin(this.yaw)];
    const s: Vec3 = [w.x + fy * MUZZLE.x, w.y - fx * MUZZLE.x, w.z + SHOULDER];
    this.aimPitch = Math.atan2(end[2] - s[2], Math.hypot(end[0] - s[0], end[1] - s[1]));
    const arm = SHOULDER - (this.holding === "rifle" ? MUZZLE.rifleZ : MUZZLE.z), ca = Math.cos(this.aimPitch);
    const muzzle: Vec3 = [s[0] + fx * arm * ca, s[1] + fy * arm * ca, s[2] + arm * Math.sin(this.aimPitch)];
    this.sinceShot = 0;
    const ecef = (p: Vec3) => geodeticToEcef({ ...this.local.geodetic(p[0], p[1]), h: p[2] });
    this.onShot?.(ecef(muzzle), ecef(end), hit, this.holding);
  }

  /** Close enough to the parked car to get in. */
  get nearCar(): boolean {
    return !!this.carAt && Math.hypot(this.walker.x - this.carAt.x, this.walker.y - this.carAt.y) < ENTER;
  }

  /** The camera: behind and above them, looking where it looks; never under the ground. */
  camera(): GlobeCamera {
    const w = this.walker, c = Math.cos(this.pitch);
    const [x, y] = [w.x - Math.cos(this.yaw) * c * VIEW.back, w.y - Math.sin(this.yaw) * c * VIEW.back];
    const { lat, lon } = this.local.geodetic(x, y);
    const h = Math.max(w.z + VIEW.eye - Math.sin(this.pitch) * VIEW.back, this.w.groundAt(lat, lon) + VIEW.clearance);
    return { lat, lon, h, rot: fromYawPitch(this.yaw - Math.PI / 2, this.pitch) };
  }

  /** Where they stand and face, in a view frame. */
  pose(view: Frame): { pos: Vec3; fwd: Vec3 } {
    const w = this.walker;
    return this.local.pose(view, w.x, w.y, w.z, w.heading);
  }

  /** The parked car's position and forward direction in a view frame, if there is one. */
  carPose(view: Frame): { pos: Vec3; fwd: Vec3 } | undefined {
    const c = this.carAt;
    return c && this.local.pose(view, c.x, c.y, this.local.height(c.x, c.y), c.heading);
  }

  /** Writes them, walking (and aiming, if they are), into `out` (one instance), in a view frame. */
  instance(view: Frame, out: PersonInstances): void {
    const { pos, fwd } = this.pose(view), w = this.walker;
    // A gun not aimed: a pistol carried at the side, a rifle in patrol ready; aimed, raised.
    const rifle = this.holding === "rifle";
    const pose = this.aiming ? (rifle ? POSE.aimRifle : POSE.aim) : rifle ? POSE.patrol : heldGun(this.inventory) ? POSE.carry : POSE.upright;
    out.data.set([...pos, ...fwd, w.phase, walkerGait(w), pose, this.aimPitch], 0);
    out.count = 1;
  }
}
