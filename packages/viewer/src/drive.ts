// Driving (V): the player's car (sim's vehicle) on the loaded world. The car
// is stepped in a local flat frame, ENU at where driving started (re-anchored
// at the car once it's REANCHOR m away, so the frame stays flat enough). Its
// world: the ground's height from the loaded cells (by lat/lon), and the walls
// of the fine cells under its box (each cell's wall grid, queried in that
// cell's frame), and the traffic cars near it (setObstacles: each car's
// rectangle as four more walls). The camera chases it, following its heading
// with a lag, so a slide shows.

import {
  CELL_LEVEL, cellFrame, cellFromLatLon, ecefToGeodetic, ecefToLocal, enuFrame, frameToFrame, geodeticToEcef, localToEcef,
  queryWalls, transformPoint, type CellId, type Frame, type Vec3, type WallGrid,
} from "@game/world";
import { forwardSpeed, placeVehicle, stepVehicle, type DriveInput, type Vehicle, type VehicleWorld } from "@game/sim";
import { fromYawPitch } from "./camera.ts";
import type { GlobeCamera } from "./globe-camera.ts";

/** Re-anchor the car's frame this far out, m. */
const REANCHOR = 2000;
/** The chase camera: behind and above the car (m), looking down a little, turning toward the car's heading at LAG /s. */
const CHASE = { back: 7.5, up: 2.6, pitch: -0.16, lag: 5, clearance: 1.2 };

/** What driving needs from the loaded world. */
export interface DriveWorld {
  groundAt(lat: number, lon: number): number;
  /** A loaded fine cell's walls, if it's loaded. */
  walls(cell: CellId): WallGrid | undefined;
}

export class Drive {
  readonly car: Vehicle;
  private anchor: Frame;
  private yaw: number;  // the camera's heading, radians counterclockwise from east
  private toCell = new Map<CellId, { to: ArrayLike<number>; from: ArrayLike<number> }>();
  private world: VehicleWorld;
  private w: DriveWorld;
  private obstacles = new Float64Array(0);  // traffic cars' edges: x0, y0, x1, y1 each, in the car's frame
  private obstacleCount = 0;

  /** Starts at rest at a point, facing `heading` (radians counterclockwise from east). */
  constructor(lat: number, lon: number, heading: number, w: DriveWorld) {
    this.w = w;
    this.anchor = enuFrame({ lat, lon, h: 0 });
    this.world = {
      height: (x, y) => {
        const { lat, lon } = this.geodetic(x, y);
        return w.groundAt(lat, lon);
      },
      walls: (x0, y0, x1, y1, visit) => this.walls(x0, y0, x1, y1, visit),
    };
    this.car = placeVehicle(0, 0, heading, this.world);
    this.yaw = heading;
  }

  step(input: DriveInput, dt: number): void {
    stepVehicle(this.car, input, dt, this.world);
    // The camera turns toward the car's heading (the short way round).
    const d = Math.atan2(Math.sin(this.car.heading - this.yaw), Math.cos(this.car.heading - this.yaw));
    this.yaw += d * Math.min(1, CHASE.lag * dt);
    if (Math.hypot(this.car.x, this.car.y) > REANCHOR) this.reanchor();
  }

  /**
   * The traffic cars near the car (as TrafficView.yieldTo writes them: center x, y, z and forward x, y, in `view`) become
   * walls: each a rectangle `half` long and wide, its four edges.
   */
  setObstacles(near: Float64Array, n: number, view: Frame, half: readonly [number, number]): void {
    if (this.obstacles.length < 16 * n) this.obstacles = new Float64Array(16 * n);
    const m = frameToFrame(view, this.anchor);
    for (let k = 0; k < n; k++) {
      const [cx, cy] = transformPoint(m, [near[5 * k]!, near[5 * k + 1]!, near[5 * k + 2]!]);
      const [fx, fy] = [m[0]! * near[5 * k + 3]! + m[4]! * near[5 * k + 4]!, m[1]! * near[5 * k + 3]! + m[5]! * near[5 * k + 4]!];
      const fl = Math.hypot(fx, fy) || 1;
      const [ux, uy, sx, sy] = [(fx / fl) * half[0], (fy / fl) * half[0], (-fy / fl) * half[1], (fx / fl) * half[1]];
      const corners = [[ux + sx, uy + sy], [-ux + sx, -uy + sy], [-ux - sx, -uy - sy], [ux - sx, uy - sy]];
      for (let e = 0; e < 4; e++) {
        const [a, b] = [corners[e]!, corners[(e + 1) % 4]!];
        this.obstacles.set([cx + a[0]!, cy + a[1]!, cx + b[0]!, cy + b[1]!], 16 * k + 4 * e);
      }
    }
    this.obstacleCount = 4 * n;
  }

  /** km/h, for the HUD. */
  get kmh(): number {
    return forwardSpeed(this.car) * 3.6;
  }

  /** The chase camera: behind the car along the camera's heading, above it, never under the ground. */
  camera(): GlobeCamera {
    const [x, y] = [this.car.x - Math.cos(this.yaw) * CHASE.back, this.car.y - Math.sin(this.yaw) * CHASE.back];
    const { lat, lon } = this.geodetic(x, y);
    const h = Math.max(this.car.z + CHASE.up, this.w.groundAt(lat, lon) + CHASE.clearance);
    // Yaw counterclockwise from north; our headings are from east.
    return { lat, lon, h, rot: fromYawPitch(this.yaw - Math.PI / 2, CHASE.pitch) };
  }

  /** The car's position and forward direction in a view frame (for drawing it as a traffic car). */
  pose(view: Frame): { pos: Vec3; fwd: Vec3 } {
    const c = this.car;
    const at = (x: number, y: number, z: number) => ecefToLocal(view, geodeticToEcef({ ...this.geodetic(x, y), h: z }));
    const pos = at(c.x, c.y, c.z);
    const ahead = at(c.x + Math.cos(c.heading), c.y + Math.sin(c.heading), c.z + Math.tan(c.pitch));
    const fwd: Vec3 = [ahead[0] - pos[0], ahead[1] - pos[1], ahead[2] - pos[2]];
    const len = Math.hypot(...fwd);
    return { pos, fwd: [fwd[0] / len, fwd[1] / len, fwd[2] / len] };
  }

  /** A point of the car's frame (on the ellipsoid) as lat/lon. */
  private geodetic(x: number, y: number) {
    return ecefToGeodetic(localToEcef(this.anchor, [x, y, 0]));
  }

  /** The walls of every loaded fine cell under a box, and the traffic cars' edges in it, in the car's frame. */
  private walls(x0: number, y0: number, x1: number, y1: number, visit: (ax: number, ay: number, bx: number, by: number) => void) {
    const o = this.obstacles;
    for (let s = 0; s < this.obstacleCount; s++) {
      const [ax, ay, bx, by] = [o[4 * s]!, o[4 * s + 1]!, o[4 * s + 2]!, o[4 * s + 3]!];
      if (Math.max(ax, bx) >= x0 && Math.min(ax, bx) <= x1 && Math.max(ay, by) >= y0 && Math.min(ay, by) <= y1) visit(ax, ay, bx, by);
    }
    const cells = new Set<CellId>();
    for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as const) {
      const { lat, lon } = this.geodetic(x, y);
      cells.add(cellFromLatLon(lat, lon, CELL_LEVEL));
    }
    for (const cell of cells) {
      const grid = this.w.walls(cell);
      if (!grid) continue;
      const f = cellFrame(cell);
      const m = this.toCell.get(cell) ?? { to: frameToFrame(this.anchor, f), from: frameToFrame(f, this.anchor) };
      this.toCell.set(cell, m);
      // The box in the cell's frame (its corners' bounds), queried there; the walls back in ours.
      let [cx0, cy0, cx1, cy1] = [Infinity, Infinity, -Infinity, -Infinity];
      for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as const) {
        const [px, py] = transformPoint(m.to, [x, y, 0]);
        [cx0, cy0, cx1, cy1] = [Math.min(cx0, px), Math.min(cy0, py), Math.max(cx1, px), Math.max(cy1, py)];
      }
      const back = m.from;
      queryWalls(grid, cx0, cy0, cx1, cy1, (ax, ay, bx, by) => {
        const [px, py] = transformPoint(back, [ax, ay, 0]), [qx, qy] = transformPoint(back, [bx, by, 0]);
        visit(px, py, qx, qy);
      });
    }
  }

  /** Moves the frame's anchor to the car, keeping its pose (heading turned into the new frame). */
  private reanchor(): void {
    const c = this.car;
    const { lat, lon } = this.geodetic(c.x, c.y);
    const next = enuFrame({ lat, lon, h: 0 });
    const m = frameToFrame(this.anchor, next);
    const turn = (a: number) => {
      const [dx, dy] = [m[0]! * Math.cos(a) + m[4]! * Math.sin(a), m[1]! * Math.cos(a) + m[5]! * Math.sin(a)];
      return Math.atan2(dy, dx);
    };
    const [vx, vy] = [m[0]! * c.vx + m[4]! * c.vy, m[1]! * c.vx + m[5]! * c.vy];
    [c.x, c.y, c.vx, c.vy, c.heading, this.yaw] = [0, 0, vx, vy, turn(c.heading), turn(this.yaw)];
    this.anchor = next;
    this.toCell.clear();
  }
}
