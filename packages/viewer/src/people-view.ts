// People in the viewer: runs the people sim on the loaded cells' sidewalks
// and turns its rows into instances to draw.
//
// - People live on the roads of cells the traffic knows (its TrafficCells,
//   whose slots are the sim's `cell` column); they leave with their cell.
// - For now they come only from spawnRow (P in the viewer): a row of them on
//   the sidewalk nearest a point, walking both ways.
// - A person stands on their sidewalk's line, `across` m right of its middle
//   as they walk, on the curb, upright (facing along the sidewalk, level).

import { createPeople, removePeople, Rng, spawnPerson, stepPeople, type People } from "@game/sim";
import { offsetPoint, SIDEWALK, sidewalkOffset } from "@game/world";
import { PERSON_STRIDE, type PersonInstances } from "./person-layer.ts";
import type { TrafficCell } from "./traffic-view.ts";

/** spawnRow: this many people, this far apart (m). */
const ROW = 10, ROW_GAP = 3;

export class PeopleView {
  readonly people: People = createPeople(256);
  private cells = new Map<number, TrafficCell>();
  private rng: Rng;
  private p = new Float64Array(6);  // scratch: a sidewalk point (position, direction)

  constructor(seed: number) {
    this.rng = new Rng(seed);
  }

  /**
   * Puts a row of ROW people, ROW_GAP m apart, on the sidewalk nearest (x, y) (in the cell's frame), centered on the
   * point nearest it, every other one walking the other way. Returns how many (0: the cell has no sidewalks).
   */
  spawnRow(tc: TrafficCell, x: number, y: number): number {
    const g = tc.graph, cum = tc.lanes.cum;
    let best = Infinity, edge = -1, side = 0, along = 0;
    for (let e = 0; e < g.edges.count; e++) {
      const bits = g.edges.sidewalks[e]!;
      if (!bits) continue;
      for (let p = g.edges.pointStart[e]!; p + 1 < g.edges.pointStart[e + 1]!; p++) {
        const ax = g.points[2 * p]!, ay = g.points[2 * p + 1]!;
        const dx = g.points[2 * p + 2]! - ax, dy = g.points[2 * p + 3]! - ay, l2 = dx * dx + dy * dy;
        if (l2 === 0) continue;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
        const d = Math.hypot(x - ax - t * dx, y - ay - t * dy);
        if (d >= best) continue;
        // The side the point is on, if it has a sidewalk; else the other.
        const left = dx * (y - ay) - dy * (x - ax) > 0;
        [best, edge, along] = [d, e, cum[p]! + t * (cum[p + 1]! - cum[p]!)];
        side = left ? (bits & 1 ? -1 : 1) : (bits & 2 ? 1 : -1);
      }
    }
    if (edge < 0) return 0;
    this.cells.set(tc.slot, tc);
    const length = tc.lengths[edge]!;
    for (let k = 0; k < ROW; k++) {
      const a = Math.max(0, Math.min(length, along + (k - (ROW - 1) / 2) * ROW_GAP)), dir = k % 2 ? -1 : 1;
      spawnPerson(this.people, { cell: tc.slot, edge, side, dir, s: dir > 0 ? a : length - a, length }, this.rng);
    }
    return ROW;
  }

  /** Everyone on a cell's sidewalks leaves with it. */
  remove(tc: TrafficCell): void {
    if (!this.cells.delete(tc.slot)) return;
    removePeople(this.people, (cell) => cell !== tc.slot);
  }

  update(dt: number): void {
    stepPeople(this.people, dt);
  }

  /** Writes everyone in visible cells into `out`, in the view frame. */
  instances(out: PersonInstances): void {
    const c = this.people.c, p = this.p;
    out.count = 0;
    for (let i = 0; i < this.people.count; i++) {
      const tc = this.cells.get(c.cell[i]!);
      if (!tc?.visible) continue;
      const e = c.edge[i]!, dir = c.dir[i]!;
      offsetPoint(tc.lanes, e, dir, sidewalkOffset(tc.graph, e, c.side[i]!) + dir * c.across[i]!, c.s[i]!, p);
      const [x, y, z] = [p[0]!, p[1]!, p[2]! + SIDEWALK.curb];
      const fl = Math.hypot(p[3]!, p[4]!) || 1, [fx, fy] = [p[3]! / fl, p[4]! / fl];
      if (PERSON_STRIDE * (out.count + 1) > out.data.length) {
        const grown = new Float32Array(out.data.length * 2);
        grown.set(out.data);
        out.data = grown;
      }
      const m = tc.model, o = PERSON_STRIDE * out.count++, d = out.data;
      d[o] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
      d[o + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
      d[o + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
      d[o + 3] = m[0]! * fx + m[4]! * fy;
      d[o + 4] = m[1]! * fx + m[5]! * fy;
      d[o + 5] = m[2]! * fx + m[6]! * fy;
      d[o + 6] = c.phase[i]!;
      d[o + 7] = 1;
    }
  }
}
