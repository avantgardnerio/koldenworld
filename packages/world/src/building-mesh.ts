// Buildings → triangle mesh: extruded walls and flat roofs. Pure and
// deterministic, like every operator.
//
// Walls get their own four vertices per ring edge so each face has a flat
// normal (outward: rings are CCW outer / CW holes, so outside is always to the
// right of travel). Roofs are triangulated with earcut, holes included. Every
// triangle is counterclockwise seen from outside, so back faces can be culled.

import earcut from "earcut";
import { BUILDING_GROUPS, buildingGroup, type Buildings } from "./buildings.ts";

export interface BuildingMesh {
  positions: Float32Array;  // x, y, z, m
  normals: Int8Array;       // x, y, z, 0 per vertex; ×127
  material: Uint8Array;     // group × 2 + (1 for roof), group from BUILDING_GROUPS
  shade: Uint8Array;        // per-building variation 0..255, stable per OSM id
  indices: Uint32Array;
}

export const BUILDING_MATERIALS = BUILDING_GROUPS.length * 2;

/** A stable 0..255 value per OSM id, for color variation. */
export function idShade(osmId: number): number {
  let h = Math.imul((osmId % 2 ** 31) | 0, 0x9e3779b1) ^ Math.floor(osmId / 2 ** 31);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  return (h ^ (h >>> 13)) & 255;
}

export function buildingMesh(b: Buildings): BuildingMesh {
  const totalPoints = b.points.length / 2;
  const ringTotal = b.ringStart[b.count]!;
  const vertexCap = 5 * totalPoints;                   // 4 per wall + 1 per roof point
  const indexCap = 6 * totalPoints + 3 * (totalPoints + 2 * ringTotal);
  const positions = new Float32Array(3 * vertexCap);
  const normals = new Int8Array(4 * vertexCap);
  const material = new Uint8Array(vertexCap);
  const shade = new Uint8Array(vertexCap);
  const indices = new Uint32Array(indexCap);
  let v = 0, ix = 0;

  const vertex = (x: number, y: number, z: number, nx: number, ny: number, nz: number, mat: number, sh: number) => {
    positions[3 * v] = x;
    positions[3 * v + 1] = y;
    positions[3 * v + 2] = z;
    normals[4 * v] = Math.round(nx * 127);
    normals[4 * v + 1] = Math.round(ny * 127);
    normals[4 * v + 2] = Math.round(nz * 127);
    material[v] = mat;
    shade[v] = sh;
    return v++;
  };

  const groups = b.kinds.map((k) => BUILDING_GROUPS.indexOf(buildingGroup(k)));

  for (let i = 0; i < b.count; i++) {
    if (!(b.height[i]! > b.minHeight[i]!)) continue;
    // Heights are above the ground; base is the ground's lowest point under the building, so on a
    // slope the uphill walls run into the ground rather than the building floating.
    const top = b.base[i]! + b.height[i]!, bottom = b.base[i]! + b.minHeight[i]!;
    const wallMat = groups[b.kind[i]!]! * 2, roofMat = wallMat + 1;
    const sh = idShade(b.osmId[i]!);
    const r0 = b.ringStart[i]!, r1 = b.ringStart[i + 1]!;
    const p0 = b.pointStart[r0]!, p1 = b.pointStart[r1]!;

    // Walls
    for (let r = r0; r < r1; r++) {
      const a = b.pointStart[r]!, n = b.pointStart[r + 1]! - a;
      for (let k = 0; k < n; k++) {
        const pi = a + k, pj = a + ((k + 1) % n);
        const xi = b.points[2 * pi]!, yi = b.points[2 * pi + 1]!;
        const xj = b.points[2 * pj]!, yj = b.points[2 * pj + 1]!;
        const len = Math.hypot(xj - xi, yj - yi);
        if (len === 0) continue;
        const nx = (yj - yi) / len, ny = -(xj - xi) / len;
        const q = vertex(xi, yi, bottom, nx, ny, 0, wallMat, sh);
        vertex(xj, yj, bottom, nx, ny, 0, wallMat, sh);
        vertex(xj, yj, top, nx, ny, 0, wallMat, sh);
        vertex(xi, yi, top, nx, ny, 0, wallMat, sh);
        indices.set([q, q + 1, q + 2, q, q + 2, q + 3], ix);
        ix += 6;
      }
    }

    // Roof
    const flat = b.points.subarray(2 * p0, 2 * p1);
    const holes: number[] = [];
    for (let r = r0 + 1; r < r1; r++) holes.push(b.pointStart[r]! - p0);
    const tris = earcut(flat, holes.length ? holes : null, 2);
    const base = v;
    for (let k = 0; k < p1 - p0; k++) vertex(flat[2 * k]!, flat[2 * k + 1]!, top, 0, 0, 1, roofMat, sh);
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t]!, c = tris[t + 1]!, d = tris[t + 2]!;
      // Make each roof triangle counterclockwise seen from above.
      const area = (flat[2 * c]! - flat[2 * a]!) * (flat[2 * d + 1]! - flat[2 * a + 1]!)
        - (flat[2 * d]! - flat[2 * a]!) * (flat[2 * c + 1]! - flat[2 * a + 1]!);
      if (area >= 0) indices.set([base + a, base + c, base + d], ix);
      else indices.set([base + a, base + d, base + c], ix);
      ix += 3;
    }
  }

  return {
    positions: positions.slice(0, 3 * v),
    normals: normals.slice(0, 4 * v),
    material: material.slice(0, v),
    shade: shade.slice(0, v),
    indices: indices.slice(0, ix),
  };
}
