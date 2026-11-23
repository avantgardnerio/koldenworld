// Vagrants in the viewer: runs the vagrant sim around the loaded cells'
// charities and turns its rows into instances to draw.
//
// - Each loaded cell with a place that draws them (placeVagrants) gets a
//   slot (the sim's `cell` column); a vagrant's position is in its cell's
//   frame, wherever they wander.
// - Cells near the camera are populated: their placements start roaming.
//   Cells beyond a larger distance are dropped, and with them their
//   vagrants.
// - Walls are the cell's own buildings' (its wall grid): one wandering into a
//   neighbouring cell's buildings isn't stopped by them (yet).
// - A vagrant stands on the terrain under them, facing their heading:
//   running (a longer stride, a bigger swing), shouting (arms waving over
//   their head), staggering (swaying), standing, sitting, or lying on their
//   back.

import { createVagrants, removeVagrants, Rng, spawnVagrant, stepVagrants, type RoamWorld, type Vagrants } from "@game/sim";
import { queryWalls, type VagrantPlacements, type WallGrid } from "@game/world";
import { PERSON_STRIDE, POSE, type PersonInstances } from "./person-layer.ts";

/** By the sim's STATE (stand, stagger, run, sit, lie, shout): how far the legs swing (1: a walk's), and the pose. */
const GAIT = [0, 0.8, 1.7, 0, 0, 1.3];
const POSES = [POSE.upright, POSE.stagger, POSE.upright, POSE.sit, POSE.lie, POSE.shout];

/** A loaded cell, as the vagrants see it. */
export interface RoamCell {
  model: Float32Array;  // the cell's live cell → view transform (owned by the renderer)
  walls: WallGrid;
  /** The ground's height at a point of the cell's frame. */
  ground(x: number, y: number): number;
  placements: VagrantPlacements;
  visible: boolean;     // set by the renderer each frame
}

export class VagrantView implements RoamWorld {
  readonly vagrants: Vagrants = createVagrants();
  private slots: (RoamCell | undefined)[] = [];
  private free: number[] = [];
  private populated = new Set<number>();
  private rng: Rng;

  constructor(seed: number) {
    this.rng = new Rng(seed);
  }

  /** Registers a loaded cell, if anyone is placed in it; returns it. */
  add(rc: RoamCell): RoamCell {
    if (rc.placements.count > 0) this.slots[this.free.pop() ?? this.slots.length] = rc;
    return rc;
  }

  /** Unregisters a cell; its vagrants leave with it. */
  remove(rc: RoamCell): void {
    const slot = this.slots.indexOf(rc);
    if (slot < 0) return;
    this.slots[slot] = undefined;
    this.free.push(slot);
    this.populated.delete(slot);
    removeVagrants(this.vagrants, (cell) => cell !== slot);
  }

  /**
   * Populates cells within `near` m (their placements start roaming), drops those beyond `far` (and their
   * vagrants), and advances the sim by dt if `moving`.
   */
  update(dt: number, distance: (rc: RoamCell) => number, near: number, far: number, moving: boolean): void {
    this.slots.forEach((rc, slot) => {
      if (!rc) return;
      const d = distance(rc);
      if (!this.populated.has(slot) && d < near) {
        this.populated.add(slot);
        const p = rc.placements;
        for (let i = 0; i < p.count; i++) spawnVagrant(this.vagrants, slot, p.x[i]!, p.y[i]!, p.ax[i]!, p.ay[i]!, this.rng);
      } else if (this.populated.has(slot) && d > far) {
        this.populated.delete(slot);
        removeVagrants(this.vagrants, (cell) => cell !== slot);
      }
    });
    if (moving) stepVagrants(this.vagrants, this, dt, this.rng);
  }

  /** Writes everyone in visible cells into `out`, in the view frame. */
  instances(out: PersonInstances): void {
    const c = this.vagrants.c;
    out.count = 0;
    for (let i = 0; i < this.vagrants.count; i++) {
      const rc = this.slots[c.cell[i]!];
      if (!rc?.visible) continue;
      const [x, y] = [c.x[i]!, c.y[i]!], z = rc.ground(x, y), [fx, fy] = [Math.cos(c.heading[i]!), Math.sin(c.heading[i]!)];
      const state = c.state[i]!;
      const gait = GAIT[state]!, pose = POSES[state]!;
      if (PERSON_STRIDE * (out.count + 1) > out.data.length) {
        const grown = new Float32Array(out.data.length * 2);
        grown.set(out.data);
        out.data = grown;
      }
      const m = rc.model, o = PERSON_STRIDE * out.count++;
      out.data.set([
        m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
        m[0]! * fx + m[4]! * fy, m[1]! * fx + m[5]! * fy, m[2]! * fx + m[6]! * fy,
        c.phase[i]!, gait, pose,
      ], o);
    }
  }

  // --- RoamWorld ---------------------------------------------------------------------

  blocked(cell: number, x0: number, y0: number, x1: number, y1: number): boolean {
    const rc = this.slots[cell];
    if (!rc) return false;
    let hit = false;
    queryWalls(rc.walls, Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1), (ax, ay, bx, by) => {
      if (!hit && crosses(x0, y0, x1, y1, ax, ay, bx, by)) hit = true;
    });
    return hit;
  }
}

/** Whether segments p0–p1 and q0–q1 cross (touching counts). */
function crosses(px: number, py: number, qx: number, qy: number, ax: number, ay: number, bx: number, by: number): boolean {
  const side = (ox: number, oy: number, ux: number, uy: number, x: number, y: number) => Math.sign((ux - ox) * (y - oy) - (uy - oy) * (x - ox));
  return side(px, py, qx, qy, ax, ay) * side(px, py, qx, qy, bx, by) <= 0 && side(ax, ay, bx, by, px, py) * side(ax, ay, bx, by, qx, qy) <= 0;
}
