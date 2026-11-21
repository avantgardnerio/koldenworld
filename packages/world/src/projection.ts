// Lat/lon → x, y meters on a frame's tangent plane (decision 20).
//
// Points are placed exactly on the WGS84 ellipsoid (h = 0) and expressed in
// the frame; z is dropped. Within a level-13 cell (≲ 1 km from its anchor)
// that flattens the surface by at most a few centimeters. Terrain will bring
// real heights, and z with them.

import { ecefToGeodetic, ecefToLocal, geodeticToEcef, localToEcef, type Frame } from "./geodesy.ts";

export type Projection = (lon: number, lat: number) => [x: number, y: number];

export function enuProjection(frame: Frame): Projection {
  return (lon, lat) => {
    const [x, y] = ecefToLocal(frame, geodeticToEcef({ lat, lon, h: 0 }));
    return [x, y];
  };
}

/** The inverse: tangent-plane meters → the (lon, lat) on the ellipsoid below them. */
export function enuUnprojection(frame: Frame): (x: number, y: number) => [lon: number, lat: number] {
  return (x, y) => {
    const { lat, lon } = ecefToGeodetic(localToEcef(frame, [x, y, 0]));
    return [lon, lat];
  };
}
