//! A polygon: a ring of vertices as columns (closed implicitly: the last links back to the first), each vertex
//! remembering where it came from. Rings are counterclockwise for an area, clockwise around a hole.
//!
//! Where it came from is its id: the graph dart (an edge end, traversed) whose side it lies on, and whether it's the
//! corner where that dart's side starts (side_id, corner_id), or MADE.

use crate::geom;
use glam::DVec2;

/// No id: a vertex made on no side we know.
pub const MADE: u32 = u32::MAX;

/// The id of a vertex on dart h's side.
pub fn side_id(h: u32) -> u32 {
    2 * h
}

/// The id of the corner where dart h's side starts.
pub fn corner_id(h: u32) -> u32 {
    2 * h + 1
}

#[derive(Default)]
pub struct Polygon {
    pos: Vec<DVec2>, // in (s, t) on the cell's face
    id: Vec<u32>,    // where it came from (side_id, corner_id) or MADE
}

impl Polygon {
    /// A ring through these points in order.
    pub fn from_points(points: impl IntoIterator<Item = (DVec2, u32)>) -> Polygon {
        let (pos, id) = points.into_iter().unzip();
        Polygon { pos, id }
    }

    /// Every vertex's position and id, in ring order.
    pub fn vertices(&self) -> impl Iterator<Item = (DVec2, u32)> + '_ {
        self.pos.iter().copied().zip(self.id.iter().copied())
    }

    /// Every vertex's position, in ring order.
    pub fn positions(&self) -> impl Iterator<Item = DVec2> + '_ {
        self.pos.iter().copied()
    }

    /// Signed area, positive counterclockwise.
    pub fn signed_area(&self) -> f64 {
        geom::signed_area(self.positions())
    }

    /// Whether a point is inside the ring (even-odd). For picking which polygon something lies in, not for geometry.
    pub fn contains(&self, q: DVec2) -> bool {
        let ring = &self.pos;
        let mut inside = false;
        for i in 0..ring.len() {
            let (a, b) = (ring[i], ring[(i + 1) % ring.len()]);
            if (a.y > q.y) != (b.y > q.y) && q.x < (b.x - a.x) * (q.y - a.y) / (b.y - a.y) + a.x {
                inside = !inside;
            }
        }
        inside
    }
}
