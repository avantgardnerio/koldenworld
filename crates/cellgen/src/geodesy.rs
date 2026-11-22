//! The globe (decision 20), as packages/world/src/geodesy.ts: WGS84 geodetic → ECEF, and a local east-north-up frame
//! anchored on it. ECEF is metres from Earth's center (x through 0°, 0°; z through the north pole), always f64; a local
//! ENU frame is small enough for f32.

use glam::DVec3;

const WGS84_A: f64 = 6_378_137.0; // equatorial radius, m
const WGS84_F: f64 = 1.0 / 298.257_223_563; // flattening
const E2: f64 = WGS84_F * (2.0 - WGS84_F); // first eccentricity squared

/// ECEF of a point at degrees lat, lon and h metres above the ellipsoid.
pub fn ecef(lat: f64, lon: f64, h: f64) -> DVec3 {
    let (sin_lat, cos_lat) = lat.to_radians().sin_cos();
    let (sin_lon, cos_lon) = lon.to_radians().sin_cos();
    let n = WGS84_A / (1.0 - E2 * sin_lat * sin_lat).sqrt(); // prime vertical radius of curvature
    DVec3::new(
        (n + h) * cos_lat * cos_lon,
        (n + h) * cos_lat * sin_lon,
        (n * (1.0 - E2) + h) * sin_lat,
    )
}

/// A local ENU frame: its origin in ECEF and its axes as ECEF unit vectors.
pub struct Frame {
    origin: DVec3,
    east: DVec3,
    north: DVec3,
    up: DVec3,
}

impl Frame {
    /// The ENU frame at a point; up is the ellipsoid normal there.
    pub fn at(lat: f64, lon: f64, h: f64) -> Frame {
        let (sin_lat, cos_lat) = lat.to_radians().sin_cos();
        let (sin_lon, cos_lon) = lon.to_radians().sin_cos();
        Frame {
            origin: ecef(lat, lon, h),
            east: DVec3::new(-sin_lon, cos_lon, 0.0),
            north: DVec3::new(-sin_lat * cos_lon, -sin_lat * sin_lon, cos_lat),
            up: DVec3::new(cos_lat * cos_lon, cos_lat * sin_lon, sin_lat),
        }
    }

    /// An ECEF point in this frame (x east, y north, z up).
    pub fn local(&self, p: DVec3) -> DVec3 {
        let d = p - self.origin;
        DVec3::new(d.dot(self.east), d.dot(self.north), d.dot(self.up))
    }
}
