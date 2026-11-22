//! The polygons of the raw road graph: its faces, the areas between roads.
//!
//! A dart is an edge end (graph end id) traversed toward the edge's other end. Arriving at a node on end h, the next
//! dart is the end just clockwise of h around that node (ends sorted counterclockwise): the sharpest left turn, so
//! the face stays on the left. Every dart is on exactly one face. Blocks come out counterclockwise (positive area),
//! each connected piece's outside clockwise (negative area), and a dead end is walked out and back.

use crate::graph::RoadGraph;
use crate::ways::RoadWays;

/// Faces as indices: face f is the darts face_darts[face_start[f]..face_start[f + 1]], in order (CSR).
#[derive(Default)]
pub struct Faces {
    pub face_start: Vec<u32>,
    pub face_darts: Vec<u32>,
}

impl Faces {
    pub fn count(&self) -> usize {
        self.face_start.len() - 1
    }

    pub fn darts(&self, f: usize) -> &[u32] {
        &self.face_darts[self.face_start[f] as usize..self.face_start[f + 1] as usize]
    }

    /// A face's outline in (s, t): every point along its darts, each junction once.
    pub fn outline(&self, f: usize, g: &RoadGraph, ways: &RoadWays, out: &mut Vec<[f64; 2]>) {
        out.clear();
        for &h in self.darts(f) {
            let e = (h / 2) as usize;
            let (first, last) = (g.edge_first[e] as usize, g.edge_last[e] as usize);
            // Every point of the dart but its last: the next dart starts there.
            if h % 2 == 0 {
                out.extend_from_slice(&ways.st[first..last]);
            } else {
                out.extend(ways.st[first + 1..=last].iter().rev());
            }
        }
    }
}

/// Every face of a graph whose ends are sorted counterclockwise (sort_ends_by_angle).
pub fn trace_faces(g: &RoadGraph) -> Faces {
    // Each end's node and position in that node's list, to find its clockwise neighbor.
    let ends = 2 * g.edge_count();
    let mut node_of = vec![0u32; ends];
    let mut at = vec![0u32; ends];
    for n in 0..g.node_count() {
        for (i, &h) in g.ends_at(n).iter().enumerate() {
            node_of[h as usize] = n as u32;
            at[h as usize] = i as u32;
        }
    }
    let next = |h: u32| {
        let arrive = h ^ 1; // the dart's far end
        let n = node_of[arrive as usize] as usize;
        let around = g.ends_at(n);
        let i = at[arrive as usize] as usize;
        around[(i + around.len() - 1) % around.len()]
    };

    let mut faces = Faces {
        face_start: vec![0],
        ..Default::default()
    };
    let mut seen = vec![false; ends];
    for start in 0..ends as u32 {
        if seen[start as usize] {
            continue;
        }
        let mut h = start;
        loop {
            seen[h as usize] = true;
            faces.face_darts.push(h);
            h = next(h);
            if h == start {
                break;
            }
        }
        faces.face_start.push(faces.face_darts.len() as u32);
    }
    faces
}

/// Signed area of an outline in (s, t) units (shoelace, relative to its first point to keep precision): positive
/// counterclockwise.
pub fn signed_area(points: &[[f64; 2]]) -> f64 {
    let o = points[0];
    let mut twice = 0.0;
    for k in 1..points.len().saturating_sub(1) {
        let (a, b) = (points[k], points[k + 1]);
        twice += (a[0] - o[0]) * (b[1] - o[1]) - (b[0] - o[0]) * (a[1] - o[1]);
    }
    twice / 2.0
}
