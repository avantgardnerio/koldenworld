//! Shrinking a polygon: every side pulled in by a distance, then its self-crossings cut away. Works on the ring in
//! metres, riding it with a cursor.

use crate::geom::{self, Crossing, Metric};
use crate::polygon::{Cursor, MADE, Polygon};
use glam::DVec2;

/// A vertex in a very sharp corner stops at this many distances in.
const MITER: f64 = 4.0;

/// What shrinking ran into.
#[derive(Debug, Default)]
pub struct ShrinkStats {
    pub tips: usize,      // dead-end tips given square end caps
    pub crossings: usize, // self-crossings cut away
    pub pinches: usize,   // crossings whose two loops were both positive: the smaller was dropped
    pub touches: usize,   // sides touching or collinear (exact zero signs), left alone
    pub vanished: usize,  // polygons with nothing left
}

impl Polygon {
    /// This polygon with every side pulled in by `d` metres and its self-crossings cut away, or None if nothing is
    /// left.
    pub fn shrink(&self, d: f64, metric: &Metric, stats: &mut ShrinkStats) -> Option<Polygon> {
        let mut band = self.in_metres(metric);
        band.drop_repeats();
        band.move_in(d, stats);
        band.cut_self_crossings(stats);
        if !band.is_solid() {
            stats.vanished += 1;
            return None;
        }
        Some(band.in_st(metric))
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

    /// Rides the ring cutting away self-crossings until a whole lap finds none.
    fn cut_self_crossings(&mut self, stats: &mut ShrinkStats) {
        let Some(mut v) = self.first() else { return };
        let mut clean = 0;
        while v.ring_len() >= 3 && clean < v.ring_len() {
            match v.first_crossing_ahead(stats) {
                Some((w, x)) => {
                    v.cut_loop(w, x, stats);
                    clean = 0;
                }
                None => {
                    v.next();
                    clean += 1;
                }
            }
        }
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

    /// This vertex's side out crosses w's at x, closing two loops: ahead (x, then this vertex's next … w) and behind
    /// (x, then w's next … this vertex). Makes a vertex at x and deletes the inverted loop back to it (both
    /// positive: a pinch, the smaller goes). The cursor ends on a vertex still in the ring, before x.
    fn cut_loop(&mut self, w: u32, x: DVec2, stats: &mut ShrinkStats) {
        let here = self.index();
        let ahead = geom::signed_area(std::iter::once(x).chain(self.positions_ahead(w)));
        self.jump(w);
        let behind = geom::signed_area(std::iter::once(x).chain(self.positions_ahead(here)));
        if ahead > 0.0 && behind > 0.0 {
            stats.pinches += 1;
        }
        stats.crossings += 1;
        // Make the crossing after the side that stays, then delete from it round to the other side's far end.
        let keep = if ahead < behind { here } else { w };
        self.jump(keep);
        let x = self.insert_after(x, MADE);
        self.jump(x);
        self.next();
        let stop = if keep == here {
            self.next_after(w)
        } else {
            self.next_after(here)
        };
        while self.index() != stop {
            self.remove();
        }
        self.jump(keep);
    }
}
