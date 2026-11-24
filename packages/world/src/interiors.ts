// Inside a shop: a unit's (units.ts) walls, and its shell as a mesh, built
// when someone comes near. The shell is a floor, walls facing in, and a
// ceiling a little under the floor above, so from inside the building's own
// walls and roof (which face out) aren't seen. The wall with the door stands
// at the back of its reveal (DOOR.reveal in), with the doorway left open;
// collisions (wallGrid) use the same walls. Pure.

import earcut from "earcut";
import { DOOR, type Doors } from "./doors.ts";
import type { Units } from "./units.ts";

/** How far a door may be off a unit's edge and still be in it, m. */
const ON_EDGE = 0.01;
/** The floor this far above the unit's z (over the ground under it), the ceiling this far under its height, m. */
const FLOOR_LIFT = 0.03, CEILING_DROP = 0.05;
/** Materials: an index into the viewer's interior colors. */
export const INTERIOR = { floor: 0, wall: 1, ceiling: 2 } as const;

/**
 * Unit k's walls as segments (a → b, the room on the left), its door's wall moved back to its reveal and open where the
 * door is.
 */
export function unitWalls(u: Units, k: number, d: Doors, visit: (ax: number, ay: number, bx: number, by: number) => void): void {
  const a = u.pointStart[k]!, e = u.pointStart[k + 1]!, door = u.door[k]!;
  const [dx, dy, ux, uy] = [d.x[door]!, d.y[door]!, d.ux[door]!, d.uy[door]!];
  for (let p = a; p < e; p++) {
    const q = p + 1 < e ? p + 1 : a;
    let [px, py, qx, qy] = [u.points[2 * p]!, u.points[2 * p + 1]!, u.points[2 * q]!, u.points[2 * q + 1]!];
    const len = Math.hypot(qx - px, qy - py);
    if (len === 0) continue;
    const [ex, ey] = [(qx - px) / len, (qy - py) / len];
    // The door's wall: along it, the door on it.
    if (ex * ux + ey * uy < 1 - 1e-6 || Math.abs((dx - px) * ey - (dy - py) * ex) > ON_EDGE) {
      visit(px, py, qx, qy);
      continue;
    }
    const s = (dx - px) * ex + (dy - py) * ey;
    [px, py, qx, qy] = [px - uy * DOOR.reveal, py + ux * DOOR.reveal, qx - uy * DOOR.reveal, qy + ux * DOOR.reveal];
    const [g0, g1] = [Math.max(0, s - DOOR.width / 2), Math.min(len, s + DOOR.width / 2)];
    if (g0 > 0) visit(px, py, px + ex * g0, py + ey * g0);
    if (g1 < len) visit(px + ex * g1, py + ey * g1, qx, qy);
  }
}

export interface InteriorMesh {
  positions: Float32Array;  // x, y, z, m in the cell's frame
  normals: Int8Array;       // x, y, z, 0 per vertex; ×127
  material: Uint8Array;     // INTERIOR
  shade: Uint8Array;        // all 0
  indices: Uint32Array;
}

/** Unit k's shell: its floor, its walls facing in (the doorway open, a lintel over it), its ceiling. */
export function interiorMesh(u: Units, k: number, d: Doors): InteriorMesh {
  const pos: number[] = [], nrm: number[] = [], mat: number[] = [], idx: number[] = [];
  const z0 = u.z[k]! + FLOOR_LIFT, z1 = u.z[k]! + u.height[k]! - CEILING_DROP, head = u.z[k]! + DOOR.height;
  const quad = (c: [number, number, number][], n: [number, number, number], m: number) => {
    const first = pos.length / 3;
    for (const p of c) {
      pos.push(...p);
      nrm.push(Math.round(n[0] * 127), Math.round(n[1] * 127), Math.round(n[2] * 127), 0);
      mat.push(m);
    }
    idx.push(first, first + 1, first + 2, first, first + 2, first + 3);
  };
  // Walls: each segment from the floor to the ceiling, counterclockwise seen from the room (on its left).
  unitWalls(u, k, d, (ax, ay, bx, by) => {
    const len = Math.hypot(bx - ax, by - ay), n: [number, number, number] = [-(by - ay) / len, (bx - ax) / len, 0];
    quad([[bx, by, z0], [ax, ay, z0], [ax, ay, z1], [bx, by, z1]], n, INTERIOR.wall);
  });
  // Over the doorway: the door's wall from the door's top up, where unitWalls left it open.
  const door = u.door[k]!, [ux, uy] = [d.ux[door]!, d.uy[door]!];
  const [cx, cy] = [d.x[door]! - uy * DOOR.reveal, d.y[door]! + ux * DOOR.reveal], w = DOOR.width / 2;
  const [ax, ay, bx, by] = [cx - ux * w, cy - uy * w, cx + ux * w, cy + uy * w];
  quad([[bx, by, head], [ax, ay, head], [ax, ay, z1], [bx, by, z1]], [-uy, ux, 0], INTERIOR.wall);
  // Floor (facing up) and ceiling (facing down): the outline, earcut.
  const ring = u.points.subarray(2 * u.pointStart[k]!, 2 * u.pointStart[k + 1]!), n = ring.length / 2;
  const tris = earcut(ring, null, 2);
  for (const [z, up, m] of [[z0, 1, INTERIOR.floor], [z1, -1, INTERIOR.ceiling]] as const) {
    const first = pos.length / 3;
    for (let p = 0; p < n; p++) {
      pos.push(ring[2 * p]!, ring[2 * p + 1]!, z);
      nrm.push(0, 0, 127 * up, 0);
      mat.push(m);
    }
    // Earcut's winding is unspecified: each triangle counterclockwise seen from its side.
    for (let t = 0; t < tris.length; t += 3) {
      const [a, b, c] = [tris[t]!, tris[t + 1]!, tris[t + 2]!];
      const ccw = (ring[2 * b]! - ring[2 * a]!) * (ring[2 * c + 1]! - ring[2 * a + 1]!)
        - (ring[2 * c]! - ring[2 * a]!) * (ring[2 * b + 1]! - ring[2 * a + 1]!) > 0;
      idx.push(first + a, ...(ccw === (up > 0) ? [first + b, first + c] : [first + c, first + b]));
    }
  }
  return {
    positions: Float32Array.from(pos), normals: Int8Array.from(nrm), material: Uint8Array.from(mat),
    shade: new Uint8Array(mat.length), indices: Uint32Array.from(idx),
  };
}
