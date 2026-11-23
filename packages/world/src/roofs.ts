// Pitched roofs (gabled, hipped, pyramidal) on a footprint, procedurally. The
// roof is fitted to the footprint's smallest bounding rectangle: its long axis
// is the ridge's direction. Each roof face is a plane rising from one side (or
// end) of the rectangle at the pitch, and the roof is the lowest of them at
// every point: a gabled roof has two (the long sides), a hipped one four (the
// ends too), a pyramidal one is hipped on a square. Where a face is lowest is
// a convex region of the rectangle, so a face is the footprint clipped to it.
// Pure and deterministic, like every operator.

/** Steepest pitch: 30°. Wide buildings get flatter roofs so the ridge stays under MAX_RISE. */
const PITCH = Math.tan((30 * Math.PI) / 180);
const MAX_RISE = 4;

export type RoofShape = "gabled" | "hipped" | "pyramidal";

/** A face: where it's the roof (a convex polygon, x y interleaved, CCW) and its height above the eaves: gx·x + gy·y + c. */
export interface RoofFace { region: number[]; gx: number; gy: number; c: number }

export interface PitchedRoof {
  faces: RoofFace[];
  /** Height above the eaves at a point (the lowest face; 0 outside the rectangle's footprint). */
  rise(x: number, y: number): number;
  /** Where along the segment (0..1, exclusive) the roof changes face: the outline needs a vertex there. */
  breaks(x0: number, y0: number, x1: number, y1: number): number[];
}

/** The roof over a footprint ring (points x y interleaved from `a` to `e`, CCW). */
export function pitchedRoof(points: ArrayLike<number>, a: number, e: number, shape: RoofShape): PitchedRoof {
  const { cx, cy, ux, uy, l, w } = boundingRectangle(points, a, e);
  // The long axis u (half length l ≥ w), the short axis v.
  const vx = -uy, vy = ux;
  const s = Math.min(PITCH, MAX_RISE / Math.max(w, 1e-6));
  // A plane at the pitch rising from the line at `d` along `axis` (unit), toward the center: s·(d − axis·(p − c)).
  const plane = (ax: number, ay: number, d: number) => ({ gx: -s * ax, gy: -s * ay, c: s * (d + ax * cx + ay * cy) });
  const planes = [plane(vx, vy, w), plane(-vx, -vy, w)];
  if (shape !== "gabled") planes.push(plane(ux, uy, l), plane(-ux, -uy, l));
  const at = (k: number, x: number, y: number) => planes[k]!.gx * x + planes[k]!.gy * y + planes[k]!.c;

  // Each face's region: the rectangle where its plane is the lowest (half-planes clipping the rectangle).
  const rect = [
    cx - ux * l - vx * w, cy - uy * l - vy * w, cx + ux * l - vx * w, cy + uy * l - vy * w,
    cx + ux * l + vx * w, cy + uy * l + vy * w, cx - ux * l + vx * w, cy - uy * l + vy * w,
  ];
  const faces = planes.map((p, k) => {
    let region = rect;
    for (let j = 0; j < planes.length; j++) {
      if (j !== k) region = clipConvex(region, (x, y) => at(j, x, y) - at(k, x, y));
    }
    return { region, ...p };
  }).filter((f) => f.region.length >= 6);

  return {
    faces,
    rise: (x, y) => Math.max(0, Math.min(...planes.map((_, k) => at(k, x, y)))),
    breaks(x0, y0, x1, y1) {
      const ts: number[] = [];
      for (let i = 0; i < planes.length; i++) {
        for (let j = i + 1; j < planes.length; j++) {
          const f0 = at(i, x0, y0) - at(j, x0, y0), f1 = at(i, x1, y1) - at(j, x1, y1);
          if ((f0 < 0 && f1 > 0) || (f0 > 0 && f1 < 0)) ts.push(f0 / (f0 - f1));
        }
      }
      return ts.sort((p, q) => p - q);
    },
  };
}

/** The part of a polygon (x y interleaved) where f ≥ 0, for f linear: Sutherland–Hodgman against one line. */
export function clipConvex(poly: number[], f: (x: number, y: number) => number): number[] {
  const out: number[] = [];
  const n = poly.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const [px, py, qx, qy] = [poly[2 * i]!, poly[2 * i + 1]!, poly[2 * j]!, poly[2 * j + 1]!];
    const fp = f(px, py), fq = f(qx, qy);
    if (fp >= 0) out.push(px, py);
    if ((fp >= 0) !== (fq >= 0)) {
      const t = fp / (fp - fq);
      out.push(px + t * (qx - px), py + t * (qy - py));
    }
  }
  return out;
}

/** The smallest-area rectangle around a ring, with a side along one of its edges: center, long axis (unit), half sizes. */
function boundingRectangle(points: ArrayLike<number>, a: number, e: number) {
  let best = { area: Infinity, cx: 0, cy: 0, ux: 1, uy: 0, l: 0, w: 0 };
  for (let i = a; i < e; i++) {
    const j = i + 1 < e ? i + 1 : a;
    let dx = points[2 * j]! - points[2 * i]!, dy = points[2 * j + 1]! - points[2 * i + 1]!;
    const len = Math.hypot(dx, dy);
    if (len === 0) continue;
    [dx, dy] = [dx / len, dy / len];
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let k = a; k < e; k++) {
      const x = points[2 * k]!, y = points[2 * k + 1]!;
      const u = x * dx + y * dy, v = -x * dy + y * dx;
      [u0, u1, v0, v1] = [Math.min(u0, u), Math.max(u1, u), Math.min(v0, v), Math.max(v1, v)];
    }
    const area = (u1 - u0) * (v1 - v0);
    if (area >= best.area) continue;
    const um = (u0 + u1) / 2, vm = (v0 + v1) / 2;
    const [cx, cy] = [um * dx - vm * dy, um * dy + vm * dx];
    // The long side is the ridge's direction.
    best = u1 - u0 >= v1 - v0
      ? { area, cx, cy, ux: dx, uy: dy, l: (u1 - u0) / 2, w: (v1 - v0) / 2 }
      : { area, cx, cy, ux: -dy, uy: dx, l: (v1 - v0) / 2, w: (u1 - u0) / 2 };
  }
  return best;
}
