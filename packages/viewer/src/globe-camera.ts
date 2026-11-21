// The camera on the globe (decision 20): a geodetic position (f64) and an
// orientation relative to east-north-up at that position, so north and up are
// always local. Each step runs the flat fly camera (camera.ts) in the ENU
// frame on the ground below the camera, then moves the camera to where that
// step landed on the globe: a long flight follows the curve of the Earth.
// Speed and the minimum altitude go by height above the ground (terrain), and
// the camera never ends a step below it.
//
// The renderer works in that same frame: the camera sits at (0, 0, h), and
// every cell is placed by its frame-to-frame transform.
//
// The pose round-trips through the URL hash as #lat,lon,alt,yaw,pitch
// (degrees, m above the ellipsoid, degrees).

import { ecefToGeodetic, enuFrame, localToEcef, type Frame } from "@game/world";
import { fromYawPitch, MIN_ALTITUDE, stepCamera, yawPitch, type Camera, type CameraInput, type Quat } from "./camera.ts";

export interface GlobeCamera {
  lat: number;
  lon: number;
  h: number;    // m above the WGS84 ellipsoid (not above the ground, not above sea level)
  rot: Quat;    // relative to east-north-up here
}

const DEG = Math.PI / 180;

/** The frame the scene is rendered in: ENU on the ground below the camera. */
export const viewFrame = (g: GlobeCamera): Frame => enuFrame({ lat: g.lat, lon: g.lon, h: 0 });

/** The camera in its own view frame. */
export const localCamera = (g: GlobeCamera): Camera => ({ pos: [0, 0, g.h], rot: g.rot });

/** Ground height (m above the ellipsoid) at a point. */
export type Ground = (lat: number, lon: number) => number;

export function stepGlobe(g: GlobeCamera, input: CameraInput, dt: number, ground: Ground = () => 0): GlobeCamera {
  const g0 = ground(g.lat, g.lon);
  const agl = g.h - g0;
  const s = stepCamera({ pos: [0, 0, agl], rot: g.rot }, input, dt);
  if (s.pos[0] === 0 && s.pos[1] === 0 && s.pos[2] === agl) return { ...g, h: Math.max(g.h, g0 + MIN_ALTITUDE), rot: s.rot };
  const p = ecefToGeodetic(localToEcef(enuFrame({ lat: g.lat, lon: g.lon, h: g0 }), s.pos));
  return { lat: p.lat, lon: p.lon, h: Math.max(ground(p.lat, p.lon) + MIN_ALTITUDE, p.h), rot: s.rot };
}

export function formatGlobeHash(g: GlobeCamera): string {
  const [yaw, pitch] = yawPitch(g.rot);
  return `#${g.lat.toFixed(7)},${g.lon.toFixed(7)},${g.h.toFixed(1)},${(yaw / DEG).toFixed(1)},${(pitch / DEG).toFixed(1)}`;
}

export function parseGlobeHash(hash: string): GlobeCamera | null {
  const v = hash.replace(/^#/, "").split(",").map(Number);
  if (v.length !== 5 || !v.every(Number.isFinite) || Math.abs(v[0]!) > 90) return null;
  const pitch = Math.max(-90, Math.min(90, v[4]!));
  return { lat: v[0]!, lon: v[1]!, h: Math.max(MIN_ALTITUDE, v[2]!), rot: fromYawPitch(v[3]! * DEG, pitch * DEG) };
}
