//! A polygon as a rubber band: a ring of vertices you can ride around forever (next after the last is the first),
//! inserting and removing as you go, each vertex remembering where it came from.
//!
//! Stored as columns with links (a doubly linked ring by index), so insert and remove are O(1) and never move other
//! vertices: a vertex's index stays valid until it's removed. Removed slots go on a free list for reuse.

/// No source: a vertex we made rather than read.
pub const MADE: u32 = u32::MAX;
/// No vertex.
const NONE: u32 = u32::MAX;

#[derive(Default)]
pub struct Polygon {
    st: Vec<[f64; 2]>, // position, on the cell's face
    source: Vec<u32>,  // the OSM point (index into the ways' node columns) it came from, or MADE
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
    pub fn from_points(points: impl IntoIterator<Item = ([f64; 2], u32)>) -> Polygon {
        let mut p = Polygon {
            head: NONE,
            ..Default::default()
        };
        for (st, source) in points {
            p.st.push(st);
            p.source.push(source);
        }
        let n = p.st.len() as u32;
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

    #[allow(dead_code)] // used once vertices start moving
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// A cursor on the ring's first vertex, or None if it's empty.
    #[allow(dead_code)] // the shrink refactor uses it
    pub fn first(&mut self) -> Option<Cursor<'_>> {
        let at = self.head;
        (at != NONE).then_some(Cursor { poly: self, at })
    }

    /// A cursor on a vertex by index (from Cursor::index; still in the ring).
    pub fn cursor(&mut self, at: u32) -> Cursor<'_> {
        Cursor { poly: self, at }
    }

    /// The first vertex's index, or None if the ring is empty. With next_of and pos_of, for reading the ring
    /// anywhere while a cursor isn't held (two places at once, e.g. scanning ahead of a vertex).
    pub fn first_index(&self) -> Option<u32> {
        (self.head != NONE).then_some(self.head)
    }

    pub fn next_of(&self, v: u32) -> u32 {
        self.next[v as usize]
    }

    pub fn pos_of(&self, v: u32) -> [f64; 2] {
        self.st[v as usize]
    }

    /// Every vertex's position and source, once around from the first.
    pub fn vertices(&self) -> impl Iterator<Item = ([f64; 2], u32)> + '_ {
        let mut at = self.head;
        (0..self.len).map(move |_| {
            let v = (self.st[at as usize], self.source[at as usize]);
            at = self.next[at as usize];
            v
        })
    }

    /// Every vertex's position, once around from the first.
    pub fn positions(&self) -> impl Iterator<Item = [f64; 2]> + '_ {
        let mut at = self.head;
        (0..self.len).map(move |_| {
            let p = self.st[at as usize];
            at = self.next[at as usize];
            p
        })
    }

    /// Signed area in (s, t) units, positive counterclockwise (shoelace relative to the first vertex).
    pub fn signed_area(&self) -> f64 {
        let mut it = self.positions();
        let Some(o) = it.next() else { return 0.0 };
        let points: Vec<[f64; 2]> = it.collect();
        let mut twice = 0.0;
        for w in points.windows(2) {
            let (a, b) = (w[0], w[1]);
            twice += (a[0] - o[0]) * (b[1] - o[1]) - (b[0] - o[0]) * (a[1] - o[1]);
        }
        twice / 2.0
    }
}

impl Cursor<'_> {
    /// The vertex's index: stable until it's removed, for Polygon::cursor.
    pub fn index(&self) -> u32 {
        self.at
    }

    #[allow(dead_code)] // the shrink refactor uses it
    pub fn pos(&self) -> [f64; 2] {
        self.poly.st[self.at as usize]
    }

    #[allow(dead_code)] // used once vertices start moving
    pub fn set_pos(&mut self, st: [f64; 2]) {
        self.poly.st[self.at as usize] = st;
    }

    /// The OSM point it came from, or MADE.
    #[allow(dead_code)] // the shrink refactor uses it
    pub fn source(&self) -> u32 {
        self.poly.source[self.at as usize]
    }

    /// The next vertex's position, without moving.
    #[allow(dead_code)] // the shrink refactor uses it
    pub fn next_pos(&self) -> [f64; 2] {
        self.poly.st[self.poly.next[self.at as usize] as usize]
    }

    /// The previous vertex's position, without moving.
    #[allow(dead_code)] // used once vertices start moving
    pub fn prev_pos(&self) -> [f64; 2] {
        self.poly.st[self.poly.prev[self.at as usize] as usize]
    }

    /// Move to the next vertex (after the last comes the first).
    #[allow(dead_code)] // the shrink refactor uses it
    pub fn next(&mut self) {
        self.at = self.poly.next[self.at as usize];
    }

    /// Move to the previous vertex.
    #[allow(dead_code)] // used once vertices start moving
    pub fn prev(&mut self) {
        self.at = self.poly.prev[self.at as usize];
    }

    /// Insert a vertex after this one; the cursor stays here. Returns the new vertex's index.
    pub fn insert_after(&mut self, st: [f64; 2], source: u32) -> u32 {
        let p = &mut *self.poly;
        let v = match p.free.pop() {
            Some(v) => {
                p.st[v as usize] = st;
                p.source[v as usize] = source;
                v
            }
            None => {
                p.st.push(st);
                p.source.push(source);
                p.next.push(NONE);
                p.prev.push(NONE);
                (p.st.len() - 1) as u32
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

    /// Remove this vertex and move to the next one. Returns false if that emptied the polygon (the cursor is then
    /// done).
    pub fn remove(&mut self) -> bool {
        let p = &mut *self.poly;
        let (before, after) = (p.prev[self.at as usize], p.next[self.at as usize]);
        p.free.push(self.at);
        p.len -= 1;
        if p.len == 0 {
            p.head = NONE;
            return false;
        }
        p.next[before as usize] = after;
        p.prev[after as usize] = before;
        if p.head == self.at {
            p.head = after;
        }
        self.at = after;
        true
    }
}
