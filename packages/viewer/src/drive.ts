// Driving (V): the player's car (sim's vehicle) on the loaded world, stepped
// in a LocalWorld (re-anchored at the car once it's far from the anchor).
// Its walls: the fine cells' buildings, and the traffic cars near it
// (setObstacles). The camera chases it, following its heading with a lag, so
// a slide shows. Getting out (F) leaves it parked: where it stands and which
// way it faces, to start from again (Drive.from).

import { forwardSpeed, placeVehicle, stepVehicle, type DriveInput, type Vehicle } from "@game/sim";
import { enuFrame, frameToFrame, type Frame, type Vec3 } from "@game/world";
import { fromYawPitch } from "./camera.ts";
import type { GlobeCamera } from "./globe-camera.ts";
import { LocalWorld, type LoadedWorld } from "./local-world.ts";

/** The chase camera: behind and above the car (m), looking down a little, turning toward the car's heading at LAG /s. */
const CHASE = { back: 7.5, up: 2.6, pitch: -0.16, lag: 5, clearance: 1.2 };

/** A car standing somewhere: lat/lon, and its heading (radians counterclockwise from east, in the ENU frame there). */
export interface Parked {
  lat: number;
  lon: number;
  heading: number;
}

export class Drive {
  readonly car: Vehicle;
  readonly local: LocalWorld;
  private yaw: number;  // the camera's heading, radians counterclockwise from east
  private w: LoadedWorld;

  /** Starts at rest at a point, facing `heading` (radians counterclockwise from east). */
  constructor(lat: number, lon: number, heading: number, w: LoadedWorld) {
    this.w = w;
    this.local = new LocalWorld(lat, lon, w);
    this.car = placeVehicle(0, 0, heading, this.local);
    this.yaw = heading;
  }

  /** Back in a parked car. */
  static from(p: Parked, w: LoadedWorld): Drive {
    return new Drive(p.lat, p.lon, p.heading, w);
  }

  step(input: DriveInput, dt: number): void {
    stepVehicle(this.car, input, dt, this.local);
    // The camera turns toward the car's heading (the short way round).
    const d = Math.atan2(Math.sin(this.car.heading - this.yaw), Math.cos(this.car.heading - this.yaw));
    this.yaw += d * Math.min(1, CHASE.lag * dt);
    const r = this.local.reanchor(this.car.x, this.car.y);
    if (r) {
      const c = this.car;
      [c.x, c.y] = r.point(c.x, c.y);
      [c.vx, c.vy] = r.vector(c.vx, c.vy);
      [c.heading, this.yaw] = [r.heading(c.heading), r.heading(this.yaw)];
    }
  }

  /** The traffic cars near the car (as TrafficView.yieldTo writes them, in `view`) become walls, `half` long and wide. */
  setObstacles(near: Float64Array, n: number, view: Frame, half: readonly [number, number]): void {
    this.local.setObstacles(near, n, view, half);
  }

  /** km/h, for the dashboard. */
  get kmh(): number {
    return forwardSpeed(this.car) * 3.6;
  }

  /** Where the car stands now, to leave it parked. */
  parked(): Parked {
    const c = this.car, { lat, lon } = this.local.geodetic(c.x, c.y);
    // Its heading carried from the anchor's ENU frame into the one where it stands.
    const there = enuFrame({ lat, lon, h: 0 }), m = frameToFrame(this.local.anchorFrame, there);
    const [dx, dy] = [m[0]! * Math.cos(c.heading) + m[4]! * Math.sin(c.heading), m[1]! * Math.cos(c.heading) + m[5]! * Math.sin(c.heading)];
    return { lat, lon, heading: Math.atan2(dy, dx) };
  }

  /** The chase camera: behind the car along the camera's heading, above it, never under the ground. */
  camera(): GlobeCamera {
    const [x, y] = [this.car.x - Math.cos(this.yaw) * CHASE.back, this.car.y - Math.sin(this.yaw) * CHASE.back];
    const { lat, lon } = this.local.geodetic(x, y);
    const h = Math.max(this.car.z + CHASE.up, this.w.groundAt(lat, lon) + CHASE.clearance);
    // Yaw counterclockwise from north; our headings are from east.
    return { lat, lon, h, rot: fromYawPitch(this.yaw - Math.PI / 2, CHASE.pitch) };
  }

  /** The car's position and forward direction in a view frame (for drawing it as a traffic car). */
  pose(view: Frame): { pos: Vec3; fwd: Vec3 } {
    const c = this.car;
    return this.local.pose(view, c.x, c.y, c.z, c.heading, c.pitch);
  }
}
