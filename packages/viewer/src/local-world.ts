// A flat local frame on the loaded world, for something moving on the
// ground (the driven car, the player on foot): ENU at an anchor point
// (x east, y north, m), re-anchored when what moves gets far from it, so the
// frame stays flat enough. Its world (sim's VehicleWorld): the ground's
// height from the loaded cells (by lat/lon), and the walls of the fine cells
// under a box (each cell's wall grid, queried in that cell's frame), and
// obstacles (setObstacles: rectangles, such as traffic cars, as four walls
// each).

import {
  CELL_LEVEL, cellFrame, cellFromLatLon, ecefToGeodetic, ecefToLocal, enuFrame, frameToFrame, geodeticToEcef, localToEcef,
  queryWalls, transformPoint, type CellId, type Frame, type Vec3, type WallGrid,
} from "@game/world";
import type { VehicleWorld } from "@game/sim";

/** Re-anchor once what moves is this far out, m. */
export const REANCHOR = 2000;

/** What a local world needs from the loaded world. */
export interface LoadedWorld {
  groundAt(lat: number, lon: number): number;
  /** A loaded fine cell's walls, if it's loaded. */
  walls(cell: CellId): WallGrid | undefined;
}

export class LocalWorld implements VehicleWorld {
  private anchor: Frame;
  private toCell = new Map<CellId, { to: ArrayLike<number>; from: ArrayLike<number> }>();
  private w: LoadedWorld;
  private obstacles = new Float64Array(0);  // x0, y0, x1, y1 each, in this frame
  private obstacleCount = 0;

  constructor(lat: number, lon: number, w: LoadedWorld) {
    this.w = w;
    this.anchor = enuFrame({ lat, lon, h: 0 });
  }

  height(x: number, y: number): number {
    const { lat, lon } = this.geodetic(x, y);
    return this.w.groundAt(lat, lon);
  }

  /** The walls of every loaded fine cell under a box, and the obstacles' edges in it, in this frame. */
  walls(x0: number, y0: number, x1: number, y1: number, visit: (ax: number, ay: number, bx: number, by: number) => void): void {
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

  /**
   * Rectangles that block: each a center (x, y, z) and forward direction (x, y) in `view` (as TrafficView.yieldTo
   * writes them, 5 numbers each), `half` long and wide; more (`extra`, already in this frame: x0, y0, x1, y1 each) as
   * they are.
   */
  setObstacles(near: Float64Array, n: number, view: Frame, half: readonly [number, number], extra: readonly number[] = []): void {
    if (this.obstacles.length < 16 * n + extra.length) this.obstacles = new Float64Array(16 * n + extra.length);
    const m = frameToFrame(view, this.anchor);
    for (let k = 0; k < n; k++) {
      const [cx, cy] = transformPoint(m, [near[5 * k]!, near[5 * k + 1]!, near[5 * k + 2]!]);
      const [fx, fy] = [m[0]! * near[5 * k + 3]! + m[4]! * near[5 * k + 4]!, m[1]! * near[5 * k + 3]! + m[5]! * near[5 * k + 4]!];
      const fl = Math.hypot(fx, fy) || 1;
      rectangle(cx, cy, fx / fl, fy / fl, half, this.obstacles, 16 * k);
    }
    this.obstacles.set(extra, 16 * n);
    this.obstacleCount = 4 * n + extra.length / 4;
  }

  /** The frame itself (ENU at the anchor). */
  get anchorFrame(): Frame {
    return this.anchor;
  }

  /** A point of this frame (on the ellipsoid) as lat/lon. */
  geodetic(x: number, y: number) {
    return ecefToGeodetic(localToEcef(this.anchor, [x, y, 0]));
  }

  /** A point of this frame at height z (m above the ellipsoid), in a view frame. */
  toView(view: Frame, x: number, y: number, z: number): Vec3 {
    return ecefToLocal(view, geodeticToEcef({ ...this.geodetic(x, y), h: z }));
  }

  /** A position and forward direction (heading counterclockwise from east, pitch up) of this frame, in a view frame. */
  pose(view: Frame, x: number, y: number, z: number, heading: number, pitch = 0): { pos: Vec3; fwd: Vec3 } {
    const pos = this.toView(view, x, y, z);
    const ahead = this.toView(view, x + Math.cos(heading), y + Math.sin(heading), z + Math.tan(pitch));
    const fwd: Vec3 = [ahead[0] - pos[0], ahead[1] - pos[1], ahead[2] - pos[2]];
    const len = Math.hypot(...fwd);
    return { pos, fwd: [fwd[0] / len, fwd[1] / len, fwd[2] / len] };
  }

  /**
   * Moves the anchor to (x, y), if that's REANCHOR from it; returns how to carry things over (a point, a vector, a
   * heading), or undefined if it didn't move.
   */
  reanchor(x: number, y: number): Reanchor | undefined {
    if (Math.hypot(x, y) <= REANCHOR) return undefined;
    const { lat, lon } = this.geodetic(x, y);
    const next = enuFrame({ lat, lon, h: 0 });
    const m = frameToFrame(this.anchor, next);
    this.anchor = next;
    this.toCell.clear();
    const vector = (vx: number, vy: number): [number, number] => [m[0]! * vx + m[4]! * vy, m[1]! * vx + m[5]! * vy];
    return {
      point: (px, py) => {
        const [qx, qy] = transformPoint(m, [px, py, 0]);
        return [qx, qy];
      },
      vector,
      heading: (a) => {
        const [dx, dy] = vector(Math.cos(a), Math.sin(a));
        return Math.atan2(dy, dx);
      },
    };
  }
}

/** Carries things from an old anchor's frame into the new one's. */
export interface Reanchor {
  point(x: number, y: number): [number, number];
  vector(x: number, y: number): [number, number];
  heading(a: number): number;
}

/** A rectangle's four edges (x0, y0, x1, y1 each) into out[o..o+16]: center, unit forward, half length and width. */
export function rectangle(cx: number, cy: number, fx: number, fy: number, half: readonly [number, number], out: Float64Array | number[], o = 0): void {
  const [ux, uy, sx, sy] = [fx * half[0], fy * half[0], -fy * half[1], fx * half[1]];
  const corners = [[ux + sx, uy + sy], [-ux + sx, -uy + sy], [-ux - sx, -uy - sy], [ux - sx, uy - sy]];
  for (let e = 0; e < 4; e++) {
    const [a, b] = [corners[e]!, corners[(e + 1) % 4]!];
    [out[o + 4 * e], out[o + 4 * e + 1], out[o + 4 * e + 2], out[o + 4 * e + 3]] = [cx + a[0]!, cy + a[1]!, cx + b[0]!, cy + b[1]!];
  }
}
