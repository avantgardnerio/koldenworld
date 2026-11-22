//! Shrinking a polygon: every side pulled in by a distance, as a new polygon, then its self-crossings cut away.
//!
//! 1. Every vertex moves in along the bisector of its two sides' inward normals, d ÷ cos(half the angle between
//!    them) out, so both sides land d in (capped at MITER × d). At a dead end's tip the ring doubles back and the
//!    normals cancel; the tip moves on by d instead, the road's end cap. Done in metres through the cell's metric.
//! 2. Then a walk around the ring: where a side crosses a later one, a vertex is made at the crossing and one of the
//!    two loops it closes is deleted, vertex by vertex, back to the new one. The loop deleted is the inverted one
//!    (negative area: the part the shrink turned inside out). If both loops are positive, the polygon has pinched
//!    in two; for now the smaller is deleted and counted. The walk resumes until a whole lap finds no crossing.
//!
//! Crossings are decided by exact orientation signs (no tolerance); touching or collinear sides are counted and left.

use crate::polygon::{MADE, Polygon};

/// A vertex in a very sharp corner stops at this many distances in.
const MITER: f64 = 4.0;

/// What shrinking ran into.
#[derive(Debug, Default)]
pub struct ShrinkStats {
    pub crossings: usize, // self-crossings cut away
    pub pinches: usize,   // crossings whose two loops were both positive: a piece was dropped
    pub touches: usize,   // sides touching or collinear (exact zero signs), left alone
    pub vanished: usize,  // polygons with nothing left: fewer than 3 vertices, or no positive area
}

impl Polygon {
    /// This polygon (counterclockwise) with every side pulled in by `d` metres, its self-crossings cut away; None if
    /// nothing is left. `metric` is the cell's metres per unit of s and t (s2::cell_metric).
    pub fn shrink(
        &self,
        d: f64,
        metric: [[f64; 2]; 2],
        stats: &mut ShrinkStats,
    ) -> Option<Polygon> {
        let mut p = self.moved_in(d, metric);
        p.cut_self_crossings(stats);
        if p.len() < 3 || p.signed_area() <= 0.0 {
            stats.vanished += 1;
            return None;
        }
        Some(p)
    }

    /// Step 1: every vertex moved in along its bisector, as a new polygon with the same sources.
    fn moved_in(&self, d: f64, metric: [[f64; 2]; 2]) -> Polygon {
        let [[a, c], [b, dd]] = metric; // metres = [a b; c dd] · (Δs, Δt)
        let det = a * dd - b * c;
        let verts: Vec<([f64; 2], u32)> = self.vertices().collect();
        let Some(&(o, _)) = verts.first() else {
            return Polygon::from_points([]);
        };
        // Positions in metres from the first vertex.
        let m: Vec<[f64; 2]> = verts
            .iter()
            .map(|&(p, _)| {
                let (ds, dt) = (p[0] - o[0], p[1] - o[1]);
                [a * ds + b * dt, c * ds + dd * dt]
            })
            .collect();
        let n = m.len();
        let unit = |v: [f64; 2]| {
            let l = v[0].hypot(v[1]);
            (l > 0.0).then(|| [v[0] / l, v[1] / l])
        };
        Polygon::from_points((0..n).map(|i| {
            let (prev, here, next) = (m[(i + n - 1) % n], m[i], m[(i + 1) % n]);
            let into = unit([here[0] - prev[0], here[1] - prev[1]]);
            let out = unit([next[0] - here[0], next[1] - here[1]]);
            // Inward is left of the direction of travel (counterclockwise ring).
            let left = |u: [f64; 2]| [-u[1], u[0]];
            let step = match (into, out) {
                (Some(u), Some(w)) => {
                    let (n1, n2) = (left(u), left(w));
                    match unit([n1[0] + n2[0], n1[1] + n2[1]]) {
                        Some(bis) => {
                            let cos_half = bis[0] * n1[0] + bis[1] * n1[1];
                            let dist = if cos_half > 0.0 {
                                (d / cos_half).min(MITER * d)
                            } else {
                                MITER * d
                            };
                            [bis[0] * dist, bis[1] * dist]
                        }
                        // Doubling back (a dead end's tip): straight on.
                        None => [u[0] * d, u[1] * d],
                    }
                }
                // A zero-length side: use the other one alone.
                (Some(u), None) | (None, Some(u)) => {
                    let n = left(u);
                    [n[0] * d, n[1] * d]
                }
                (None, None) => [0.0, 0.0],
            };
            let moved = [here[0] + step[0], here[1] + step[1]];
            // Back to (s, t): the inverse metric.
            let st = [
                o[0] + (dd * moved[0] - b * moved[1]) / det,
                o[1] + (a * moved[1] - c * moved[0]) / det,
            ];
            (st, verts[i].1)
        }))
    }

    /// Step 2: walk the ring cutting away self-crossings until a whole lap finds none.
    fn cut_self_crossings(&mut self, stats: &mut ShrinkStats) {
        let Some(mut v) = self.first_index() else {
            return;
        };
        let mut clean = 0;
        while self.len() >= 3 && clean < self.len() {
            match self.first_crossing(v, stats) {
                None => {
                    v = self.next_of(v);
                    clean += 1;
                }
                Some((w, x)) => {
                    v = self.cut_loop(v, w, x, stats);
                    stats.crossings += 1;
                    clean = 0;
                }
            }
        }
    }

    /// The first side after v's (scanning forward) that properly crosses it, and where: (w, the point), w being
    /// the crossing side's first vertex. Sides next to v's are skipped.
    fn first_crossing(&self, v: u32, stats: &mut ShrinkStats) -> Option<(u32, [f64; 2])> {
        let vn = self.next_of(v);
        let (p, q) = (self.pos_of(v), self.pos_of(vn));
        let mut w = self.next_of(vn);
        while self.next_of(w) != v {
            let wn = self.next_of(w);
            let (r, s) = (self.pos_of(w), self.pos_of(wn));
            let (o1, o2) = (orient(p, q, r), orient(p, q, s));
            let (o3, o4) = (orient(r, s, p), orient(r, s, q));
            if o1 * o2 < 0.0 && o3 * o4 < 0.0 {
                // Where they cross (a construction: the decision above was exact).
                let (dx, dy) = (q[0] - p[0], q[1] - p[1]);
                let (ex, ey) = (s[0] - r[0], s[1] - r[1]);
                let t = ((r[0] - p[0]) * ey - (r[1] - p[1]) * ex) / (dx * ey - dy * ex);
                return Some((w, [p[0] + t * dx, p[1] + t * dy]));
            }
            if (o1 == 0.0 || o2 == 0.0 || o3 == 0.0 || o4 == 0.0) && boxes_meet(p, q, r, s) {
                stats.touches += 1;
            }
            w = wn;
        }
        None
    }

    /// Sides v→vn and w→wn cross at x. The loop ahead is x, vn … w; the loop behind is x, wn … v. Deletes the
    /// inverted one (or, if both are positive, the smaller) and returns the vertex to resume the walk from.
    fn cut_loop(&mut self, v: u32, w: u32, x: [f64; 2], stats: &mut ShrinkStats) -> u32 {
        let (vn, wn) = (self.next_of(v), self.next_of(w));
        let ahead = self.loop_area(x, vn, w);
        let behind = self.loop_area(x, wn, v);
        if ahead > 0.0 && behind > 0.0 {
            stats.pinches += 1;
        }
        let delete_ahead = if ahead > 0.0 && behind > 0.0 {
            ahead < behind
        } else {
            ahead <= behind
        };
        // Insert the crossing after the side that stays, then delete forward from it back round to the other side.
        let (keep, stop) = if delete_ahead { (v, wn) } else { (w, vn) };
        let made = self.cursor(keep).insert_after(x, MADE);
        let mut c = self.cursor(self.next_of(made));
        while c.index() != stop {
            c.remove();
        }
        if delete_ahead { v } else { made }
    }

    /// Signed area of the loop x, from … to, x (shoelace relative to x).
    fn loop_area(&self, x: [f64; 2], from: u32, to: u32) -> f64 {
        let mut twice = 0.0;
        let mut v = from;
        loop {
            let (a, b) = (
                self.pos_of(v),
                if v == to {
                    x
                } else {
                    self.pos_of(self.next_of(v))
                },
            );
            twice += (a[0] - x[0]) * (b[1] - x[1]) - (b[0] - x[0]) * (a[1] - x[1]);
            if v == to {
                break;
            }
            v = self.next_of(v);
        }
        twice / 2.0
    }
}

/// Exact orientation: positive if a, b, c turn counterclockwise, negative clockwise, zero if collinear.
fn orient(a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> f64 {
    robust::orient2d(
        robust::Coord { x: a[0], y: a[1] },
        robust::Coord { x: b[0], y: b[1] },
        robust::Coord { x: c[0], y: c[1] },
    )
}

/// Whether two segments' bounding boxes overlap (with a zero sign, they then touch or overlap).
fn boxes_meet(p: [f64; 2], q: [f64; 2], r: [f64; 2], s: [f64; 2]) -> bool {
    p[0].min(q[0]) <= r[0].max(s[0])
        && r[0].min(s[0]) <= p[0].max(q[0])
        && p[1].min(q[1]) <= r[1].max(s[1])
        && r[1].min(s[1]) <= p[1].max(q[1])
}
