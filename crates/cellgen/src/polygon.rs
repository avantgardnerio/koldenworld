//! A polygon as a rubber band: a ring of vertices you can ride around forever (next after the last is the first),
//! inserting and removing as you go, each vertex remembering where it came from. Rings are counterclockwise: the
//! inside is on the left of travel.
//!
//! Stored as columns with links (a doubly linked ring by index), so insert and remove are O(1) and never move other
//! vertices: a vertex's index stays valid until it's removed. Removed slots go on a free list for reuse.

use crate::geom::{self, Metric, Segment};
use glam::DVec2;

/// No source: a vertex we made rather than read.
pub const MADE: u32 = u32::MAX;
/// No vertex.
const NONE: u32 = u32::MAX;

#[derive(Default)]
pub struct Polygon {
    pos: Vec<DVec2>,  // in (s, t) on the cell's face, or metres (in_metres)
    source: Vec<u32>, // the OSM point (index into the ways' node columns) it came from, or MADE
    next: Vec<u32>,
    prev: Vec<u32>,
    free: Vec<u32>, // removed slots, for reuse
    head: u32,      // a vertex in the ring (NONE when empty)
    len: usize,
}

/// A place on a polygon's ring, riding the band. Holds the polygon mutably: one cursor at a time.
pub struct Cursor<'a> {
    poly: &'a mut Polygon,
    at: u32,
}

impl Polygon {
    /// A ring through these points in order (closed implicitly: the last links back to the first).
    pub fn from_points(points: impl IntoIterator<Item = (DVec2, u32)>) -> Polygon {
        let mut p = Polygon {
            head: NONE,
            ..Default::default()
        };
        for (pos, source) in points {
            p.pos.push(pos);
            p.source.push(source);
        }
        let n = p.pos.len() as u32;
        if n > 0 {
            p.next = (0..n).map(|i| (i + 1) % n).collect();
            p.prev = (0..n).map(|i| (i + n - 1) % n).collect();
            p.head = 0;
        }
        p.len = n as usize;
        p
    }

    pub fn len(&self) -> usize {
        self.len
    }

    /// A cursor on the ring's first vertex, or None if it's empty.
    pub fn first(&mut self) -> Option<Cursor<'_>> {
        let at = self.head;
        (at != NONE).then_some(Cursor { poly: self, at })
    }

    /// Every vertex's position and source, once around from the first.
    pub fn vertices(&self) -> impl Iterator<Item = (DVec2, u32)> + '_ {
        self.run(self.head, self.len)
            .map(|v| (self.pos[v as usize], self.source[v as usize]))
    }

    /// Every vertex's position, once around from the first.
    pub fn positions(&self) -> impl Iterator<Item = DVec2> + '_ {
        self.run(self.head, self.len).map(|v| self.pos[v as usize])
    }

    /// Signed area, positive counterclockwise.
    pub fn signed_area(&self) -> f64 {
        geom::signed_area(self.positions())
    }

    /// Whether anything is left: at least a triangle, wound counterclockwise.
    pub fn is_solid(&self) -> bool {
        self.len >= 3 && self.signed_area() > 0.0
    }

    /// The same ring in metres around the cell (from (s, t)), and back.
    pub fn in_metres(&self, metric: &Metric) -> Polygon {
        Polygon::from_points(self.vertices().map(|(p, s)| (metric.metres(p), s)))
    }

    pub fn in_st(&self, metric: &Metric) -> Polygon {
        Polygon::from_points(self.vertices().map(|(p, s)| (metric.st(p), s)))
    }

    /// Drops every vertex at the same position as the one after it, so no side has zero length.
    pub fn drop_repeats(&mut self) {
        let Some(mut v) = self.first() else { return };
        let mut clean = 0;
        while clean < v.ring_len() && v.ring_len() > 1 {
            if v.pos() == v.side_out().b {
                v.remove();
                clean = 0;
            } else {
                v.next();
                clean += 1;
            }
        }
    }

    /// `count` vertex indices, following the ring from `from`.
    fn run(&self, from: u32, count: usize) -> impl Iterator<Item = u32> + '_ {
        let mut at = from;
        (0..count).map(move |_| {
            let v = at;
            at = self.next[at as usize];
            v
        })
    }
}

impl Cursor<'_> {
    /// The vertex's index: stable until it's removed, for jump.
    pub fn index(&self) -> u32 {
        self.at
    }

    /// The ring's vertex count.
    pub fn ring_len(&self) -> usize {
        self.poly.len
    }

    pub fn pos(&self) -> DVec2 {
        self.poly.pos[self.at as usize]
    }

    pub fn set_pos(&mut self, pos: DVec2) {
        self.poly.pos[self.at as usize] = pos;
    }

    /// The side arriving here: previous vertex → this one.
    pub fn side_in(&self) -> Segment {
        let prev = self.poly.prev[self.at as usize];
        Segment {
            a: self.poly.pos[prev as usize],
            b: self.pos(),
        }
    }

    /// The side leaving here: this vertex → the next.
    pub fn side_out(&self) -> Segment {
        self.side_from(self.at)
    }

    /// The sides that don't touch side_out (it and its two neighbors excluded), in ring order: each with the index
    /// of its first vertex.
    pub fn sides_ahead(&self) -> impl Iterator<Item = (u32, Segment)> + '_ {
        let p = &*self.poly;
        let start = p.next[p.next[self.at as usize] as usize];
        let count = self.poly.len.saturating_sub(3);
        p.run(start, count).map(|w| (w, self.side_from(w)))
    }

    /// Positions from this vertex's next, through `to`, in ring order.
    pub fn positions_ahead(&self, to: u32) -> impl Iterator<Item = DVec2> + '_ {
        let p = &*self.poly;
        let mut at = p.next[self.at as usize];
        let mut done = false;
        std::iter::from_fn(move || {
            if done {
                return None;
            }
            done = at == to;
            let pos = p.pos[at as usize];
            at = p.next[at as usize];
            Some(pos)
        })
    }

    /// The index of the vertex after `v` (for marking where a run ends before cutting it).
    pub fn next_after(&self, v: u32) -> u32 {
        self.poly.next[v as usize]
    }

    /// Move to the next vertex (after the last comes the first).
    pub fn next(&mut self) {
        self.at = self.poly.next[self.at as usize];
    }

    /// Move to a vertex by index (still in the ring).
    pub fn jump(&mut self, at: u32) {
        self.at = at;
    }

    /// Insert a vertex after this one; the cursor stays here. Returns the new vertex's index.
    pub fn insert_after(&mut self, pos: DVec2, source: u32) -> u32 {
        let p = &mut *self.poly;
        let v = match p.free.pop() {
            Some(v) => {
                p.pos[v as usize] = pos;
                p.source[v as usize] = source;
                v
            }
            None => {
                p.pos.push(pos);
                p.source.push(source);
                p.next.push(NONE);
                p.prev.push(NONE);
                (p.pos.len() - 1) as u32
            }
        };
        let after = p.next[self.at as usize];
        p.next[v as usize] = after;
        p.prev[v as usize] = self.at;
        p.next[self.at as usize] = v;
        p.prev[after as usize] = v;
        p.len += 1;
        v
    }

    /// Remove this vertex and move to the next one (removing the last empties the ring; the cursor is then done).
    pub fn remove(&mut self) {
        let p = &mut *self.poly;
        let (before, after) = (p.prev[self.at as usize], p.next[self.at as usize]);
        p.free.push(self.at);
        p.len -= 1;
        if p.len == 0 {
            p.head = NONE;
            return;
        }
        p.next[before as usize] = after;
        p.prev[after as usize] = before;
        if p.head == self.at {
            p.head = after;
        }
        self.at = after;
    }

    fn side_from(&self, v: u32) -> Segment {
        let p = &*self.poly;
        Segment {
            a: p.pos[v as usize],
            b: p.pos[p.next[v as usize] as usize],
        }
    }
}
