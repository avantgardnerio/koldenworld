// RoadGraph → road surface mesh: asphalt ribbons with real widths, intersection
// discs, and lane markings, as one triangle mesh with a material per vertex.
// Pure and deterministic, like every operator.
//
// Cross-section of an edge, looking along from → to (right-hand traffic; the
// forward lanes are on the right, offsets are positive to the right):
//
//   shoulder | back lanes … ‖ forward lanes … | shoulder
//                           c = (back − fwd) · laneWidth / 2
//
// Sidewalks (decision 33), on the sides the edge's `sidewalks` bits say: a
// SIDEWALK.width strip beyond the shoulder, SIDEWALK.curb above the road, with
// a curb face up from the road and an outer face down to the ground. They stop
// at intersection discs (leaving the corners open, like curb ramps) and run
// through plain joints.
//
// Markings (tertiary and above only; US residential streets mostly have none):
// double yellow at c on two-way roads, dashed white between lanes running the
// same way. They stop short of intersections and dead ends.
//
// Triangles are in draw order (asphalt, then markings), so a flat world needs
// no depth buffer.

import { ROAD_CLASSES, type RoadClass, type RoadGraph } from "./road-graph.ts";

export const SurfaceMaterial = { Asphalt: 0, Yellow: 1, White: 2, Fill: 3, Sidewalk: 4, Curb: 5 } as const;
export type SurfaceMaterial = (typeof SurfaceMaterial)[keyof typeof SurfaceMaterial];

export interface SurfaceMesh {
  positions: Float32Array;  // x, y, z interleaved, m (z from the graph: the ground along each centerline)
  dims: 3;
  material: Uint8Array;     // SurfaceMaterial per vertex
  indices: Uint32Array;     // triangles
}

interface Profile { laneWidth: number; shoulder: number; markings: boolean }

const P = (laneWidth: number, shoulder: number, markings: boolean): Profile => ({ laneWidth, shoulder, markings });
export const ROAD_PROFILES: Record<RoadClass, Profile> = {
  motorway: P(3.7, 2.5, true), motorway_link: P(3.7, 1.5, true),
  trunk: P(3.6, 1.5, true), trunk_link: P(3.6, 1.0, true),
  primary: P(3.4, 1.0, true), primary_link: P(3.4, 0.5, true),
  secondary: P(3.4, 1.0, true), secondary_link: P(3.4, 0.5, true),
  tertiary: P(3.3, 1.0, true), tertiary_link: P(3.3, 0.5, true),
  unclassified: P(3.0, 1.0, false), residential: P(3.0, 1.0, false), living_street: P(3.0, 0.5, false),
  service: P(2.8, 0.2, false), road: P(3.0, 0.5, false),
};
const PROFILES = ROAD_CLASSES.map((c) => ROAD_PROFILES[c]);

export const MARKING = {
  width: 0.12,           // m
  doubleGap: 0.18,       // between the two yellow lines, m
  dash: 3,               // US: 10 ft lines, 30 ft gaps
  gap: 9,
  intersectionClear: 1,  // extra distance markings stop short of a node disc, m
} as const;

export const SIDEWALK = {
  width: 1.8,  // m: 5 ft plus the curb
  curb: 0.15,  // m above the road
} as const;

const DISC_SEGMENTS = 16;
const MITER_LIMIT = 3;   // max miter length, × the offset (sharper joints are clipped; the node disc covers them)

export function edgeHalfWidth(g: RoadGraph, e: number): number {
  const p = PROFILES[g.edges.class[e]!]!;
  return ((g.edges.lanesFwd[e]! + g.edges.lanesBack[e]!) * p.laneWidth) / 2 + p.shoulder;
}

/** How far the road reaches left and right of its centerline (looking from → to), sidewalks included. */
export function edgeExtents(g: RoadGraph, e: number): [left: number, right: number] {
  const hw = edgeHalfWidth(g, e), s = g.edges.sidewalks[e]!;
  return [hw + (s & 1 ? SIDEWALK.width : 0), hw + (s & 2 ? SIDEWALK.width : 0)];
}

// --- growable typed buffers -------------------------------------------------

class MeshBuilder {
  private pos = new Float32Array(3 << 13);
  private mat = new Uint8Array(1 << 13);
  private idx = new Uint32Array(1 << 14);
  vertices = 0;
  private indexCount = 0;

  vertex(x: number, y: number, z: number, m: SurfaceMaterial): number {
    if (this.vertices === this.mat.length) {
      this.pos = grow(this.pos, this.pos.length * 2);
      this.mat = grow(this.mat, this.mat.length * 2);
    }
    this.pos[3 * this.vertices] = x;
    this.pos[3 * this.vertices + 1] = y;
    this.pos[3 * this.vertices + 2] = z;
    this.mat[this.vertices] = m;
    return this.vertices++;
  }

  triangle(a: number, b: number, c: number): void {
    if (this.indexCount + 3 > this.idx.length) this.idx = grow(this.idx, this.idx.length * 2);
    this.idx[this.indexCount++] = a;
    this.idx[this.indexCount++] = b;
    this.idx[this.indexCount++] = c;
  }

  finish(): SurfaceMesh {
    return {
      positions: this.pos.slice(0, 3 * this.vertices),
      dims: 3,
      material: this.mat.slice(0, this.vertices),
      indices: this.idx.slice(0, this.indexCount),
    };
  }
}

function grow<T extends Float32Array | Uint8Array | Uint32Array>(a: T, n: number): T {
  const b = new (a.constructor as new (n: number) => T)(n);
  b.set(a);
  return b;
}

// --- polylines ----------------------------------------------------------------

const S = 4;  // polyline stride
type Polyline = number[];  // x, y, z, drop interleaved; lengths and offsets are horizontal (x, y)

/** The edge's points, without consecutive duplicates. */
function edgePolyline(g: RoadGraph, e: number): Polyline {
  const out: Polyline = [];
  for (let p = g.edges.pointStart[e]!; p < g.edges.pointStart[e + 1]!; p++) {
    const x = g.points[2 * p]!, y = g.points[2 * p + 1]!;
    const n = out.length;
    if (n === 0 || Math.abs(x - out[n - S]!) > 1e-3 || Math.abs(y - out[n - S + 1]!) > 1e-3) out.push(x, y, g.pointZ[p]!, g.pointDrop[p]!);
  }
  return out;
}

function length(pl: Polyline): number {
  let s = 0;
  for (let i = S; i < pl.length; i += S) s += Math.hypot(pl[i]! - pl[i - S]!, pl[i + 1]! - pl[i - S + 1]!);
  return s;
}

/** The part of a polyline between arc lengths a and b (a < b). */
function slice(pl: Polyline, a: number, b: number): Polyline {
  const out: Polyline = [];
  let s = 0;
  const at = (i: number, t: number) => {
    for (let k = 0; k < S; k++) out.push(pl[i - S + k]! + (pl[i + k]! - pl[i - S + k]!) * t);
  };
  for (let i = S; i < pl.length; i += S) {
    const len = Math.hypot(pl[i]! - pl[i - S]!, pl[i + 1]! - pl[i - S + 1]!);
    const s1 = s + len;
    if (s1 > a && s < b) {
      if (out.length === 0) at(i, (a - s) / len);
      at(i, Math.min(1, (b - s) / len));
    }
    s = s1;
    if (s >= b) break;
  }
  return out;
}

/** Per point, the mitered right-hand offset direction (scaled so offsets are correct perpendicular to both segments). */
function miters(pl: Polyline): number[] {
  const n = pl.length / S, out: number[] = [];
  for (let i = 0; i < n; i++) {
    let nx = 0, ny = 0;
    for (const j of [i - 1, i]) {
      if (j < 0 || j >= n - 1) continue;
      const dx = pl[S * j + S]! - pl[S * j]!, dy = pl[S * j + S + 1]! - pl[S * j + 1]!;
      const len = Math.hypot(dx, dy);
      nx += dy / len;
      ny += -dx / len;
    }
    const nl = Math.hypot(nx, ny);
    let k = 1;
    if (i > 0 && i < n - 1) {
      const dx = pl[S * i + S]! - pl[S * i]!, dy = pl[S * i + S + 1]! - pl[S * i + 1]!;
      const cos = ((nx / nl) * dy - (ny / nl) * dx) / Math.hypot(dx, dy);
      k = Math.min(1 / Math.max(cos, 1e-6), MITER_LIMIT);
    }
    out.push((nx / nl) * k, (ny / nl) * k);
  }
  return out;
}

/**
 * A strip between offsets o0 and o1 (right positive) from the polyline, with
 * mitered joints, level across (both edges take the centerline's height). Two
 * vertices per point, two triangles per segment.
 */
function ribbon(m: MeshBuilder, pl: Polyline, o0: number, o1: number, mat: SurfaceMaterial, lift = 0): void {
  const n = pl.length / S;
  if (n < 2) return;
  const u = miters(pl);
  let prev = -1;
  for (let i = 0; i < n; i++) {
    const x = pl[S * i]!, y = pl[S * i + 1]!, z = pl[S * i + 2]! + lift, ux = u[2 * i]!, uy = u[2 * i + 1]!;
    const a = m.vertex(x + ux * o0, y + uy * o0, z, mat);
    const b = m.vertex(x + ux * o1, y + uy * o1, z, mat);
    if (prev >= 0) {
      m.triangle(prev, prev + 1, b);
      m.triangle(prev, b, a);
    }
    prev = a;
  }
}

/** Extra depth below the ground a fill skirt reaches, so it never stops short. */
const SKIRT_EXTRA = 0.3;

/**
 * Fill skirts: faces from the road's edges at offsets o0 and o1 straight down
 * by each point's drop (to below the lowest ground across the road there),
 * where the road sits above the ground.
 */
function skirts(m: MeshBuilder, pl: Polyline, ...offsets: number[]): void {
  const n = pl.length / S, u = miters(pl);
  for (let i = 0; i + 1 < n; i++) {
    const d0 = pl[S * i + 3]!, d1 = pl[S * i + S + 3]!;
    if (d0 <= 0 && d1 <= 0) continue;
    for (const o of offsets) {
      const p = (k: number, down: boolean) => m.vertex(
        pl[S * k]! + u[2 * k]! * o, pl[S * k + 1]! + u[2 * k + 1]! * o,
        pl[S * k + 2]! - (down ? pl[S * k + 3]! + SKIRT_EXTRA : 0), SurfaceMaterial.Fill);
      const a = p(i, false), b = p(i + 1, false), c = p(i + 1, true), d = p(i, true);
      m.triangle(a, b, c);
      m.triangle(a, c, d);
    }
  }
}

/**
 * A vertical face at offset o from `top` above the polyline down to `bottom`
 * (both relative to each point's height; bottom may follow the point's drop).
 */
function face(m: MeshBuilder, pl: Polyline, o: number, top: number, bottom: (drop: number) => number, mat: SurfaceMaterial): void {
  const n = pl.length / S, u = miters(pl);
  for (let i = 0; i + 1 < n; i++) {
    const p = (k: number, z: number) => m.vertex(pl[S * k]! + u[2 * k]! * o, pl[S * k + 1]! + u[2 * k + 1]! * o, pl[S * k + 2]! + z, mat);
    const a = p(i, top), b = p(i + 1, top), c = p(i + 1, bottom(pl[S * i + S + 3]!)), d = p(i, bottom(pl[S * i + 3]!));
    m.triangle(a, b, c);
    m.triangle(a, c, d);
  }
}

function disc(m: MeshBuilder, x: number, y: number, z: number, r: number, drop: number): void {
  const c = m.vertex(x, y, z, SurfaceMaterial.Asphalt);
  for (let i = 0; i < DISC_SEGMENTS; i++) {
    const t = (2 * Math.PI * i) / DISC_SEGMENTS;
    m.vertex(x + r * Math.cos(t), y + r * Math.sin(t), z, SurfaceMaterial.Asphalt);
  }
  for (let i = 0; i < DISC_SEGMENTS; i++) m.triangle(c, c + 1 + i, c + 1 + ((i + 1) % DISC_SEGMENTS));
  if (drop <= 0) return;
  // A fill skirt around the rim.
  const top = m.vertices;
  for (let i = 0; i < DISC_SEGMENTS; i++) {
    const t = (2 * Math.PI * i) / DISC_SEGMENTS, rx = x + r * Math.cos(t), ry = y + r * Math.sin(t);
    m.vertex(rx, ry, z, SurfaceMaterial.Fill);
    m.vertex(rx, ry, z - drop - SKIRT_EXTRA, SurfaceMaterial.Fill);
  }
  for (let i = 0; i < DISC_SEGMENTS; i++) {
    const a = top + 2 * i, b = top + 2 * ((i + 1) % DISC_SEGMENTS);
    m.triangle(a, b, b + 1);
    m.triangle(a, b + 1, a + 1);
  }
}

// --- the operator -------------------------------------------------------------

/** Per node: the widest half width of its incident edges (the intersection disc radius). */
export function nodeRadii(g: RoadGraph): Float32Array {
  const r = new Float32Array(g.nodes.count);
  for (let e = 0; e < g.edges.count; e++) {
    const hw = edgeHalfWidth(g, e);
    for (const n of [g.edges.from[e]!, g.edges.to[e]!]) if (hw > r[n]!) r[n] = hw;
  }
  return r;
}

export function roadSurfaceMesh(g: RoadGraph): SurfaceMesh {
  const m = new MeshBuilder();
  const radius = nodeRadii(g);
  const degree = (n: number) => g.nodes.edgeStart[n + 1]! - g.nodes.edgeStart[n]!;
  const lines: Polyline[] = [];

  for (let n = 0; n < g.nodes.count; n++) disc(m, g.nodes.x[n]!, g.nodes.y[n]!, g.nodes.z[n]!, radius[n]!, g.nodes.drop[n]!);

  for (let e = 0; e < g.edges.count; e++) {
    const pl = edgePolyline(g, e);
    if (pl.length < 2 * S) continue;
    lines[e] = pl;
    const hw = edgeHalfWidth(g, e), walks = g.edges.sidewalks[e]!;
    ribbon(m, pl, -hw, hw, SurfaceMaterial.Asphalt);
    // Fill skirts hang from the road's edges, or from the sidewalks' outer edges where there are sidewalks.
    skirts(m, pl, ...(walks & 1 ? [] : [-hw]), ...(walks & 2 ? [] : [hw]));
    if (!walks) continue;
    // Sidewalks: from the disc's edge to the disc's edge, through plain joints.
    const clear = (n: number) => (degree(n) === 2 ? 0 : radius[n]!);
    const a = clear(g.edges.from[e]!), b = length(pl) - clear(g.edges.to[e]!);
    if (b - a < 0.5) continue;
    const run = slice(pl, a, b), w = SIDEWALK.width, curb = SIDEWALK.curb;
    for (const [bit, side] of [[1, -1], [2, 1]] as const) {
      if (!(walks & bit)) continue;
      const [inner, outer] = [side * hw, side * (hw + w)];
      ribbon(m, run, Math.min(inner, outer), Math.max(inner, outer), SurfaceMaterial.Sidewalk, curb);
      face(m, run, inner, curb, () => 0, SurfaceMaterial.Curb);
      face(m, run, outer, curb, (drop) => -Math.max(0, drop) - SKIRT_EXTRA, SurfaceMaterial.Curb);
    }
  }

  for (let e = 0; e < g.edges.count; e++) {
    const pl = lines[e];
    const profile = PROFILES[g.edges.class[e]!]!;
    if (!pl || !profile.markings) continue;

    // Stop short of intersections and dead ends; run through plain joints (degree 2).
    const clear = (n: number) => (degree(n) === 2 ? 0 : radius[n]! + MARKING.intersectionClear);
    const a = clear(g.edges.from[e]!);
    const b = length(pl) - clear(g.edges.to[e]!);
    if (b - a < MARKING.dash) continue;
    const run = slice(pl, a, b);

    const fwd = g.edges.lanesFwd[e]!, back = g.edges.lanesBack[e]!, lw = profile.laneWidth;
    const c = ((back - fwd) * lw) / 2;
    const w = MARKING.width, gap = MARKING.doubleGap / 2;
    if (back > 0) {
      ribbon(m, run, c - gap - w, c - gap, SurfaceMaterial.Yellow);
      ribbon(m, run, c + gap, c + gap + w, SurfaceMaterial.Yellow);
    }
    const dividers: number[] = [];
    for (let i = 1; i < fwd; i++) dividers.push(c + i * lw);
    for (let i = 1; i < back; i++) dividers.push(c - i * lw);
    for (const o of dividers) {
      for (let s = 0; s + MARKING.dash <= b - a; s += MARKING.dash + MARKING.gap) {
        ribbon(m, slice(run, s, s + MARKING.dash), o - w / 2, o + w / 2, SurfaceMaterial.White);
      }
    }
  }

  return m.finish();
}
