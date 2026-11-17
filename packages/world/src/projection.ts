// Lat/lon → local flat meters (x east, y north) around an origin.
//
// Equirectangular around the origin. Within a few km the scale error is a few
// hundredths of a percent, far below OSM's own accuracy.

export interface LatLon {
  lat: number;
  lon: number;
}

const EARTH_RADIUS_M = 6_371_008.8; // mean radius
const DEG = Math.PI / 180;

export function localProjection(origin: LatLon): (lon: number, lat: number) => [x: number, y: number] {
  const kx = EARTH_RADIUS_M * DEG * Math.cos(origin.lat * DEG);
  const ky = EARTH_RADIUS_M * DEG;
  return (lon, lat) => [(lon - origin.lon) * kx, (lat - origin.lat) * ky];
}
