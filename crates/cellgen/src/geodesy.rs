//! The globe (decision 20), as packages/world/src/geodesy.ts: WGS84 geodetic → ECEF, and a local east-north-up frame
//! anchored on it. ECEF is metres from Earth's center (x through 0°, 0°; z through the north pole), always f64; a local
//! ENU frame is small enough for f32.

use glam::DVec3;

const WGS84_A: f64 = 6_378_137.0; // equatorial radius, m
const WGS84_F: f64 = 1.0 / 298.257_223_563; // flattening
const E2: f64 = WGS84_F * (2.0 - WGS84_F); // first eccentricity squared
const DEG: f64 = std::f64::consts::PI / 180.0; // as the TS divides by it

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

/// Degrees lat, lon and metres above the ellipsoid of an ECEF point, as the TS ecefToGeodetic: fixed-point iteration
/// on latitude, below a nanometre in a few steps near the surface.
pub fn geodetic(p: DVec3) -> (f64, f64, f64) {
    let prime_vertical = |sin_lat: f64| WGS84_A / (1.0 - E2 * sin_lat * sin_lat).sqrt();
    let q = p.x.hypot(p.y);
    let mut lat = p.z.atan2(q * (1.0 - E2));
    for _ in 0..10 {
        let next = (p.z + E2 * prime_vertical(lat.sin()) * lat.sin()).atan2(q);
        let done = (next - lat).abs() < 1e-15;
        lat = next;
        if done {
            break;
        }
    }
    let (sin_lat, cos_lat) = lat.sin_cos();
    let n = prime_vertical(sin_lat);
    (
        lat / DEG,
        p.y.atan2(p.x) / DEG,
        q * cos_lat + p.z * sin_lat - WGS84_A * WGS84_A / n,
    )
}

impl Frame {
    /// A point in this frame (x east, y north, z up) in ECEF.
    pub fn ecef(&self, p: DVec3) -> DVec3 {
        self.origin + p.x * self.east + p.y * self.north + p.z * self.up
    }

    /// Lon, lat of the ellipsoid point below (x, y) on the frame's tangent plane, as the TS enuUnprojection.
    pub fn lon_lat(&self, x: f64, y: f64) -> [f64; 2] {
        let (lat, lon, _) = geodetic(self.ecef(DVec3::new(x, y, 0.0)));
        [lon, lat]
    }

    /// (x, y) on the frame's tangent plane of a lon, lat on the ellipsoid, as the TS enuProjection.
    pub fn project(&self, lon: f64, lat: f64) -> [f64; 2] {
        let p = self.local(ecef(lat, lon, 0.0));
        [p.x, p.y]
    }
}
