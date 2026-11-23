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
//
// Windows are drawn by the shader from where each wall vertex is on its
// façade (facade: m along the wall from its first whole window bay, m above
// the wall's bottom, the width of its whole bays, the wall's height) and the
// building's floor height (floor, dm; 0: none). Only whole windows: a wall too
// short for a bay (a curve's facets, a dome) has none, nor do utility
// buildings, small parts on top of others (air conditioners, stair housings),
// and domes. Floors come from building:levels where tagged.
//
// Houses (and buildings tagged roof:shape=gabled|hipped|pyramidal) get pitched
// roofs (roofs.ts): untagged ones gabled or hipped by their OSM id (hipped on a
// square footprint is pyramidal). Their walls rise to meet the roof (gable ends filled in), the
// outline gaining a vertex wherever the roof changes face so every wall's top
// is straight. Residential buildings get a paint color for their walls (and
// pitched roofs) by their OSM id: paint, an index into the viewer's PAINTS
// (0: the material's color).

import earcut from "earcut";
import { BUILDING_GROUPS, buildingGroup, ROOF_SHAPES, signedArea2, type BuildingGroup, type Buildings } from "./buildings.ts";
import { clipConvex, pitchedRoof, type PitchedRoof, type RoofShape } from "./roofs.ts";

export interface BuildingMesh {
  positions: Float32Array;  // x, y, z, m
  normals: Int8Array;       // x, y, z, occlusion per vertex; ×127 (occlusion 0..127: how much darker, toward the ground)
  material: Uint8Array;     // group × 2 + (1 for roof), group from BUILDING_GROUPS
  shade: Uint8Array;        // per-building variation 0..255, stable per OSM id
  facade: Float32Array;     // per vertex: m along the wall from its first bay, m above its bottom, bays' width, wall height
  floor: Uint8Array;        // per vertex: floor height, dm; 0: no windows
  paint: Uint8Array;        // per vertex: index into the viewer's PAINTS; 0: the material's color
  indices: Uint32Array;
}

/** Paints (the viewer's PAINTS, from 1): this many wall colors, then this many roof colors. */
export const WALL_PAINTS = 8;
export const ROOF_PAINTS = 5;

/** House kinds that get a pitched roof when they have no roof:shape. */
const HOUSES = new Set(["house", "detached", "semidetached_house", "terrace", "bungalow", "duplex", "cabin", "farm", "residential"]);
/** Bigger than this (m²) or taller (m), a "house" is something else: its roof stays flat. */
const HOUSE_AREA = 400;
const HOUSE_HEIGHT = 15;

/** A building group's windows, m: bay width, window width, sill height, window height, and floor height where untagged. */
export interface WindowStyle { bay: number; width: number; sill: number; height: number; floor: number }

export const WINDOW_STYLES: Record<BuildingGroup, WindowStyle | null> = {
  residential: { bay: 3.2, width: 1.2, sill: 0.9, height: 1.4, floor: 3.0 },
  commercial: { bay: 3.0, width: 2.2, sill: 0.6, height: 2.3, floor: 3.8 },
  industrial: { bay: 6.0, width: 2.6, sill: 2.4, height: 1.4, floor: 6.0 },
  civic: { bay: 3.6, width: 1.6, sill: 1.0, height: 2.1, floor: 4.2 },
  utility: null,
  other: { bay: 3.2, width: 1.4, sill: 0.9, height: 1.5, floor: 3.2 },
};

/** A part on top of another smaller than this (m²) is equipment, not rooms: no windows. */
const EQUIPMENT_AREA = 40;
const NO_WINDOW_ROOFS = new Set(["dome", "onion"]);

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
  // Room for 6 vertices per wall (with its dark band) and one per roof point; grown if pitched roofs need more.
  let vertexCap = 7 * totalPoints + 64, indexCap = 16 * totalPoints + 64;
  let positions = new Float32Array(3 * vertexCap);
  let normals = new Int8Array(4 * vertexCap);
  let material = new Uint8Array(vertexCap);
  let shade = new Uint8Array(vertexCap);
  let facade = new Float32Array(4 * vertexCap);
  let floorDm = new Uint8Array(vertexCap);
  let paints = new Uint8Array(vertexCap);
  let indices = new Uint32Array(indexCap);
  let v = 0, ix = 0;
  const grow = <T extends Float32Array | Int8Array | Uint8Array | Uint32Array>(a: T, size: number): T => {
    const out = new (a.constructor as new (n: number) => T)(size);
    out.set(a);
    return out;
  };
  /** Room for `nv` more vertices and `ni` more indices. */
  const room = (nv: number, ni: number) => {
    if (v + nv > vertexCap) {
      vertexCap = 2 * (v + nv);
      [positions, normals, facade] = [grow(positions, 3 * vertexCap), grow(normals, 4 * vertexCap), grow(facade, 4 * vertexCap)];
      [material, shade, floorDm, paints] = [grow(material, vertexCap), grow(shade, vertexCap), grow(floorDm, vertexCap), grow(paints, vertexCap)];
    }
    if (ix + ni > indexCap) indices = grow(indices, indexCap = 2 * (ix + ni));
  };

  // Where on its façade a wall vertex is (see the top), and its building's floor height; nothing for a roof.
  const at = { u: 0, v: 0, span: 0, wall: 0, floor: 0, paint: 0 };
  const vertex = (x: number, y: number, z: number, nx: number, ny: number, nz: number, mat: number, sh: number, ao = 0) => {
    facade.set([at.u, at.v, at.span, at.wall], 4 * v);
    floorDm[v] = Math.round(at.floor * 10);
    paints[v] = at.paint;
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

  /** A pitched roof's faces over an outline (with its breaks), each the outline clipped to where it's the roof. */
  const pitched = (roof: PitchedRoof, ring: Float64Array, top: number, mat: number, sh: number) => {
    for (const face of roof.faces) {
      let piece = Array.from(ring);
      const r = face.region, m = r.length / 2;
      for (let k = 0; k < m && piece.length >= 6; k++) {
        const [px, py, qx, qy] = [r[2 * k]!, r[2 * k + 1]!, r[(2 * k + 2) % r.length]!, r[(2 * k + 3) % r.length]!];
        piece = clipConvex(piece, (x, y) => (qx - px) * (y - py) - (qy - py) * (x - px));
      }
      if (piece.length < 6) continue;
      const tris = earcut(piece, null, 2);
      const len = Math.hypot(face.gx, face.gy, 1);
      const [nx, ny, nz] = [-face.gx / len, -face.gy / len, 1 / len];
      room(piece.length / 2, tris.length);
      const first = v;
      for (let k = 0; k < piece.length; k += 2) {
        const x = piece[k]!, y = piece[k + 1]!;
        vertex(x, y, top + face.gx * x + face.gy * y + face.c, nx, ny, nz, mat, sh);
      }
      for (let t = 0; t < tris.length; t += 3) {
        const a = tris[t]!, c = tris[t + 1]!, d = tris[t + 2]!;
        const area = (piece[2 * c]! - piece[2 * a]!) * (piece[2 * d + 1]! - piece[2 * a + 1]!)
          - (piece[2 * d]! - piece[2 * a]!) * (piece[2 * c + 1]! - piece[2 * a + 1]!);
        if (area >= 0) indices.set([first + a, first + c, first + d], ix);
        else indices.set([first + a, first + d, first + c], ix);
        ix += 3;
      }
    }
  };

  for (let i = 0; i < b.count; i++) {
    if (!(b.height[i]! > b.minHeight[i]!)) continue;
    // Heights are above the ground; base is the ground's lowest point under the building, so on a
    // slope the uphill walls run into the ground rather than the building floating.
    const top = b.base[i]! + b.height[i]!, bottom = b.base[i]! + b.minHeight[i]!;
    const wallMat = groups[b.kind[i]!]! * 2, roofMat = wallMat + 1;
    const sh = idShade(b.osmId[i]!);
    const r0 = b.ringStart[i]!, r1 = b.ringStart[i + 1]!;
    const p0 = b.pointStart[r0]!, p1 = b.pointStart[r1]!;
    const group = BUILDING_GROUPS[groups[b.kind[i]!]!]!;
    const shape = roofShape(b, i);
    const roof = shape ? pitchedRoof(b.points, p0, p1, shape) : null;
    const wallPaint = group === "residential" ? 1 + pick(b.osmId[i]!, 1, WALL_PAINTS) : 0;
    const roofPaint = roof ? 1 + WALL_PAINTS + pick(b.osmId[i]!, 2, ROOF_PAINTS) : 0;
    // The roof's height over the walls' top at a point (0 for a flat roof).
    const rise = (x: number, y: number) => (roof ? roof.rise(x, y) : 0);

    // Walls: each edge's outward normal, then each corner's (smooth or creased), then a quad per edge, split at the
    // top of its dark band.
    const band = Math.min(top, bottom + AO_BAND);
    const style = windows(b, i, groups[b.kind[i]!]!);
    const wall = top - bottom;
    at.paint = wallPaint;
    const outlines: Float64Array[] = [];
    for (let r = r0; r < r1; r++) {
      const ring = outline(b.points, b.pointStart[r]!, b.pointStart[r + 1]!, roof);
      outlines.push(ring);
      const n = ring.length / 2;
      room(6 * n, 12 * n);
      const pt = (k: number) => ((k % n) + n) % n;
      const edges = wallNormals(ring, 0, n);
      for (let k = 0; k < n; k++) {
        const pi = pt(k), pj = pt(k + 1);
        const xi = ring[2 * pi]!, yi = ring[2 * pi + 1]!;
        const xj = ring[2 * pj]!, yj = ring[2 * pj + 1]!;
        if (xi === xj && yi === yj) continue;
        const [si, ti] = corner(edges, k, n, -1), [sj, tj] = corner(edges, k, n, 1);
        // Whole bays, centered on the wall: u from the first one's start.
        const len = Math.hypot(xj - xi, yj - yi);
        const bays = style ? Math.floor(len / style.bay) : 0;
        const offset = bays > 0 ? (len - bays * style!.bay) / 2 : 0;
        Object.assign(at, { span: bays * (style?.bay ?? 0), wall, floor: bays > 0 ? style!.floor : 0 });
        const corners = (zi: number, zj: number, ao: number) => {
          at.u = -offset;
          at.v = zi - bottom;
          const first = vertex(xi, yi, zi, si, ti, 0, wallMat, sh, ao);
          at.u = len - offset;
          at.v = zj - bottom;
          vertex(xj, yj, zj, sj, tj, 0, wallMat, sh, ao);
          return first;
        };
        // Rows of two vertices (i, j): the base, the band's top, the top; each pair of rows a quad, counterclockwise
        // from outside.
        const q = corners(bottom, bottom, 1);
        corners(band, band, 0);
        indices.set([q, q + 1, q + 3, q, q + 3, q + 2], ix);
        ix += 6;
        if (band < top) {
          // Up to the roof: the eaves, or a gable's slope.
          corners(top + rise(xi, yi), top + rise(xj, yj), 0);
          indices.set([q + 2, q + 3, q + 5, q + 2, q + 5, q + 4], ix);
          ix += 6;
        }
      }
    }

    // Roof
    Object.assign(at, { u: 0, v: 0, span: 0, wall: 0, floor: 0, paint: roofPaint });
    if (roof) {
      pitched(roof, outlines[0]!, top, roofMat, sh);
      continue;
    }
    room(p1 - p0, 3 * (p1 - p0 + 2 * (r1 - r0)));
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
    facade: facade.slice(0, 4 * v),
    floor: floorDm.slice(0, v),
    paint: paints.slice(0, v),
    indices: indices.slice(0, ix),
  };
}

/**
 * A building's pitched roof shape, or null for a flat roof: as tagged (roof:shape), else for an untagged house (one
 * ring, not a part, small and low) gabled or hipped by its OSM id.
 */
function roofShape(b: Buildings, i: number): RoofShape | null {
  const tagged = ROOF_SHAPES[b.roofShape[i]!]!;
  const r0 = b.ringStart[i]!, r1 = b.ringStart[i + 1]!;
  if (r1 - r0 !== 1) return null;  // courtyards: flat
  if (tagged === "gabled" || tagged === "hipped" || tagged === "pyramidal") return tagged;
  if (tagged === "half-hipped") return "hipped";
  if (tagged !== "" || b.isPart[i] || !HOUSES.has(b.kinds[b.kind[i]!]!) || b.height[i]! > HOUSE_HEIGHT) return null;
  const a = b.pointStart[r0]!, e = b.pointStart[r1]!;
  if (Math.abs(signedArea2(b.points, a, e)) / 2 > HOUSE_AREA) return null;
  return pick(b.osmId[i]!, 3, 5) < 3 ? "gabled" : "hipped";
}

/** A ring's points (x y interleaved), with a point wherever its pitched roof changes face along an edge. */
function outline(points: ArrayLike<number>, a: number, e: number, roof: PitchedRoof | null): Float64Array {
  const out: number[] = [];
  for (let k = a; k < e; k++) {
    const j = k + 1 < e ? k + 1 : a;
    const [x0, y0, x1, y1] = [points[2 * k]!, points[2 * k + 1]!, points[2 * j]!, points[2 * j + 1]!];
    out.push(x0, y0);
    for (const t of roof ? roof.breaks(x0, y0, x1, y1) : []) out.push(x0 + t * (x1 - x0), y0 + t * (y1 - y0));
  }
  return Float64Array.from(out);
}

/** A stable choice of 0..n−1 per OSM id, different for each `salt`. */
function pick(osmId: number, salt: number, n: number): number {
  let h = Math.imul((osmId % 2 ** 31) | 0, 0x9e3779b1) ^ Math.imul(salt, 0x85ebca6b) ^ Math.floor(osmId / 2 ** 31);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  return ((h ^ (h >>> 15)) >>> 0) % n;
}

/**
 * A building's windows: its group's style with its floor height (from building:levels where tagged), or null where it
 * has none (utility buildings, equipment on top of other parts, domes, walls lower than a floor).
 */
function windows(b: Buildings, i: number, group: number): WindowStyle | null {
  const style = WINDOW_STYLES[BUILDING_GROUPS[group]!];
  const wall = b.height[i]! - b.minHeight[i]!;
  if (!style || wall < 2.5 || NO_WINDOW_ROOFS.has(ROOF_SHAPES[b.roofShape[i]!]!)) return null;
  const r = b.ringStart[i]!, a = b.pointStart[r]!, e = b.pointStart[r + 1]!;
  if (b.isPart[i] && b.minHeight[i]! > 0 && Math.abs(signedArea2(b.points, a, e)) / 2 < EQUIPMENT_AREA) return null;
  const floors = b.levels[i]! - b.minLevel[i]!;
  const floor = floors >= 1 ? Math.min(8, Math.max(2.4, wall / floors)) : style.floor;
  return { ...style, floor };
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
