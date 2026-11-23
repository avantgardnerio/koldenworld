// People in the viewer: runs the people sim on the loaded cells' sidewalks
// and turns its rows into instances to draw.
//
// - The sidewalk net is every loaded cell's roads (the traffic's
//   TrafficCells, whose slots are the sim's `cell` column), joined where
//   cells share an OSM node. People leave with their cell.
// - At a junction the roads are rays out of the node, sorted
//   counterclockwise; between each two neighbours is a corner, with a
//   sidewalk from each (the left one of a ray, the right one of the next).
//   Arriving at a corner, a person can round it onto its other sidewalk, or
//   cross the road either side of it to the next corner and walk on along
//   either of that one's sidewalks (less likely: back along the road they
//   came by). Where only two roads meet (a node along a street), they only
//   walk on. Where there's no way on, they turn round.
// - Sidewalks stop REACH short of a node (past the widest road there, its
//   grass and its sidewalk), at most halfway along the edge. Crosswalks run
//   across a road a sidewalk's width nearer the node, so the sidewalks beyond
//   them start ahead of where a crossing lands. A passage: a curve from the
//   sidewalk to the crosswalk, across it, a curve onto the next sidewalk; or
//   one curve.
//   Passage points are worked out in the view frame (each cell's model), so
//   passages join cells.
// - A person stands on their sidewalk's line, `across` m right of its middle
//   as they walk (on crosswalks too), on the curb, upright (facing along their
//   way, level).
// - Cells near the camera are populated: the people placed on their sidewalks
//   (placePeople) start walking. Cells beyond a larger distance are dropped,
//   and with them everyone on their sidewalks. Ways on lead only into
//   populated cells, so the edge of the populated area is like a dead end.

import {
  createPeople, NO_CROSSING, PASSAGE, removePeople, Rng, spawnPerson, stepPeople, type People, type SidewalkNet,
} from "@game/sim";
import { offsetPoint, placePeople, SIDEWALK, sidewalkOffset, turnPoint } from "@game/world";
import { PERSON_STRIDE, type PersonInstances } from "./person-layer.ts";
import type { TrafficCell } from "./traffic-view.ts";

/** The weight of a way on that goes back along the road they came by (others: 1). */
const BACK = 0.25;

export class PeopleView implements SidewalkNet {
  readonly people: People = createPeople(256);
  private slots = new Map<number, TrafficCell>();
  private seeds = new Map<number, number>();  // per slot: its cell's placement seed
  private populated = new Set<number>();      // slots
  private nodes = new Map<number, number[]>();  // OSM node id → slot, node, slot, node, …
  private rng: Rng;
  // Scratch: a junction's roads out (junction), by column, and their counterclockwise order.
  private ray = { slot: [] as number[], edge: [] as number[], out: [] as number[], angle: [] as number[], order: [] as number[] };
  // Scratch: passage points (position, direction, view frame) and a sidewalk point.
  private A = new Float64Array(6);
  private C1 = new Float64Array(6);
  private C2 = new Float64Array(6);
  private B = new Float64Array(6);
  private p = new Float64Array(6);
  private q = new Float64Array(6);

  constructor(seed: number) {
    this.rng = new Rng(seed);
  }

  /** Registers a loaded cell's roads, with the seed its people are placed by; returns it. */
  add(tc: TrafficCell, seed: number): TrafficCell {
    this.slots.set(tc.slot, tc);
    this.seeds.set(tc.slot, seed);
    for (let n = 0; n < tc.graph.nodes.count; n++) {
      const id = tc.graph.nodes.osmId[n]!, list = this.nodes.get(id);
      if (list) list.push(tc.slot, n);
      else this.nodes.set(id, [tc.slot, n]);
    }
    return tc;
  }

  /** Unregisters a cell; everyone on, crossing or heading for its sidewalks leaves with it. */
  remove(tc: TrafficCell): void {
    if (!this.slots.delete(tc.slot)) return;
    this.seeds.delete(tc.slot);
    this.populated.delete(tc.slot);
    for (let n = 0; n < tc.graph.nodes.count; n++) {
      const id = tc.graph.nodes.osmId[n]!, list = this.nodes.get(id)!;
      for (let k = list.length - 2; k >= 0; k -= 2) if (list[k] === tc.slot) list.splice(k, 2);
      if (list.length === 0) this.nodes.delete(id);
    }
    removePeople(this.people, (cell) => this.slots.has(cell));
  }

  /**
   * Populates cells within `near` m (their placements start walking), drops those beyond `far` (and everyone on
   * them), and advances the sim by dt if `moving`.
   */
  update(dt: number, distance: (tc: TrafficCell) => number, near: number, far: number, moving: boolean): void {
    let dropped = false;
    for (const [slot, tc] of this.slots) {
      const d = distance(tc);
      if (!this.populated.has(slot) && d < near) {
        this.populated.add(slot);
        const p = placePeople(tc.graph, this.seeds.get(slot)!);
        for (let i = 0; i < p.count; i++) {
          const dir = p.dir[i]!, s = dir > 0 ? p.s[i]! : tc.lengths[p.edge[i]!]! - p.s[i]!;
          spawnPerson(this.people, this, { cell: slot, edge: p.edge[i]!, side: p.side[i]!, dir, s }, this.rng);
        }
      } else if (this.populated.has(slot) && d > far) {
        this.populated.delete(slot);
        dropped = true;
      }
    }
    if (dropped) removePeople(this.people, (cell) => this.populated.has(cell));
    if (moving) stepPeople(this.people, this, dt, this.rng);
  }

  /** Writes everyone in visible cells into `out`, in the view frame. */
  instances(out: PersonInstances): void {
    const c = this.people.c, { p, q } = this;
    out.count = 0;
    for (let i = 0; i < this.people.count; i++) {
      if (!this.slots.get(c.cell[i]!)?.visible) continue;
      let fx: number, fy: number;
      if (c.leg[i] === PASSAGE) {
        this.passagePoint(i, c.s[i]! - 0.05, q);
        this.passagePoint(i, c.s[i]!, p);
        this.passagePoint(i, c.s[i]! + 0.05, p.subarray(3));
        [fx, fy] = [p[3]! - q[0]!, p[4]! - q[1]!];
      } else {
        this.sidewalkPoint(c.cell[i]!, c.edge[i]!, c.dir[i]!, c.side[i]!, c.across[i]!, c.s[i]!, p);
        [fx, fy] = [p[3]!, p[4]!];
      }
      const fl = Math.hypot(fx, fy) || 1;
      if (PERSON_STRIDE * (out.count + 1) > out.data.length) {
        const grown = new Float32Array(out.data.length * 2);
        grown.set(out.data);
        out.data = grown;
      }
      const o = PERSON_STRIDE * out.count++, d = out.data;
      d.set([p[0]!, p[1]!, p[2]!, fx / fl, fy / fl, 0, c.phase[i]!, 1], o);
    }
  }

  // --- SidewalkNet -----------------------------------------------------------------

  enter(cell: number, edge: number, dir: number): number {
    return this.reach(this.slots.get(cell)!, edge, dir > 0);
  }

  leave(cell: number, edge: number, dir: number): number {
    const tc = this.slots.get(cell)!;
    return tc.lengths[edge]! - this.reach(tc, edge, dir < 0);
  }

  onward(cell: number, edge: number, dir: number, side: number, across: number, out: number[]): void {
    const { slot, edge: re, out: ro, order } = this.junction(cell, edge, dir), m = order.length;
    // The ray they came in by (k: its place counterclockwise), and the corner they're at (corner c: between the rays
    // at places c and c + 1).
    const k = order.findIndex((r) => slot[r] === cell && re[r] === edge && ro[r] === -dir);
    const outSide = side * -dir;  // their side, looking out along the ray: −1 left
    const at = (c: number) => order[((c % m) + m) % m]!;
    const corner = outSide < 0 ? k : k - 1;
    const has = (r: number, o: number) => (this.slots.get(slot[r]!)!.graph.edges.sidewalks[re[r]!]! & (o * ro[r]! > 0 ? 2 : 1)) !== 0;
    const first = out.length;
    // Onto the sidewalk on ray r, its outward side o, after crossing ray x (from its outward side xo) if x ≥ 0.
    const way = (r: number, o: number, x = -1, xo = 0) => {
      const back = r === order[k];
      if (!has(r, o) || (back && o === outSide)) return;
      const [ns, ne, nd, nsd] = [slot[r]!, re[r]!, ro[r]!, o * ro[r]!];
      const [xs, xe, xsd] = x >= 0 ? [slot[x]!, re[x]!, xo * ro[x]!] : [NO_CROSSING, 0, 0];
      const length = this.passage(cell, edge, dir, side, across, xs, xe, xsd, ns, ne, nd, nsd);
      out.push(back ? BACK : 1, length, xs, xe, xsd, ns, ne, nd, nsd);
    };
    if (k >= 0) {
      // Round the corner (along a street: walk on).
      way(at(corner), -1);
      way(at(corner + 1), 1);
    }
    if (k >= 0 && m >= 3) {
      // Across the road counterclockwise of the corner, or clockwise.
      way(at(corner + 1), -1, at(corner + 1), 1);
      way(at(corner + 2), 1, at(corner + 1), 1);
      way(at(corner - 1), -1, at(corner), -1);
      way(at(corner), 1, at(corner), -1);
    }
    if (out.length === first) {
      const length = this.passage(cell, edge, dir, side, across, NO_CROSSING, 0, 0, cell, edge, -dir, side);
      out.push(1, length, NO_CROSSING, 0, 0, cell, edge, -dir, side);
    }
  }

  // --- geometry ---------------------------------------------------------------------

  /** How far short of the node at an end of an edge its sidewalks stop, m: past the junction's roads, grass and walks. */
  private reach(tc: TrafficCell, edge: number, atFrom: boolean): number {
    const g = tc.graph, node = atFrom ? g.edges.from[edge]! : g.edges.to[edge]!;
    return Math.min(tc.lanes.radius[node]! + SIDEWALK.grass + SIDEWALK.width, tc.lengths[edge]! / 2);
  }

  /** The roads out of the node at the end of (cell, edge) walked in dir, in every loaded cell, counterclockwise. */
  private junction(cell: number, edge: number, dir: number) {
    const ray = this.ray;
    for (const col of Object.values(ray)) col.length = 0;
    const tc = this.slots.get(cell)!, g = tc.graph;
    const id = g.nodes.osmId[dir > 0 ? g.edges.to[edge]! : g.edges.from[edge]!]!;
    const here = this.nodes.get(id) ?? [];
    for (let k = 0; k < here.length; k += 2) {
      const slot = here[k]!, n = here[k + 1]!, h = this.slots.get(slot)!;
      if (!this.populated.has(slot)) continue;  // onward only into populated cells
      const hg = h.graph, m = h.model;
      for (let j = hg.nodes.edgeStart[n]!; j < hg.nodes.edgeStart[n + 1]!; j++) {
        const e = hg.nodes.edgeList[j]!;
        for (const out of [1, -1]) {
          if ((out > 0 ? hg.edges.from[e] : hg.edges.to[e]) !== n) continue;
          if (ray.slot.some((s, r) => s === slot && ray.edge[r] === e && ray.out[r] === out)) continue;
          // Its first segment out of the node (skipping repeated points), turned into the view frame.
          const p0 = hg.edges.pointStart[e]!, p1 = hg.edges.pointStart[e + 1]! - 1;
          let [a, b] = out > 0 ? [p0, p0 + 1] : [p1, p1 - 1];
          while (b !== (out > 0 ? p1 : p0) && hg.points[2 * b] === hg.points[2 * a] && hg.points[2 * b + 1] === hg.points[2 * a + 1]) b += out;
          const dx = hg.points[2 * b]! - hg.points[2 * a]!, dy = hg.points[2 * b + 1]! - hg.points[2 * a + 1]!;
          ray.order.push(ray.slot.length);
          ray.slot.push(slot);
          ray.edge.push(e);
          ray.out.push(out);
          ray.angle.push(Math.atan2(m[1]! * dx + m[5]! * dy, m[0]! * dx + m[4]! * dy));
        }
      }
    }
    ray.order.sort((a, b) => ray.angle[a]! - ray.angle[b]!);
    return ray;
  }

  /** A point on a sidewalk (position on the curb, direction of travel), `across` m right of its middle, in the view frame. */
  private sidewalkPoint(cell: number, edge: number, dir: number, side: number, across: number, s: number, out: Float64Array): void {
    const tc = this.slots.get(cell)!;
    offsetPoint(tc.lanes, edge, dir, sidewalkOffset(tc.graph, edge, side) + dir * across, s, out);
    toView(tc.model, out, SIDEWALK.curb);
  }

  /**
   * A passage's points into the scratch arrays: A, the end of the sidewalk it leaves; B, the start of the one it joins;
   * across a road, C1 and C2, its crosswalk's ends (from the side xside), `across` m right of its line. Returns its
   * length, m: its pieces' chords, the curves' stretched by how much they turn.
   */
  private passage(
    cell: number, edge: number, dir: number, side: number, across: number,
    xcell: number, xedge: number, xside: number, ncell: number, nedge: number, ndir: number, nside: number,
  ): number {
    const { A, B, C1, C2 } = this;
    this.sidewalkPoint(cell, edge, dir, side, across, this.leave(cell, edge, dir), A);
    this.sidewalkPoint(ncell, nedge, ndir, nside, across, this.enter(ncell, nedge, ndir), B);
    if (xcell === NO_CROSSING) return curveLength(A, B);
    // The crosswalk: REACH out along the crossed road from the junction (the end of it that's there).
    const tc = this.slots.get(cell)!, g = tc.graph, xc = this.slots.get(xcell)!, xg = xc.graph;
    const id = g.nodes.osmId[dir > 0 ? g.edges.to[edge]! : g.edges.from[edge]!]!;
    const xdir = xg.nodes.osmId[xg.edges.from[xedge]!] === id ? 1 : -1;
    const r = Math.max(0, this.enter(xcell, xedge, xdir) - SIDEWALK.width);
    this.sidewalkPoint(xcell, xedge, xdir, xside, 0, r, C1);
    this.sidewalkPoint(xcell, xedge, xdir, -xside, 0, r, C2);
    const dx = C2[0]! - C1[0]!, dy = C2[1]! - C1[1]!, l = Math.hypot(dx, dy) || 1, [ux, uy] = [dx / l, dy / l];
    for (const [C, end] of [[C1, 1], [C2, -1]] as const) {
      // Right of the crossing by `across`, and in from its ends by as much (on the line they keep to either side).
      C[0]! += uy * across + end * ux * across;
      C[1]! += -ux * across + end * uy * across;
      [C[3], C[4], C[5]] = [ux, uy, 0];
    }
    return curveLength(A, C1) + Math.max(0, l - 2 * across) + curveLength(C2, B);
  }

  /** The point u m along person i's passage (clamped to it), position only, in the view frame. */
  private passagePoint(i: number, u: number, out: Float64Array): void {
    const c = this.people.c, { A, B, C1, C2 } = this;
    const length = this.passage(
      c.cell[i]!, c.edge[i]!, c.dir[i]!, c.side[i]!, c.across[i]!,
      c.xcell[i]!, c.xedge[i]!, c.xside[i]!, c.ncell[i]!, c.nedge[i]!, c.ndir[i]!, c.nside[i]!,
    );
    // Stretched to the length the sim walks (it was measured when they set out).
    u = Math.max(0, Math.min(1, u / c.end[i]!)) * length;
    if (c.xcell[i] === NO_CROSSING) return turnPoint(A, B, u / length, out);
    const l1 = curveLength(A, C1), l2 = Math.hypot(C2[0]! - C1[0]!, C2[1]! - C1[1]!);
    if (u < l1) return turnPoint(A, C1, u / l1, out);
    if (u < l1 + l2) {
      const t = (u - l1) / l2;
      for (let k = 0; k < 3; k++) out[k] = C1[k]! + (C2[k]! - C1[k]!) * t;
      return;
    }
    turnPoint(C2, B, (u - l1 - l2) / (length - l1 - l2), out);
  }
}

/** A curve's length between two points (position, direction), roughly: its chord, up to π/2 times it for a U-turn. */
function curveLength(a: Float64Array, b: Float64Array): number {
  const chord = Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!);
  const cos = a[3]! * b[3]! + a[4]! * b[4]! + a[5]! * b[5]!;
  return chord * (1 + 0.285 * (1 - cos)) || 0.01;
}

/** A point (position raised by `up`, direction) from a cell's frame into the view frame, in place. */
function toView(m: Float32Array, p: Float64Array, up: number): void {
  const x = p[0]!, y = p[1]!, z = p[2]! + up, fx = p[3]!, fy = p[4]!, fz = p[5]!;
  p[0] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
  p[1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
  p[2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
  p[3] = m[0]! * fx + m[4]! * fy + m[8]! * fz;
  p[4] = m[1]! * fx + m[5]! * fy + m[9]! * fz;
  p[5] = m[2]! * fx + m[6]! * fy + m[10]! * fz;
}
