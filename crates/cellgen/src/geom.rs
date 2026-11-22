//! Plane geometry: signed area, and the metric between (s, t) and metres.

use glam::{DMat2, DVec2};

/// Signed area of a closed ring of points, positive counterclockwise (shoelace, relative to the first point to keep
/// precision).
pub fn signed_area(mut points: impl Iterator<Item = DVec2>) -> f64 {
    let Some(o) = points.next() else { return 0.0 };
    let Some(mut a) = points.next() else {
        return 0.0;
    };
    let mut twice = 0.0;
    for b in points {
        twice += (a - o).perp_dot(b - o);
        a = b;
    }
    twice / 2.0
}

/// Metres on the ground around a cell, from its face's (s, t): a linear map about the cell's centre (one matrix
/// serves a level-13 cell: the true scale varies across it by about 1 part in 10,000).
#[derive(Clone, Copy, Debug)]
pub struct Metric {
    pub origin: DVec2, // (s, t) at metres (0, 0)
    pub to_m: DMat2,   // columns: metres (east, north) per unit of s, and of t
    pub to_st: DMat2,
}

impl Metric {
    pub fn new(origin: DVec2, to_m: DMat2) -> Metric {
        Metric {
            origin,
            to_m,
            to_st: to_m.inverse(),
        }
    }

    pub fn metres(&self, st: DVec2) -> DVec2 {
        self.to_m * (st - self.origin)
    }

    pub fn st(&self, metres: DVec2) -> DVec2 {
        self.origin + self.to_st * metres
    }

    /// Square metres per unit of (s, t) area.
    pub fn area_scale(&self) -> f64 {
        self.to_m.determinant().abs()
    }
}
