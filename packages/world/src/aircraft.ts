// Aircraft (decision 31): generated low-poly models, cartoony like the Car
// Kit, and live ADS-B reports turned into what the renderer needs. Pure.
//
// Models are generic kinds (a narrow-body twin, a regional jet with its
// engines at the tail, …), never replicas of real types, sized like typical
// members of the kind. Each kind comes in TAIL_COLORS variants; an airline's
// planes (callsign prefix) all get the same one. Real liveries are trademarks.
//
// Models face +y, with z up and the wheels (or skids) on z = 0, in meters.
// Colors are swatches in AIRCRAFT_PALETTE, a 16 × 1 texture the uvs point at.

import type { ModelMesh } from "./glb.ts";

export const AIRCRAFT_KINDS = [
  "narrowbody", "widebody", "quad", "regional", "bizjet", "turboprop", "light", "helicopter",
] as const;
export type AircraftKind = (typeof AIRCRAFT_KINDS)[number];
export const TAIL_COLORS = 8;

// --- palette ------------------------------------------------------------------

const SWATCH = { body: 0, wing: 1, engine: 2, glass: 3, rotor: 4, tail: 5 } as const;
const PALETTE = [
  "#f4f4f0", "#c9ccd2", "#4a4e57", "#2c3e5c", "#26282c",
  // tails
  "#d23c3c", "#2f6fd6", "#f2b230", "#2fa36b", "#7b4fc9", "#e0702a", "#1b9fb5", "#3a3f4a",
];
const PALETTE_SIZE = 16;

/** RGBA, 16 × 1: the texture the models' uvs point at. */
export const AIRCRAFT_PALETTE: Uint8Array = (() => {
  const out = new Uint8Array(4 * PALETTE_SIZE);
  PALETTE.forEach((hex, i) => {
    for (let c = 0; c < 3; c++) out[4 * i + c] = parseInt(hex.slice(1 + 2 * c, 3 + 2 * c), 16);
    out[4 * i + 3] = 255;
  });
  return out;
})();

// --- mesh building ------------------------------------------------------------

type V3 = [number, number, number];

/** Flat-shaded triangles: three vertices each, one swatch per face (of a 16-swatch palette). */
export class Builder {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];

  tri(a: V3, b: V3, c: V3, swatch: number): void {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-9) return;
    nx /= l; ny /= l; nz /= l;
    const u = (swatch + 0.5) / PALETTE_SIZE;
    for (const p of [a, b, c]) {
      this.pos.push(...p);
      this.nrm.push(nx, ny, nz);
      this.uv.push(u, 0.5);
    }
  }

  quad(a: V3, b: V3, c: V3, d: V3, swatch: number): void {
    this.tri(a, b, c, swatch);
    this.tri(a, c, d, swatch);
  }

  /** A six-faced solid from its bottom ring (b0..b3) and top ring (t0..t3), corners matching. */
  hexa(b: V3[], t: V3[], swatch: number): void {
    this.quad(b[0]!, b[1]!, b[2]!, b[3]!, swatch);
    this.quad(t[0]!, t[1]!, t[2]!, t[3]!, swatch);
    for (let k = 0; k < 4; k++) {
      const j = (k + 1) % 4;
      this.quad(b[k]!, b[j]!, t[j]!, t[k]!, swatch);
    }
  }

  /**
   * A body of revolution-ish along y: rings at y with half-widths (rx, rz)
   * around (x, z), `sides` around. A ring of size 0 closes the end to a point;
   * otherwise ends are capped flat.
   */
  loft(rings: { y: number; x?: number; z: number; rx: number; rz: number; swatch?: number }[], sides: number, swatch: number): void {
    const ring = (r: (typeof rings)[number]) => Array.from({ length: sides }, (_, k): V3 => {
      const a = (2 * Math.PI * (k + 0.5)) / sides;
      return [(r.x ?? 0) + r.rx * Math.cos(a), r.y, r.z + r.rz * Math.sin(a)];
    });
    const pts = rings.map(ring);
    for (let i = 0; i + 1 < rings.length; i++) {
      const s = rings[i]!.swatch ?? swatch;
      for (let k = 0; k < sides; k++) {
        const j = (k + 1) % sides;
        this.quad(pts[i]![k]!, pts[i]![j]!, pts[i + 1]![j]!, pts[i + 1]![k]!, s);
      }
    }
    for (const [i, r] of [[0, rings[0]!], [rings.length - 1, rings.at(-1)!]] as const) {
      if (r.rx === 0 && r.rz === 0) continue;
      const c: V3 = [r.x ?? 0, r.y, r.z];
      for (let k = 0; k < sides; k++) this.tri(c, pts[i]![k]!, pts[i]![(k + 1) % sides]!, swatch);
    }
  }

  /**
   * A flat tapered panel (wing, stabilizer), mirrored to both sides: the root
   * chord from y = rootFront back by rootChord at x = x0, the tip at x = x0 +
   * span swept back by `sweep` with tipChord, thickness t at height z (the tip
   * raised by `dihedral`).
   */
  panel(o: { x0: number; span: number; rootFront: number; rootChord: number; tipChord: number; sweep: number; z: number; t: number; dihedral?: number }, swatch: number): void {
    for (const side of [1, -1]) {
      const xr = side * o.x0, xt = side * (o.x0 + o.span), zt = o.z + (o.dihedral ?? 0);
      const yf = o.rootFront, yb = o.rootFront - o.rootChord, tf = o.rootFront - o.sweep, tb = tf - o.tipChord;
      const h = o.t / 2, ht = h * 0.6;
      this.hexa(
        [[xr, yf, o.z - h], [xt, tf, zt - ht], [xt, tb, zt - ht], [xr, yb, o.z - h]],
        [[xr, yf, o.z + h], [xt, tf, zt + ht], [xt, tb, zt + ht], [xr, yb, o.z + h]],
        swatch,
      );
    }
  }

  /** A vertical fin: root chord at z0 from yFront back, the top at z0 + height swept back. */
  fin(o: { yFront: number; rootChord: number; tipChord: number; sweep: number; z0: number; height: number; t: number }, swatch: number): void {
    const h = o.t / 2, top = o.z0 + o.height, tf = o.yFront - o.sweep;
    this.hexa(
      [[-h, o.yFront, o.z0], [-h, o.yFront - o.rootChord, o.z0], [-h * 0.6, tf - o.tipChord, top], [-h * 0.6, tf, top]],
      [[h, o.yFront, o.z0], [h, o.yFront - o.rootChord, o.z0], [h * 0.6, tf - o.tipChord, top], [h * 0.6, tf, top]],
      swatch,
    );
  }

  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, swatch: number): void {
    this.hexa([[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], swatch);
  }

  mesh(): ModelMesh {
    return {
      positions: Float32Array.from(this.pos), normals: Float32Array.from(this.nrm), uvs: Float32Array.from(this.uv),
      indices: Uint32Array.from({ length: this.pos.length / 3 }, (_, i) => i),
    };
  }
}

/** A fuselage of length L and radius R along y (centered), its belly at z = zb: nose cone, cockpit glass, tail cone. */
function fuselage(b: Builder, L: number, R: number, zb: number, sides = 8): void {
  const z = zb + R, y0 = -L / 2, y1 = L / 2;
  b.loft([
    { y: y0, z: z + R * 0.55, rx: R * 0.15, rz: R * 0.15 },
    { y: y0 + L * 0.22, z: z + R * 0.1, rx: R, rz: R * 0.95 },
    { y: y1 - L * 0.14, z, rx: R, rz: R },
    { y: y1 - L * 0.07, z: z - R * 0.05, rx: R * 0.85, rz: R * 0.8, swatch: SWATCH.glass },
    { y: y1 - L * 0.03, z: z - R * 0.2, rx: R * 0.55, rz: R * 0.5 },
    { y: y1, z: z - R * 0.3, rx: 0, rz: 0 },
  ], sides, SWATCH.body);
}

/** A jet engine nacelle centered at (x, y, z), pointing +y. */
function nacelle(b: Builder, x: number, y: number, z: number, r: number, len: number): void {
  b.loft([
    { y: y - len / 2, x, z, rx: r * 0.7, rz: r * 0.7 },
    { y: y + len / 2 - len * 0.15, x, z, rx: r, rz: r },
    { y: y + len / 2, x, z, rx: r * 0.9, rz: r * 0.9 },
  ], 6, SWATCH.engine);
}

/** Landing gear posts under (x, y) from z = 0 up to `top`. */
function gear(b: Builder, legs: [number, number][], top: number, w: number): void {
  for (const [x, y] of legs) b.box(x - w, x + w, y - w * 1.6, y + w * 1.6, 0, top, SWATCH.engine);
}

interface JetShape {
  L: number; R: number; span: number; sweep: number; rootChord: number; tipChord: number;
  wingAt: number;          // y of the wing root's leading edge, as a fraction of L forward of center
  engines: "wing2" | "wing4" | "tail2";
  tTail: boolean;
  gearH: number;
}

function jet(s: JetShape, tail: number): ModelMesh {
  const b = new Builder();
  const zb = s.gearH, zc = zb + s.R;
  fuselage(b, s.L, s.R, zb, s.L > 50 ? 10 : 8);
  const wingFront = s.wingAt * s.L, wingZ = s.engines === "tail2" ? zb + s.R * 0.45 : zb + s.R * 0.35;
  b.panel({
    x0: s.R * 0.8, span: s.span / 2 - s.R * 0.8, rootFront: wingFront, rootChord: s.rootChord, tipChord: s.tipChord,
    sweep: s.sweep, z: wingZ, t: s.R * 0.25, dihedral: s.span * 0.03,
  }, SWATCH.wing);
  // Tail: fin and stabilizers.
  const finH = s.R * 2.6, finFront = -s.L / 2 + s.L * 0.16;
  b.fin({ yFront: finFront, rootChord: s.L * 0.14, tipChord: s.L * 0.06, sweep: s.L * 0.08, z0: zc + s.R * 0.6, height: finH, t: s.R * 0.18 }, SWATCH.tail + tail);
  const stabZ = s.tTail ? zc + s.R * 0.6 + finH : zc + s.R * 0.3;
  const stabFront = s.tTail ? finFront - s.L * 0.08 : finFront + s.L * 0.02;
  b.panel({
    x0: s.tTail ? 0 : s.R * 0.5, span: s.span * 0.17, rootFront: stabFront, rootChord: s.L * 0.08, tipChord: s.L * 0.035,
    sweep: s.L * 0.05, z: stabZ, t: s.R * 0.12,
  }, s.tTail ? SWATCH.tail + tail : SWATCH.wing);
  // Engines.
  const er = s.R * (s.engines === "tail2" ? 0.42 : 0.5), el = s.R * 2.4;
  if (s.engines === "tail2") {
    for (const side of [1, -1]) nacelle(b, side * s.R * 1.55, -s.L / 2 + s.L * 0.27, zc + s.R * 0.35, er, el);
  } else {
    const xs = s.engines === "wing4" ? [0.34, 0.62] : [0.36];
    for (const f of xs) {
      for (const side of [1, -1]) {
        const x = side * (s.R * 0.8 + (s.span / 2 - s.R * 0.8) * f);
        // Slung under the wing, but clear of the ground.
        nacelle(b, x, wingFront - s.sweep * f * 1.0 + el * 0.25, Math.max(wingZ - er * 1.1, er + 0.3), er, el);
      }
    }
  }
  gear(b, [[0, s.L * 0.36], [s.R * 0.8, wingFront - s.rootChord * 0.6], [-s.R * 0.8, wingFront - s.rootChord * 0.6]], zb + 0.2, s.R * 0.12);
  return b.mesh();
}

/** A propeller: two thin crossed blades at (x, y, z), spinning about y. */
function propeller(b: Builder, x: number, y: number, z: number, r: number): void {
  const w = r * 0.12, t = r * 0.04;
  b.box(x - r, x + r, y - t, y + t, z - w, z + w, SWATCH.rotor);
  b.box(x - w, x + w, y - t, y + t, z - r, z + r, SWATCH.rotor);
}

function turboprop(tail: number): ModelMesh {
  const b = new Builder();
  const L = 25, R = 1.35, zb = 1.1, span = 27;
  fuselage(b, L, R, zb);
  const wingZ = zb + 2 * R - 0.15;  // high wing
  b.panel({ x0: R * 0.6, span: span / 2 - R * 0.6, rootFront: 1.5, rootChord: 2.6, tipChord: 1.5, sweep: 0.4, z: wingZ, t: 0.35 }, SWATCH.wing);
  b.fin({ yFront: -L / 2 + 4.5, rootChord: 4, tipChord: 2, sweep: 2.2, z0: zb + R * 1.6, height: 4.2, t: 0.3 }, SWATCH.tail + tail);
  b.panel({ x0: 0.3, span: 4.2, rootFront: -L / 2 + 3, rootChord: 2.2, tipChord: 1.2, sweep: 0.5, z: zb + R * 1.6, t: 0.2 }, SWATCH.wing);
  for (const side of [1, -1]) {
    const x = side * 4.1;
    b.loft([
      { y: -2, x, z: wingZ - 0.5, rx: 0.4, rz: 0.4 },
      { y: 2.8, x, z: wingZ - 0.5, rx: 0.65, rz: 0.75 },
      { y: 4.4, x, z: wingZ - 0.5, rx: 0.25, rz: 0.25 },
    ], 6, SWATCH.engine);
    propeller(b, x, 4.5, wingZ - 0.5, 1.9);
  }
  gear(b, [[0, L * 0.38], [1.6, 0], [-1.6, 0]], zb + 0.2, 0.18);
  return b.mesh();
}

function light(tail: number): ModelMesh {
  const b = new Builder();
  const L = 8.2, zb = 0.75;
  // A boxier cabin than the airliners: wide, tapering to the tail.
  b.loft([
    { y: -L / 2, z: zb + 0.75, rx: 0.08, rz: 0.12 },
    { y: -0.6, z: zb + 0.6, rx: 0.5, rz: 0.5 },
    { y: 1.0, z: zb + 0.65, rx: 0.6, rz: 0.65, swatch: SWATCH.glass },
    { y: 2.4, z: zb + 0.5, rx: 0.55, rz: 0.5 },
    { y: L / 2 - 0.3, z: zb + 0.45, rx: 0.35, rz: 0.35 },
    { y: L / 2, z: zb + 0.45, rx: 0.12, rz: 0.12 },
  ], 6, SWATCH.body);
  b.panel({ x0: 0.5, span: 5.0, rootFront: 1.7, rootChord: 1.5, tipChord: 1.3, sweep: 0, z: zb + 1.3, t: 0.15, dihedral: 0.15 }, SWATCH.body);
  b.fin({ yFront: -L / 2 + 1.5, rootChord: 1.5, tipChord: 0.8, sweep: 0.9, z0: zb + 0.8, height: 1.3, t: 0.12 }, SWATCH.tail + tail);
  b.panel({ x0: 0.1, span: 1.6, rootFront: -L / 2 + 1.2, rootChord: 1.0, tipChord: 0.7, sweep: 0.2, z: zb + 0.75, t: 0.08 }, SWATCH.tail + tail);
  propeller(b, 0, L / 2 + 0.05, zb + 0.45, 0.95);
  gear(b, [[0, L / 2 - 0.9], [1.1, 0.8], [-1.1, 0.8]], zb + 0.1, 0.07);
  return b.mesh();
}

function helicopter(tail: number): ModelMesh {
  const b = new Builder();
  const zb = 0.6;
  b.loft([
    { y: -1.8, z: zb + 0.9, rx: 0.5, rz: 0.55 },
    { y: 0.6, z: zb + 0.85, rx: 0.9, rz: 0.85, swatch: SWATCH.tail + tail },
    { y: 2.0, z: zb + 0.7, rx: 0.75, rz: 0.7, swatch: SWATCH.glass },
    { y: 2.6, z: zb + 0.55, rx: 0.1, rz: 0.1 },
  ], 8, SWATCH.tail + tail);
  // Tail boom, fin and tail rotor.
  b.loft([
    { y: -1.7, z: zb + 1.1, rx: 0.3, rz: 0.3 },
    { y: -7.5, z: zb + 1.35, rx: 0.12, rz: 0.14 },
  ], 6, SWATCH.tail + tail);
  b.fin({ yFront: -6.8, rootChord: 0.9, tipChord: 0.5, sweep: 0.5, z0: zb + 1.3, height: 1.2, t: 0.1 }, SWATCH.tail + tail);
  b.box(0.12, 0.16, -7.6, -7.4, zb + 0.9, zb + 2.1, SWATCH.rotor);
  b.box(0.12, 0.16, -8.1, -6.9, zb + 1.45, zb + 1.55, SWATCH.rotor);
  // Mast and main rotor (two crossed blades).
  b.box(-0.1, 0.1, 0.2, 0.4, zb + 1.7, zb + 2.0, SWATCH.engine);
  const rr = 5.5, w = 0.18, t = 0.04, zr = zb + 2.0;
  b.box(-rr, rr, 0.3 - w, 0.3 + w, zr - t, zr + t, SWATCH.rotor);
  b.box(-w, w, 0.3 - rr, 0.3 + rr, zr - t, zr + t, SWATCH.rotor);
  // Skids.
  for (const side of [1, -1]) {
    b.box(side * 0.95 - 0.06, side * 0.95 + 0.06, -1.6, 1.9, 0, 0.1, SWATCH.engine);
    for (const y of [-0.9, 1.1]) b.box(side * 0.8 - 0.05, side * 0.8 + 0.05, y - 0.05, y + 0.05, 0.1, zb + 0.4, SWATCH.engine);
  }
  return b.mesh();
}

const JETS: Partial<Record<AircraftKind, JetShape>> = {
  narrowbody: { L: 38, R: 2.0, span: 35, sweep: 7, rootChord: 6.5, tipChord: 1.6, wingAt: 0.1, engines: "wing2", tTail: false, gearH: 1.0 },
  widebody: { L: 64, R: 3.0, span: 60, sweep: 12, rootChord: 11, tipChord: 2.4, wingAt: 0.1, engines: "wing2", tTail: false, gearH: 1.6 },
  quad: { L: 70, R: 3.2, span: 65, sweep: 14, rootChord: 13, tipChord: 2.6, wingAt: 0.12, engines: "wing4", tTail: false, gearH: 1.7 },
  regional: { L: 32, R: 1.4, span: 24, sweep: 5, rootChord: 4.5, tipChord: 1.3, wingAt: 0.02, engines: "tail2", tTail: true, gearH: 0.8 },
  bizjet: { L: 20, R: 1.15, span: 19, sweep: 3.5, rootChord: 3.5, tipChord: 1.0, wingAt: -0.02, engines: "tail2", tTail: true, gearH: 0.6 },
};

/** The model of an aircraft kind with its tail in color `tail` (0 ≤ tail < TAIL_COLORS). */
export function aircraftMesh(kind: AircraftKind, tail: number): ModelMesh {
  const shape = JETS[kind];
  if (shape) return jet(shape, tail);
  if (kind === "turboprop") return turboprop(tail);
  if (kind === "light") return light(tail);
  return helicopter(tail);
}

/** Every model, indexed kind × TAIL_COLORS + tail (what aircraftModel returns). */
export const aircraftMeshes = (): ModelMesh[] =>
  AIRCRAFT_KINDS.flatMap((k) => Array.from({ length: TAIL_COLORS }, (_, t) => aircraftMesh(k, t)));

// --- kinds from ADS-B ---------------------------------------------------------

// ICAO type designators (Doc 8643) by kind, as prefixes ("=": the whole designator). Checked in
// order; the first match wins.
const TYPE_PREFIXES: [AircraftKind, string[]][] = [
  ["quad", ["B74", "A38", "A34", "A124", "=C17", "B52", "C5M"]],
  ["widebody", ["B76", "B77", "B78", "A30", "A310", "A33", "A35", "MD11", "DC10", "KC10", "IL96"]],
  ["regional", ["CRJ", "E135", "E145", "E35L", "E45X", "F70", "F100", "MD8", "MD9", "B712", "DC9"]],
  ["bizjet", [
    "GLF", "GL5T", "GL6T", "GL7T", "GLEX", "CL30", "CL35", "CL60", "C25", "C500", "C501", "C510", "C525", "C55", "C56",
    "C650", "C68", "C700", "C750", "LJ", "F2TH", "F900", "FA", "E50P", "E55P", "HDJT", "PRM1", "H25", "BE40", "G280",
    "G150", "G200", "ASTR", "PC24", "SF50", "EA50",
  ]],
  ["turboprop", [
    "AT4", "AT7", "DH8", "SW4", "SF34", "B190", "BE20", "BE30", "BE9", "B350", "PC12", "C208", "DHC6", "KODI", "TBM",
    "PAY", "P180", "C441", "E120", "JS3", "JS4", "SH36", "AN2",
  ]],
  ["helicopter", [
    "EC", "AS3", "AS5", "AS6", "H1", "H6", "B06", "B407", "B412", "B429", "B505", "R22", "R44", "R66", "A109", "A119",
    "A139", "A169", "S76", "S92", "MD5", "MD6", "H47", "H60", "UH1", "BK17",
  ]],
  ["light", ["C1", "C2", "P28", "PA", "SR2", "DA4", "DA2", "BE3", "BE5", "M20", "RV", "C82", "AA5", "GLAS", "CH7"]],
];

/** ADS-B emitter category → kind, where the type is unknown. Surface vehicles (C*) are not aircraft. */
const CATEGORY_KIND: Record<string, AircraftKind> = {
  A1: "light", A2: "bizjet", A3: "narrowbody", A4: "narrowbody", A5: "widebody", A6: "bizjet", A7: "helicopter",
  B1: "light", B4: "light", B6: "light",
};

/** The model kind for an ICAO type designator and ADS-B category; undefined for things that aren't aircraft. */
export function aircraftKind(type: string | undefined, category: string | undefined): AircraftKind | undefined {
  if (category?.startsWith("C")) return undefined;  // ground vehicles, obstacles
  const matches = (p: string) => (p.startsWith("=") ? type === p.slice(1) : type!.startsWith(p));
  if (type) for (const [kind, prefixes] of TYPE_PREFIXES) if (prefixes.some(matches)) return kind;
  if (category && CATEGORY_KIND[category]) return CATEGORY_KIND[category];
  return type ? "narrowbody" : category === "A0" || !category ? "light" : undefined;
}

/** The tail color for a callsign: one per airline (its three-letter ICAO prefix), else per aircraft. */
export function tailColor(callsign: string | undefined, hex: string): number {
  const key = callsign && /^[A-Z]{3}\d/.test(callsign) ? callsign.slice(0, 3) : hex;
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return (h >>> 0) % TAIL_COLORS;
}

// --- reports ------------------------------------------------------------------

/** One aircraft's latest ADS-B report, in SI units. */
export interface AircraftReport {
  id: string;        // ICAO 24-bit address, hex
  callsign: string | undefined;
  model: number;     // index into aircraftMeshes()
  lat: number;
  lon: number;
  h: number | undefined;  // m above the WGS84 ellipsoid; undefined on the ground
  ground: boolean;
  speed: number;     // m/s over the ground
  track: number | undefined;  // radians clockwise from north
  climb: number;     // m/s
  age: number;       // s since the position was received, when the report was made
}

const FT = 0.3048, KT = 1852 / 3600, FPM = FT / 60;

/** readsb-style aircraft JSON (adsb.fi, adsb.lol, airplanes.live, a local readsb) → reports; skips what isn't a positioned aircraft. */
export function parseAircraft(json: { ac?: Record<string, unknown>[] }): AircraftReport[] {
  const ac = json.ac ?? [];
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  // Barometric altitude is against standard pressure, not the ellipsoid: correct it by the mean
  // difference seen on aircraft reporting both (today's pressure and the geoid, around here).
  let sum = 0, n = 0;
  for (const a of ac) {
    const g = num(a.alt_geom), b = num(a.alt_baro);
    if (g !== undefined && b !== undefined) { sum += g - b; n++; }
  }
  const baroToGeom = n > 0 ? sum / n : 0;
  const out: AircraftReport[] = [];
  for (const a of ac) {
    const lat = num(a.lat), lon = num(a.lon), hex = typeof a.hex === "string" ? a.hex : undefined;
    if (lat === undefined || lon === undefined || !hex) continue;
    const type = typeof a.t === "string" ? a.t : undefined, category = typeof a.category === "string" ? a.category : undefined;
    const kind = aircraftKind(type, category);
    if (!kind) continue;
    const callsign = typeof a.flight === "string" ? a.flight.trim() || undefined : undefined;
    const ground = a.alt_baro === "ground";
    const geom = num(a.alt_geom), baro = num(a.alt_baro);
    const h = ground ? undefined : geom !== undefined ? geom * FT : baro !== undefined ? (baro + baroToGeom) * FT : undefined;
    if (!ground && h === undefined) continue;
    const trackDeg = num(a.track) ?? num(a.true_heading) ?? num(a.mag_heading);
    out.push({
      id: hex, callsign, model: AIRCRAFT_KINDS.indexOf(kind) * TAIL_COLORS + tailColor(callsign, hex),
      lat, lon, h, ground,
      speed: (num(a.gs) ?? 0) * KT,
      track: trackDeg === undefined ? undefined : (trackDeg * Math.PI) / 180,
      climb: ground ? 0 : (num(a.geom_rate) ?? num(a.baro_rate) ?? 0) * FPM,
      age: num(a.seen_pos) ?? num(a.seen) ?? 0,
    });
  }
  return out;
}
