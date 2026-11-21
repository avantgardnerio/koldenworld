// S2 cell ids: the global partition hierarchy (decision 21).
//
// The sphere is projected onto a cube; each face is a quadtree 30 levels deep,
// and cells are numbered along a Hilbert curve, so a cell id is a 64-bit
// integer: 3 face bits, 2 bits per level, then a 1 marking the level. Nearby
// cells get nearby ids, and a cell's descendants are a contiguous id range.
//
// This is the subset of Google's S2 library we need, ported from its C++
// (s2cellid.cc, s2coords.h) and checked against s2sphere in the tests. Ids are
// bigint (unsigned 64-bit); Postgres stores them as signed bigint.
//
// Like every S2 implementation, cells are defined on lat/lon treated as
// spherical coordinates. Geometry inside a cell still uses the WGS84 ellipsoid
// (geodesy.ts); the cell is only an address.

import { enuFrame, type Frame } from "./geodesy.ts";

export type CellId = bigint;

export const MAX_LEVEL = 30;
const MAX_SIZE = 2 ** MAX_LEVEL;  // leaf cells per face edge
const DEG = Math.PI / 180;

// Hilbert curve tables. Orientation bits: 1 = axes swapped, 2 = inverted.
const SWAP = 1, INVERT = 2;
const POS_TO_IJ = [[0, 1, 3, 2], [0, 2, 3, 1], [3, 2, 0, 1], [3, 1, 0, 2]];
const POS_TO_ORIENTATION = [SWAP, 0, 0, INVERT | SWAP];
const IJ_TO_POS = POS_TO_IJ.map((row) => {
  const inv = [0, 0, 0, 0];
  row.forEach((ij, pos) => { inv[ij] = pos; });
  return inv;
});

// --- coordinate transforms --------------------------------------------------
// xyz (unit sphere) → face + (u, v) in [-1, 1] (gnomonic) → (s, t) in [0, 1]
// (quadratic, to even out cell areas) → (i, j) leaf coordinates.

type Xyz = [number, number, number];

function xyzToFaceUV([x, y, z]: Xyz): [face: number, u: number, v: number] {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  let face = ax > ay ? (ax > az ? 0 : 2) : (ay > az ? 1 : 2);
  if ([x, y, z][face]! < 0) face += 3;
  switch (face) {
    case 0: return [face, y / x, z / x];
    case 1: return [face, -x / y, z / y];
    case 2: return [face, -x / z, -y / z];
    case 3: return [face, z / x, y / x];
    case 4: return [face, z / y, -x / y];
    default: return [face, -y / z, -x / z];
  }
}

function faceUVToXyz(face: number, u: number, v: number): Xyz {
  switch (face) {
    case 0: return [1, u, v];
    case 1: return [-u, 1, v];
    case 2: return [-u, -v, 1];
    case 3: return [-1, -v, -u];
    case 4: return [v, -1, -u];
    default: return [v, u, -1];
  }
}

const uvToST = (u: number) => (u >= 0 ? 0.5 * Math.sqrt(1 + 3 * u) : 1 - 0.5 * Math.sqrt(1 - 3 * u));
const stToUV = (s: number) => (s >= 0.5 ? (4 * s * s - 1) / 3 : (1 - 4 * (1 - s) * (1 - s)) / 3);
const stToIJ = (s: number) => Math.max(0, Math.min(MAX_SIZE - 1, Math.floor(MAX_SIZE * s)));

function latLonToXyz(lat: number, lon: number): Xyz {
  const cosLat = Math.cos(lat * DEG);
  return [cosLat * Math.cos(lon * DEG), cosLat * Math.sin(lon * DEG), Math.sin(lat * DEG)];
}

function xyzToLatLon([x, y, z]: Xyz): { lat: number; lon: number } {
  return { lat: Math.atan2(z, Math.hypot(x, y)) / DEG, lon: Math.atan2(y, x) / DEG };
}

// --- ids ----------------------------------------------------------------------

/** The leaf cell at leaf coordinates (i, j) on a face. Hot path: no bigint until the end. */
function fromFaceIJ(face: number, i: number, j: number): CellId {
  let orient = face & SWAP;
  let hi = 0, lo = 0;  // Hilbert positions for levels 1–15 and 16–30, 30 bits each
  for (let k = MAX_LEVEL - 1; k >= 0; k--) {
    const pos = IJ_TO_POS[orient]![(((i >>> k) & 1) << 1) | ((j >>> k) & 1)]!;
    if (k >= 15) hi = hi * 4 + pos;
    else lo = lo * 4 + pos;
    orient ^= POS_TO_ORIENTATION[pos]!;
  }
  return (BigInt(face) << 61n) | (BigInt(hi) << 31n) | (BigInt(lo) << 1n) | 1n;
}

const lsb = (id: CellId) => id & -id;

export function cellLevel(id: CellId): number {
  let l = MAX_LEVEL;
  for (let b = lsb(id); b > 1n; b >>= 2n) l--;
  return l;
}

export const cellFace = (id: CellId) => Number(id >> 61n);

export function cellParent(id: CellId, level: number): CellId {
  const bit = 1n << BigInt(2 * (MAX_LEVEL - level));
  return (id & -bit) | bit;
}

export function cellChildren(id: CellId): [CellId, CellId, CellId, CellId] {
  const b = lsb(id), c = b >> 2n;
  if (c === 0n) throw new Error("leaf cells have no children");
  return [id - b + c, id - b + 3n * c, id - b + 5n * c, id - b + 7n * c];
}

/** True if `b` is `a` or lies inside it. */
export function cellContains(a: CellId, b: CellId): boolean {
  const r = lsb(a) - 1n;
  return b >= a - r && b <= a + r;
}

export function cellFromLatLon(lat: number, lon: number, level = MAX_LEVEL): CellId {
  const [face, u, v] = xyzToFaceUV(latLonToXyz(lat, lon));
  const leaf = fromFaceIJ(face, stToIJ(uvToST(u)), stToIJ(uvToST(v)));
  return level === MAX_LEVEL ? leaf : cellParent(leaf, level);
}

/** Face and the cell's (i, j) at its own level (0 ≤ i, j < 2^level). */
function cellFaceIJ(id: CellId): { face: number; i: number; j: number; level: number } {
  const face = cellFace(id), level = cellLevel(id);
  let orient = face & SWAP, i = 0, j = 0;
  for (let k = 0; k < level; k++) {
    const pos = Number((id >> BigInt(59 - 2 * k)) & 3n);
    const ij = POS_TO_IJ[orient]![pos]!;
    i = i * 2 + (ij >> 1);
    j = j * 2 + (ij & 1);
    orient ^= POS_TO_ORIENTATION[pos]!;
  }
  return { face, i, j, level };
}

/** The cell's center: the middle of its (s, t) square, as S2 defines it. */
export function cellCenter(id: CellId): { lat: number; lon: number } {
  const { face, i, j, level } = cellFaceIJ(id);
  const n = 2 ** level;
  return xyzToLatLon(faceUVToXyz(face, stToUV((i + 0.5) / n), stToUV((j + 0.5) / n)));
}

/**
 * Corners counterclockwise from (u, v) = (min, min). Cell edges are great-circle
 * arcs; a polygon through these corners with straight lat/lon edges differs from
 * the true cell by a sliver, so queries against it should pad.
 */
export function cellCorners(id: CellId): { lat: number; lon: number }[] {
  const { face, i, j, level } = cellFaceIJ(id);
  const n = 2 ** level;
  return [[0, 0], [1, 0], [1, 1], [0, 1]].map(([di, dj]) =>
    xyzToLatLon(faceUVToXyz(face, stToUV((i + di!) / n), stToUV((j + dj!) / n))));
}

/** A leaf at (i, j), which may lie up to one leaf beyond the face: wrapped onto the adjacent face. */
function fromFaceIJWrap(face: number, i: number, j: number): CellId {
  i = Math.max(-1, Math.min(MAX_SIZE, i));
  j = Math.max(-1, Math.min(MAX_SIZE, j));
  // Linear (i, j) → (u, v) just outside the face, clamped barely past its edge so
  // reprojecting cannot move the other coordinate into the wrong leaf.
  const limit = 1 + Number.EPSILON;
  const u0 = Math.max(-limit, Math.min(limit, (2 * (i - MAX_SIZE / 2) + 1) / MAX_SIZE));
  const v0 = Math.max(-limit, Math.min(limit, (2 * (j - MAX_SIZE / 2) + 1) / MAX_SIZE));
  const [f, u, v] = xyzToFaceUV(faceUVToXyz(face, u0, v0));
  return fromFaceIJ(f, stToIJ(0.5 * (u + 1)), stToIJ(0.5 * (v + 1)));
}

/** The four cells sharing an edge with this one, at its level: down, right, up, left (in (i, j)). */
export function cellEdgeNeighbors(id: CellId): [CellId, CellId, CellId, CellId] {
  const { face, i, j, level } = cellFaceIJ(id);
  const size = 2 ** (MAX_LEVEL - level);
  const li = i * size, lj = j * size;  // leaf coordinates of the lower-left corner
  const at = (ni: number, nj: number) => {
    const inside = ni >= 0 && nj >= 0 && ni < MAX_SIZE && nj < MAX_SIZE;
    return cellParent(inside ? fromFaceIJ(face, ni, nj) : fromFaceIJWrap(face, ni, nj), level);
  };
  return [at(li, lj - size), at(li + size, lj), at(li, lj + size), at(li - size, lj)];
}

/** The ENU frame at the cell's center, at height h above the ellipsoid (decision 20). */
export function cellFrame(id: CellId, h = 0): Frame {
  return enuFrame({ ...cellCenter(id), h });
}

// --- encodings ----------------------------------------------------------------

/** S2 token: hex with trailing zeros dropped ("X" for the invalid id 0). */
export function cellToken(id: CellId): string {
  if (id === 0n) return "X";
  return id.toString(16).padStart(16, "0").replace(/0+$/, "");
}

export function cellFromToken(token: string): CellId {
  if (token === "X") return 0n;
  return BigInt("0x" + token.padEnd(16, "0"));
}

/** For Postgres `bigint`: the same 64 bits, read as signed. Order is preserved within a face. */
export const cellToInt64 = (id: CellId) => BigInt.asIntN(64, id);
export const cellFromInt64 = (v: bigint) => BigInt.asUintN(64, v);
