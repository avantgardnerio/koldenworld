// The globe (decision 20): WGS84 geodetic ↔ ECEF, and local east-north-up
// frames anchored anywhere on it.
//
// ECEF is the one global frame: meters from Earth's center, x through
// (0°, 0°), z through the north pole, always f64. Everything else is a local
// ENU frame (x east, y north, z up) small enough for f32, placed by a rigid
// transform computed here in f64.

export type Vec3 = [number, number, number];

/** Degrees; h is meters above the WGS84 ellipsoid (not above sea level). */
export interface Geodetic {
  lat: number;
  lon: number;
  h: number;
}

export const WGS84_A = 6_378_137;                     // equatorial radius, m
export const WGS84_F = 1 / 298.257_223_563;           // flattening
export const WGS84_B = WGS84_A * (1 - WGS84_F);       // polar radius, m
const E2 = WGS84_F * (2 - WGS84_F);                   // first eccentricity squared
const DEG = Math.PI / 180;

/** Prime vertical radius of curvature at a latitude (radians). */
const primeVertical = (sinLat: number) => WGS84_A / Math.sqrt(1 - E2 * sinLat * sinLat);

export function geodeticToEcef({ lat, lon, h }: Geodetic): Vec3 {
  const sinLat = Math.sin(lat * DEG), cosLat = Math.cos(lat * DEG);
  const n = primeVertical(sinLat);
  return [
    (n + h) * cosLat * Math.cos(lon * DEG),
    (n + h) * cosLat * Math.sin(lon * DEG),
    (n * (1 - E2) + h) * sinLat,
  ];
}

/**
 * Fixed-point iteration on latitude. The forms used stay well conditioned at
 * the poles and the equator; converges to below a nanometer in a few steps for
 * any point near the surface.
 */
export function ecefToGeodetic([x, y, z]: Vec3): Geodetic {
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - E2));
  for (let k = 0; k < 10; k++) {
    const next = Math.atan2(z + E2 * primeVertical(Math.sin(lat)) * Math.sin(lat), p);
    const done = Math.abs(next - lat) < 1e-15;
    lat = next;
    if (done) break;
  }
  const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
  const n = primeVertical(sinLat);
  return { lat: lat / DEG, lon: Math.atan2(y, x) / DEG, h: p * cosLat + z * sinLat - WGS84_A * WGS84_A / n };
}

/** A local ENU frame: its origin in ECEF and its axes as ECEF unit vectors. */
export interface Frame {
  origin: Vec3;
  east: Vec3;
  north: Vec3;
  up: Vec3;
}

/** The ENU frame at a point; up is the ellipsoid normal there. */
export function enuFrame(at: Geodetic): Frame {
  const sinLat = Math.sin(at.lat * DEG), cosLat = Math.cos(at.lat * DEG);
  const sinLon = Math.sin(at.lon * DEG), cosLon = Math.cos(at.lon * DEG);
  return {
    origin: geodeticToEcef(at),
    east: [-sinLon, cosLon, 0],
    north: [-sinLat * cosLon, -sinLat * sinLon, cosLat],
    up: [cosLat * cosLon, cosLat * sinLon, sinLat],
  };
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function ecefToLocal(f: Frame, p: Vec3): Vec3 {
  const d: Vec3 = [p[0] - f.origin[0], p[1] - f.origin[1], p[2] - f.origin[2]];
  return [dot(d, f.east), dot(d, f.north), dot(d, f.up)];
}

export function localToEcef(f: Frame, [x, y, z]: Vec3): Vec3 {
  return [
    f.origin[0] + x * f.east[0] + y * f.north[0] + z * f.up[0],
    f.origin[1] + x * f.east[1] + y * f.north[1] + z * f.up[1],
    f.origin[2] + x * f.east[2] + y * f.north[2] + z * f.up[2],
  ];
}

/**
 * The rigid transform taking `from`-local coordinates to `to`-local ones, as a
 * column-major 4×4 (WebGL layout), into `out` if given (a Float32Array
 * receives the f64 results rounded once, with no intermediate f32 math).
 * The translation is a difference of nearby origins, so the f32 result loses
 * nothing that matters when the frames are close.
 */
export function frameToFrame(from: Frame, to: Frame, out: Float64Array | Float32Array = new Float64Array(16)) {
  const axes = [from.east, from.north, from.up];
  for (let c = 0; c < 3; c++) {
    const a = axes[c]!;
    out[c * 4] = dot(a, to.east);
    out[c * 4 + 1] = dot(a, to.north);
    out[c * 4 + 2] = dot(a, to.up);
    out[c * 4 + 3] = 0;
  }
  // The origin difference in f64 first: it is the large part (decision 20).
  const dx = from.origin[0] - to.origin[0], dy = from.origin[1] - to.origin[1], dz = from.origin[2] - to.origin[2];
  out[12] = dx * to.east[0] + dy * to.east[1] + dz * to.east[2];
  out[13] = dx * to.north[0] + dy * to.north[1] + dz * to.north[2];
  out[14] = dx * to.up[0] + dy * to.up[1] + dz * to.up[2];
  out[15] = 1;
  return out;
}

/** Apply a column-major 4×4 rigid transform to a point. */
export function transformPoint(m: ArrayLike<number>, [x, y, z]: Vec3): Vec3 {
  return [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
  ];
}
