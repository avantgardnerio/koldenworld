//! Shrinking a polygon: every side pulled in by a distance, then the ring split at its self-crossings into loops,
//! each judged by its own sign once it has no crossings of its own. A positive loop is an island, kept (a block
//! pinched in two keeps both); a negative loop is a part the shrink turned inside out (an overshot corner, a
//! collapsed spike, an island with no room left), dropped. Works in metres, riding the ring with a cursor.
//!
//! Known flaw: where several short sides overshoot past each other in a tangle (a sharp corner), moving vertices
//! along bisectors gives a ring whose winding no longer matches "at least d from every side", and small triangles
//! closer than d to a road survive as islands (about 11 around Five Points, under 1 m² each). No rule on the loops
//! can fix that; it needs offsetting each side separately and a boolean union.

use crate::geom::{Crossing, Metric};
use crate::polygon::{Cursor, Polygon};
use glam::DVec2;

/// A vertex in a very sharp corner stops at this many distances in.
const MITER: f64 = 4.0;

/// What shrinking ran into.
#[derive(Debug, Default)]
pub struct ShrinkStats {
    pub tips: usize,      // dead-end tips given square end caps
    pub crossings: usize, // self-crossings the ring was split at
    pub inverted: usize, // loops dropped: clockwise (turned inside out), or too few vertices to enclose anything
    pub splits: usize,   // polygons that became two or more islands
    pub touches: usize,  // sides touching or collinear (exact zero signs), left alone
    pub vanished: usize, // polygons with nothing left
}

impl Polygon {
    /// This polygon with every side pulled in by `d` metres: the islands left, each a clean counterclockwise ring
    /// (none if nothing is left, several if it pinched apart).
    pub fn shrink(&self, d: f64, metric: &Metric, stats: &mut ShrinkStats) -> Vec<Polygon> {
        let mut band = self.in_metres(metric);
        band.drop_repeats();
        band.move_in(d, stats);
        let islands = band.into_islands(stats);
        match islands.len() {
            0 => stats.vanished += 1,
            1 => {}
            _ => stats.splits += 1,
        }
        islands.iter().map(|p| p.in_st(metric)).collect()
    }

    /// Every vertex moved so both its sides land `d` further in; where the ring doubles back (a dead end's tip) the
    /// vertex becomes two, the corners of a square end cap. All are worked out from the ring as it was, then set.
    fn move_in(&mut self, d: f64, stats: &mut ShrinkStats) {
        let Some(mut v) = self.first() else { return };
        let moved: Vec<(DVec2, Option<DVec2>)> = (0..v.ring_len())
            .map(|_| {
                let to = if v.doubles_back() {
                    stats.tips += 1;
                    let (corner, other) = v.end_cap(d);
                    (corner, Some(other))
                } else {
                    (v.pos() + v.inward_offset(d), None)
                };
                v.next();
                to
            })
            .collect();
        for (to, also) in moved {
            v.set_pos(to);
            if let Some(also) = also {
                v.insert_after(also, v.source());
                v.next();
            }
            v.next();
        }
    }

    /// Splits the ring at self-crossings until no loop has any, then keeps the positive loops.
    fn into_islands(self, stats: &mut ShrinkStats) -> Vec<Polygon> {
        let (mut work, mut islands) = (vec![self], Vec::new());
        while let Some(mut ring) = work.pop() {
            match ring.split_at_first_crossing(stats) {
                Some(other) => {
                    stats.crossings += 1;
                    work.push(ring);
                    work.push(other);
                }
                None if ring.is_solid() => islands.push(ring),
                None => stats.inverted += 1,
            }
        }
        islands
    }

    /// Rides the ring to the first side that properly crosses a side ahead of it, and splits the loop ahead off
    /// there; None if the ring doesn't cross itself.
    fn split_at_first_crossing(&mut self, stats: &mut ShrinkStats) -> Option<Polygon> {
        let mut v = self.first()?;
        for _ in 0..v.ring_len() {
            if let Some((w, x)) = v.first_crossing_ahead(stats) {
                return Some(v.split_off(w, x));
            }
            v.next();
        }
        None
    }
}

impl Cursor<'_> {
    /// How far to move this vertex so both its sides land `d` further in: along the bisector of their inward
    /// normals, d ÷ cos(half the angle between them), at most MITER × d. (Not for a vertex that doubles back: its
    /// normals cancel.)
    fn inward_offset(&self, d: f64) -> DVec2 {
        let (a, b) = (self.side_in().inward(), self.side_out().inward());
        let bisector = (a + b).normalize();
        bisector * (d / bisector.dot(a)).min(MITER * d)
    }

    /// A dead end's tip, as the two corners of a square end cap `d` past it: one where the side in, moved in, meets
    /// the cap, then one where the cap meets the side out.
    fn end_cap(&self, d: f64) -> (DVec2, DVec2) {
        let (ahead, inward) = (self.side_in().dir(), self.side_in().inward());
        (
            self.pos() + (ahead + inward) * d,
            self.pos() + (ahead - inward) * d,
        )
    }

    /// The first side ahead that properly crosses this vertex's side out: its first vertex, and where.
    fn first_crossing_ahead(&self, stats: &mut ShrinkStats) -> Option<(u32, DVec2)> {
        let out = self.side_out();
        for (w, side) in self.sides_ahead() {
            match out.crossing(&side) {
                Crossing::Proper(x) => return Some((w, x)),
                Crossing::Touch => stats.touches += 1,
                Crossing::Apart => {}
            }
        }
        None
    }
}
