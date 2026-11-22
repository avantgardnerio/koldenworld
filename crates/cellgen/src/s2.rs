//! S2's cube faces (a slice of packages/world/src/s2.ts). The sphere is projected onto a cube: a direction's face
//! is its largest axis, (u, v) in [-1, 1] is where it meets that face (gnomonic), and (s, t) in [0, 1] stretches
//! (u, v) quadratically to even out cell sizes. Lat/lon are taken as spherical coordinates, as S2 does.

use crate::geom::Metric;
use glam::{DMat2, DVec2};

/// Level of our cells: 2^13 cells across each cube face, about 1.1 km.
pub const CELL_LEVEL: u32 = 13;
const DEG: f64 = std::f64::consts::PI / 180.0;

/// The face a point is on, and its (s, t) there.
pub fn lat_lon_to_face_st(lat: f64, lon: f64) -> (u32, [f64; 2]) {
    let [x, y, z] = lat_lon_to_xyz(lat, lon);
    let (ax, ay, az) = (x.abs(), y.abs(), z.abs());
    let mut face = if ax > ay {
        if ax > az { 0 } else { 2 }
    } else if ay > az {
        1
    } else {
        2
    };
    if [x, y, z][face as usize] < 0.0 {
        face += 3;
    }
    (face, face_st(face, lat, lon))
}

/// The square (s0, t0, s1, t1) of the cell at a level containing a point (s, t).
pub fn cell_square([s, t]: [f64; 2], level: u32) -> [f64; 4] {
    let n = (1u32 << level) as f64;
    let (i, j) = ((s * n).floor(), (t * n).floor());
    [i / n, j / n, (i + 1.0) / n, (j + 1.0) / n]
}

/// Metres per unit of s and t across a cell, east and north: the columns of the 2×2 matrix taking a small (s, t)
/// step to metres on the ground, measured across the cell (central differences between its edges' midpoints).
/// Over a level-13 cell the true local scale varies by about 1 part in 10,000, so one matrix serves the cell.
pub fn cell_metric(face: u32, [s0, t0, s1, t1]: [f64; 4]) -> Metric {
    let c = [(s0 + s1) / 2.0, (t0 + t1) / 2.0];
    let (lat0, lon0) = st_to_lat_lon(face, c);
    // WGS84 radii of curvature at the cell's latitude: meridian (north) and prime vertical (east).
    let (a, e2) = (6_378_137.0, 0.006_694_379_990_141_317);
    let w = 1.0 - e2 * (lat0 * DEG).sin().powi(2);
    let (r_north, r_east) = (
        a * (1.0 - e2) / w.powf(1.5),
        a / w.sqrt() * (lat0 * DEG).cos(),
    );
    let metres = |st: [f64; 2]| {
        let (lat, lon) = st_to_lat_lon(face, st);
        [(lon - lon0) * DEG * r_east, (lat - lat0) * DEG * r_north]
    };
    let (e0, e1) = (metres([s0, c[1]]), metres([s1, c[1]]));
    let (n0, n1) = (metres([c[0], t0]), metres([c[0], t1]));
    let (ds, dt) = (s1 - s0, t1 - t0);
    let to_m = DMat2::from_cols(
        DVec2::new(e1[0] - e0[0], e1[1] - e0[1]) / ds,
        DVec2::new(n1[0] - n0[0], n1[1] - n0[1]) / dt,
    );
    Metric::new(DVec2::from_array(c), to_m)
}

/// A lon/lat box (west, south, east, north) around an (s, t) rectangle on a face: its corners, padded by `pad`
/// degrees (its edges bow a little in lon/lat).
pub fn lat_lon_bounds(face: u32, [s0, t0, s1, t1]: [f64; 4], pad: f64) -> [f64; 4] {
    let corners = [[s0, t0], [s1, t0], [s1, t1], [s0, t1]].map(|st| st_to_lat_lon(face, st));
    let lats = corners.map(|c| c.0);
    let lons = corners.map(|c| c.1);
    [
        lons.into_iter().fold(f64::MAX, f64::min) - pad,
        lats.into_iter().fold(f64::MAX, f64::min) - pad,
        lons.into_iter().fold(f64::MIN, f64::max) + pad,
        lats.into_iter().fold(f64::MIN, f64::max) + pad,
    ]
}

/// A point's (s, t) on a given face, whichever face it's nearest (a point just over the face's edge).
pub fn face_st(face: u32, lat: f64, lon: f64) -> [f64; 2] {
    let [x, y, z] = lat_lon_to_xyz(lat, lon);
    let [u, v] = match face {
        0 => [y / x, z / x],
        1 => [-x / y, z / y],
        2 => [-x / z, -y / z],
        3 => [z / x, y / x],
        4 => [z / y, -x / y],
        _ => [-y / z, -x / z],
    };
    [uv_to_st(u), uv_to_st(v)]
}

/// The inverse of face_st: (lat, lon) in degrees.
pub fn st_to_lat_lon(face: u32, [s, t]: [f64; 2]) -> (f64, f64) {
    let (u, v) = (st_to_uv(s), st_to_uv(t));
    let [x, y, z] = match face {
        0 => [1.0, u, v],
        1 => [-u, 1.0, v],
        2 => [-u, -v, 1.0],
        3 => [-1.0, -v, -u],
        4 => [v, -1.0, -u],
        _ => [v, u, -1.0],
    };
    (z.atan2(x.hypot(y)) / DEG, y.atan2(x) / DEG)
}

fn lat_lon_to_xyz(lat: f64, lon: f64) -> [f64; 3] {
    let cos_lat = (lat * DEG).cos();
    [
        cos_lat * (lon * DEG).cos(),
        cos_lat * (lon * DEG).sin(),
        (lat * DEG).sin(),
    ]
}

fn uv_to_st(u: f64) -> f64 {
    if u >= 0.0 {
        0.5 * (1.0 + 3.0 * u).sqrt()
    } else {
        1.0 - 0.5 * (1.0 - 3.0 * u).sqrt()
    }
}

fn st_to_uv(s: f64) -> f64 {
    if s >= 0.5 {
        (4.0 * s * s - 1.0) / 3.0
    } else {
        (1.0 - 4.0 * (1.0 - s) * (1.0 - s)) / 3.0
    }
}
