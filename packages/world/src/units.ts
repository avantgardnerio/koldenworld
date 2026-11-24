// Shop units: each business's door gets its share of its building's ground
// floor. A unit is the building's outer ring clipped by half-planes, all
// convex (Sutherland–Hodgman, clipConvex): toward its own door from every
// other door in the building (the perpendicular bisector between them, so a
// point belongs to its nearest door: on one wall, the frontage splits halfway
// between doors), behind its door's wall, and at most UNIT.depth m in from it.
// A concave footprint can leave a unit in pieces joined along a clip line.
// Courtyards are ignored. Pure.

import type { Buildings } from "./buildings.ts";
import { doorIndex, type Doors } from "./doors.ts";
import { clipConvex } from "./roofs.ts";

/** A unit reaches at most this far in from its door's wall, m; smaller than this (m²), there's none. */
export const UNIT = { depth: 20, minArea: 4 };

/** Units, as columns: each its door's (a row of Doors), its outline points[pointStart[u] .. pointStart[u + 1]) (x, y
 * pairs, m in the cell's frame, counterclockwise, open), its floor at height z. */
export interface Units {
  count: number;
  door: Uint32Array;
  z: Float32Array;
  pointStart: Uint32Array;
  points: Float32Array;
}

export function shopUnits(b: Buildings, d: Doors): Units {
  const index = doorIndex(d, b.count);
  const out = { door: [] as number[], z: [] as number[], pointStart: [0], points: [] as number[] };
  for (let i = 0; i < b.count; i++) {
    const n0 = index.start[i]!, n1 = index.start[i + 1]!;
    if (n0 === n1) continue;
    const r = b.ringStart[i]!, ring = Array.from(b.points.subarray(2 * b.pointStart[r]!, 2 * b.pointStart[r + 1]!));
    for (let n = n0; n < n1; n++) {
      const k = index.order[n]!, [kx, ky] = [d.x[k]!, d.y[k]!], [ix, iy] = [-d.uy[k]!, d.ux[k]!];  // inward
      let poly = ring;
      // Behind its wall, and not too deep.
      poly = clipConvex(poly, (x, y) => (x - kx) * ix + (y - ky) * iy);
      poly = clipConvex(poly, (x, y) => UNIT.depth - ((x - kx) * ix + (y - ky) * iy));
      // Nearer its door than any other: |p − j|² − |p − k|² ≥ 0, linear in p.
      for (let m = n0; m < n1 && poly.length >= 6; m++) {
        const j = index.order[m]!;
        if (j === k) continue;
        const [jx, jy] = [d.x[j]!, d.y[j]!], c = jx * jx + jy * jy - kx * kx - ky * ky;
        poly = clipConvex(poly, (x, y) => 2 * (x * (kx - jx) + y * (ky - jy)) + c);
      }
      if (poly.length < 6 || area(poly) < UNIT.minArea) continue;
      out.door.push(k);
      out.z.push(d.z[k]!);
      out.points.push(...poly);
      out.pointStart.push(out.points.length / 2);
    }
  }
  return {
    count: out.door.length, door: Uint32Array.from(out.door), z: Float32Array.from(out.z),
    pointStart: Uint32Array.from(out.pointStart), points: Float32Array.from(out.points),
  };
}

/** A ring's area (x y interleaved, counterclockwise positive). */
function area(p: number[]): number {
  let s = 0;
  for (let i = 0, n = p.length / 2; i < n; i++) {
    const j = (i + 1) % n;
    s += p[2 * i]! * p[2 * j + 1]! - p[2 * j]! * p[2 * i + 1]!;
  }
  return s / 2;
}
