// Buildings → triangle mesh: extruded walls and flat roofs. Pure and
// deterministic, like every operator.
//
// Walls get their own vertices per ring edge, facing out (rings are CCW outer /
// CW holes, so outside is always to the right of travel). Where two walls meet
// at less than CREASE, the corner gets their average normal, so curved walls
// shade smoothly while a box keeps its corners. The bottom AO_BAND m of a wall
// darken toward the ground (a stand-in for ambient occlusion): the normal's
// fourth byte, 127 at the ground to 0 at the band's top (0 everywhere else).
// Roofs are triangulated with earcut, holes included. Every triangle is
// counterclockwise seen from outside, so back faces can be culled.

import earcut from "earcut";
import { BUILDING_GROUPS, buildingGroup, type Buildings } from "./buildings.ts";

export interface BuildingMesh {
  positions: Float32Array;  // x, y, z, m
  normals: Int8Array;       // x, y, z, occlusion per vertex; ×127 (occlusion 0..127: how much darker, toward the ground)
  material: Uint8Array;     // group × 2 + (1 for roof), group from BUILDING_GROUPS
  shade: Uint8Array;        // per-building variation 0..255, stable per OSM id
  indices: Uint32Array;
}

export const BUILDING_MATERIALS = BUILDING_GROUPS.length * 2;

/** Walls meeting at less than this share a normal at their corner (smooth); at more, a crease. */
export const CREASE = (30 * Math.PI) / 180;
/** The bottom of a wall this high, m, darkens toward the ground. */
export const AO_BAND = 5;

/** A stable 0..255 value per OSM id, for color variation. */
export function idShade(osmId: number): number {
  let h = Math.imul((osmId % 2 ** 31) | 0, 0x9e3779b1) ^ Math.floor(osmId / 2 ** 31);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  return (h ^ (h >>> 13)) & 255;
}

export function buildingMesh(b: Buildings): BuildingMesh {
  const totalPoints = b.points.length / 2;
  const ringTotal = b.ringStart[b.count]!;
  const vertexCap = 7 * totalPoints;                   // 6 per wall (with its dark band) + 1 per roof point
  const indexCap = 12 * totalPoints + 3 * (totalPoints + 2 * ringTotal);
  const positions = new Float32Array(3 * vertexCap);
  const normals = new Int8Array(4 * vertexCap);
  const material = new Uint8Array(vertexCap);
  const shade = new Uint8Array(vertexCap);
  const indices = new Uint32Array(indexCap);
  let v = 0, ix = 0;

  const vertex = (x: number, y: number, z: number, nx: number, ny: number, nz: number, mat: number, sh: number, ao = 0) => {
    positions[3 * v] = x;
    positions[3 * v + 1] = y;
    positions[3 * v + 2] = z;
    normals[4 * v] = Math.round(nx * 127);
    normals[4 * v + 1] = Math.round(ny * 127);
    normals[4 * v + 2] = Math.round(nz * 127);
    normals[4 * v + 3] = Math.round(ao * 127);
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

    // Walls: each edge's outward normal, then each corner's (smooth or creased), then a quad per edge, split at the
    // top of its dark band.
    const band = Math.min(top, bottom + AO_BAND);
    for (let r = r0; r < r1; r++) {
      const a = b.pointStart[r]!, n = b.pointStart[r + 1]! - a;
      const pt = (k: number) => a + ((k % n) + n) % n;
      const edges = wallNormals(b.points, a, n);
      for (let k = 0; k < n; k++) {
        const pi = pt(k), pj = pt(k + 1);
        const xi = b.points[2 * pi]!, yi = b.points[2 * pi + 1]!;
        const xj = b.points[2 * pj]!, yj = b.points[2 * pj + 1]!;
        if (xi === xj && yi === yj) continue;
        const [si, ti] = corner(edges, k, n, -1), [sj, tj] = corner(edges, k, n, 1);
        const q = vertex(xi, yi, bottom, si, ti, 0, wallMat, sh, 1);
        vertex(xj, yj, bottom, sj, tj, 0, wallMat, sh, 1);
        vertex(xj, yj, band, sj, tj, 0, wallMat, sh);
        vertex(xi, yi, band, si, ti, 0, wallMat, sh);
        indices.set([q, q + 1, q + 2, q, q + 2, q + 3], ix);
        ix += 6;
        if (band < top) {
          vertex(xj, yj, top, sj, tj, 0, wallMat, sh);
          vertex(xi, yi, top, si, ti, 0, wallMat, sh);
          indices.set([q + 3, q + 2, q + 4, q + 3, q + 4, q + 5], ix);
          ix += 6;
        }
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

/** Each edge's outward unit normal (x, y) of a ring of n points from `a`; a zero-length edge takes the next one's. */
function wallNormals(points: Float32Array | Float64Array, a: number, n: number): Float64Array {
  const out = new Float64Array(2 * n);
  for (let k = 0; k < n; k++) {
    const pi = a + k, pj = a + ((k + 1) % n);
    const dx = points[2 * pj]! - points[2 * pi]!, dy = points[2 * pj + 1]! - points[2 * pi + 1]!;
    const len = Math.hypot(dx, dy);
    if (len > 0) [out[2 * k], out[2 * k + 1]] = [dy / len, -dx / len];
  }
  for (let k = n - 1; k >= 0; k--) {
    if (out[2 * k] === 0 && out[2 * k + 1] === 0) {
      const j = (k + 1) % n;
      [out[2 * k], out[2 * k + 1]] = [out[2 * j]!, out[2 * j + 1]!];
    }
  }
  return out;
}

/**
 * The normal at one end of edge k (side −1: its start, 1: its end): the average of it and the neighboring edge's where
 * they meet at less than CREASE, else its own.
 */
function corner(edges: Float64Array, k: number, n: number, side: -1 | 1): [number, number] {
  const j = (k + side + n) % n;
  const [ax, ay] = [edges[2 * k]!, edges[2 * k + 1]!], [bx, by] = [edges[2 * j]!, edges[2 * j + 1]!];
  if (ax * bx + ay * by < Math.cos(CREASE)) return [ax, ay];
  const len = Math.hypot(ax + bx, ay + by);
  return [(ax + bx) / len, (ay + by) / len];
}
