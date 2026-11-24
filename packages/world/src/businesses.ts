// Businesses on their buildings: a cell's points of interest (pois.ts) as signs
// on walls, and which buildings get a shopfront. A business's sign goes on its
// building's outer wall nearest its point (walls at least MIN_WALL long first),
// centered where the point projects onto the wall; several on one wall are laid
// out in order, squeezed to fit. Signs sit just above the shopfront glass, at
// the top of the ground floor. Each sign on a building at street level gets a
// door under it (DOOR), kept inside its wall and clear of the door before it.
// Pure: the viewer turns them into a mesh.

import { floorHeight } from "./building-mesh.ts";
import type { Buildings } from "./buildings.ts";
import { DOOR, type Doors } from "./doors.ts";
import { POI_CATEGORIES, type Pois } from "./pois.ts";

/** Walls shorter than this (m) get a sign only if the building has nothing longer. */
const MIN_WALL = 3;
/** A sign: this tall, this far out from the wall, this thick (m); this wide per character of its name, within limits. */
export const SIGN = { height: 0.6, out: 0.08, thick: 0.06, perChar: 0.28, pad: 0.6, min: 1.6, max: 7, gap: 0.4 };

export interface BusinessSign {
  x: number;
  y: number;
  z: number;          // its center, m in the cell's frame
  dir: number;        // radians: along the wall, the way its text reads
  width: number;
  text: string;
  category: string;   // POI_CATEGORIES
  kind: string;       // "cafe", "bakery", ...
}

/** A cell's business signs, per building row whether it has a shopfront (1), and the doors under the signs. */
export function businessSigns(b: Buildings, p: Pois): { signs: BusinessSign[]; shopfront: Uint8Array; doors: Doors } {
  const shopfront = new Uint8Array(b.count);
  const door = { poi: [] as number[], building: [] as number[], x: [] as number[], y: [] as number[], z: [] as number[], ux: [] as number[], uy: [] as number[] };
  // Each building's businesses, by wall.
  const byWall = new Map<string, { i: number; t: number }[]>();
  for (let k = 0; k < p.count; k++) {
    const i = p.building[k]!;
    shopfront[i] = 1;
    const wall = nearestWall(b, i, p.x[k]!, p.y[k]!);
    if (!wall) continue;
    const key = `${i}:${wall.edge}`;
    if (!byWall.has(key)) byWall.set(key, []);
    byWall.get(key)!.push({ i: k, t: wall.t });
  }

  const signs: BusinessSign[] = [];
  for (const [key, list] of byWall) {
    const [i, edge] = key.split(":").map(Number) as [number, number];
    const r = b.ringStart[i]!, a = b.pointStart[r]!, n = b.pointStart[r + 1]! - a;
    const [px, py, qx, qy] = [
      b.points[2 * (a + edge)]!, b.points[2 * (a + edge) + 1]!,
      b.points[2 * (a + (edge + 1) % n)]!, b.points[2 * (a + (edge + 1) % n) + 1]!,
    ];
    const len = Math.hypot(qx - px, qy - py);
    const [ux, uy] = [(qx - px) / len, (qy - py) / len];
    const [ox, oy] = [uy, -ux];  // outward: rings are CCW, outside on the right
    const text = (k: number) => p.names[p.name[k]!]!;
    // Widths by name, then along the wall in order, pushed apart, then squeezed to fit.
    list.sort((s, t) => s.t - t.t);
    const room = len - 2 * SIGN.gap;
    let widths = list.map(({ i: k }) => Math.min(SIGN.max, Math.max(SIGN.min, SIGN.pad + SIGN.perChar * text(k).length)));
    const total = widths.reduce((s, w) => s + w, 0) + SIGN.gap * (list.length - 1);
    if (total > room) widths = widths.map((w) => (w * Math.max(0, room - SIGN.gap * (list.length - 1))) / (total - SIGN.gap * (list.length - 1)));
    const centers: number[] = [];
    let cursor = SIGN.gap;
    list.forEach(({ t }, j) => {
      const c = Math.max(t * len, cursor + widths[j]! / 2);
      centers.push(c);
      cursor = c + widths[j]! / 2 + SIGN.gap;
    });
    const overflow = cursor - SIGN.gap - (len - SIGN.gap);
    if (overflow > 0) for (let j = 0; j < centers.length; j++) centers[j] = centers[j]! - overflow;
    const foot = b.base[i]! + b.minHeight[i]!, z = foot + floorHeight(b, i) - 0.4;
    const out = SIGN.out + SIGN.thick / 2;
    const doors = b.minHeight[i]! <= DOOR.street && floorHeight(b, i) >= DOOR.height + DOOR.headroom;
    const [lo, hi] = [DOOR.margin + DOOR.width / 2, len - DOOR.margin - DOOR.width / 2];
    let lastDoor = -Infinity;
    list.forEach(({ i: k }, j) => {
      if (widths[j]! < 0.5) return;  // no room left on this wall
      signs.push({
        x: px + ux * centers[j]! + ox * out, y: py + uy * centers[j]! + oy * out, z,
        dir: Math.atan2(uy, ux), width: widths[j]!, text: text(k),
        category: POI_CATEGORIES[p.category[k]!]!, kind: p.kinds[p.kind[k]!]!,
      });
      // Its door: under it, inside the wall, clear of the last one.
      const c = Math.min(hi, Math.max(lo, centers[j]!));
      if (!doors || lo > hi || c - lastDoor < DOOR.width + DOOR.margin) return;
      lastDoor = c;
      door.poi.push(k);
      door.building.push(i);
      door.x.push(px + ux * c);
      door.y.push(py + uy * c);
      door.z.push(foot);
      door.ux.push(ux);
      door.uy.push(uy);
    });
  }
  return {
    signs, shopfront,
    doors: {
      count: door.building.length, poi: Int32Array.from(door.poi), building: Int32Array.from(door.building), x: Float32Array.from(door.x),
      y: Float32Array.from(door.y), z: Float32Array.from(door.z), ux: Float32Array.from(door.ux), uy: Float32Array.from(door.uy),
    },
  };
}

/** The outer wall of building row i nearest a point (walls MIN_WALL long first), and where along it (0..1). */
function nearestWall(b: Buildings, i: number, x: number, y: number): { edge: number; t: number } | null {
  const r = b.ringStart[i]!, a = b.pointStart[r]!, n = b.pointStart[r + 1]! - a;
  let best: { edge: number; t: number } | null = null, bestD = Infinity, bestLong = false;
  for (let k = 0; k < n; k++) {
    const [px, py] = [b.points[2 * (a + k)]!, b.points[2 * (a + k) + 1]!];
    const [qx, qy] = [b.points[2 * (a + (k + 1) % n)]!, b.points[2 * (a + (k + 1) % n) + 1]!];
    const dx = qx - px, dy = qy - py, len2 = dx * dx + dy * dy;
    if (len2 === 0) continue;
    const t = Math.max(0, Math.min(1, ((x - px) * dx + (y - py) * dy) / len2));
    const d = Math.hypot(x - (px + t * dx), y - (py + t * dy));
    const long = Math.sqrt(len2) >= MIN_WALL;
    if ((long && !bestLong) || (long === bestLong && d < bestD)) [best, bestD, bestLong] = [{ edge: k, t }, d, long];
  }
  return best;
}
