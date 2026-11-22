//! Plane geometry words: segments, how two of them cross, and the metric between (s, t) and metres.

use glam::{DMat2, DVec2};

/// A straight piece of a ring, from a to b.
#[derive(Clone, Copy, Debug)]
pub struct Segment {
    pub a: DVec2,
    pub b: DVec2,
}

/// How two segments meet. Decided by exact orientation signs, never a tolerance.
pub enum Crossing {
    /// Each passes strictly through the other, here.
    Proper(DVec2),
    /// They touch or overlap: an endpoint on the other, or collinear.
    Touch,
    Apart,
}

impl Segment {
    /// Unit direction a → b (zero for a zero-length segment).
    pub fn dir(&self) -> DVec2 {
        (self.b - self.a).normalize_or_zero()
    }

    /// Unit normal toward the inside of a counterclockwise ring: the left of travel.
    pub fn inward(&self) -> DVec2 {
        self.dir().perp()
    }

    pub fn crossing(&self, other: &Segment) -> Crossing {
        let (p, q, r, s) = (self.a, self.b, other.a, other.b);
        let (o1, o2) = (orient(p, q, r), orient(p, q, s));
        let (o3, o4) = (orient(r, s, p), orient(r, s, q));
        if o1 * o2 < 0.0 && o3 * o4 < 0.0 {
            // Where (a construction: the decision above was exact).
            let t = (r - p).perp_dot(s - r) / (q - p).perp_dot(s - r);
            return Crossing::Proper(p + t * (q - p));
        }
        let zero = o1 == 0.0 || o2 == 0.0 || o3 == 0.0 || o4 == 0.0;
        let boxes_meet = p.min(q).cmple(r.max(s)).all() && r.min(s).cmple(p.max(q)).all();
        if zero && boxes_meet {
            Crossing::Touch
        } else {
            Crossing::Apart
        }
    }
}

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

/// Exact orientation (Shewchuk's adaptive predicate): positive if a, b, c turn counterclockwise, negative
/// clockwise, zero if collinear.
pub fn orient(a: DVec2, b: DVec2, c: DVec2) -> f64 {
    let coord = |v: DVec2| robust::Coord { x: v.x, y: v.y };
    robust::orient2d(coord(a), coord(b), coord(c))
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
