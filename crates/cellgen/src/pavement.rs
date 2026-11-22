//! Pavement: the polygons where the roads go, in the void the shrunk blocks leave, built from the blocks' own
//! vertices through their sources (each shrunk vertex still knows the OSM point it came from).
//!
//! A block's ring leaves each node at the first point of a dart (an edge end traversed toward the other end), so its
//! corner there is the shrunk vertex sourced from that point. A road strip for edge e is the run of the block on
//! its left from its corner at one node to its corner at the other, then the run of the block on its right back
//! again (at a dead end, round the end cap's two corners). A junction, where three or more roads meet, is the ring
//! through the corners of the blocks around its node, in the node's counterclockwise order. Strips and junctions
//! share corners, so they tile the void. Where a corner is gone (the block vanished, an outside face isn't shrunk,
//! or a crossing replaced the vertex with a made one) the strip or junction is skipped and counted.

use crate::faces::Faces;
use crate::graph::RoadGraph;
use crate::polygon::Polygon;
use glam::DVec2;

/// One island's ring as (position, source) pairs, in ring order.
type Ring = Vec<(DVec2, u32)>;

#[derive(Default)]
pub struct Pavement {
    pub strips: Vec<Polygon>,
    pub junctions: Vec<Polygon>,
    pub missing_strips: usize,
    pub missing_junctions: usize,
    pub why: Why, // per strip side that failed
}

/// Why a strip's side couldn't be found.
#[derive(Debug, Default)]
pub struct Why {
    pub no_islands: usize, // its face has no islands: an outside, or a block that vanished
    pub no_corner: usize,  // no island vertex comes from the point the dart starts at
    pub twice: usize, // the corner's source appears twice in its island (not as an end cap's pair)
    pub run_broken: usize, // the corner was found, but the run never reaches the next dart's point
}

/// The roads between the islands each face was shrunk to (islands[f], empty for faces not shrunk or vanished).
pub fn pave(g: &RoadGraph, faces: &Faces, islands: &[Vec<Polygon>]) -> Pavement {
    let rings: Vec<Vec<Ring>> = islands
        .iter()
        .map(|isl| isl.iter().map(|p| p.vertices().collect()).collect())
        .collect();
    let around = Around::new(g, faces, rings);
    let mut out = Pavement::default();

    for e in 0..g.edge_count() as u32 {
        for h in [2 * e, 2 * e + 1] {
            around.diagnose(h, &mut out.why);
        }
        match (around.run(2 * e), around.run(2 * e + 1)) {
            (Some(left), Some(right)) => out.strips.push(ccw(left.into_iter().chain(right))),
            _ => out.missing_strips += 1,
        }
    }
    for n in (0..g.node_count()).filter(|&n| g.degree(n) >= 3) {
        let corners: Option<Ring> = g
            .ends_at(n)
            .iter()
            .map(|&h| around.corner_vertex(h))
            .collect();
        match corners {
            Some(c) => out.junctions.push(ccw(c.into_iter())),
            None => out.missing_junctions += 1,
        }
    }
    out
}

/// A polygon through these points, turned counterclockwise if they run clockwise.
fn ccw(points: impl Iterator<Item = (DVec2, u32)>) -> Polygon {
    let mut points: Ring = points.collect();
    if crate::geom::signed_area(points.iter().map(|p| p.0)) < 0.0 {
        points.reverse();
    }
    Polygon::from_points(points)
}

/// Where each dart's corners and runs are among the shrunk islands.
struct Around<'a> {
    g: &'a RoadGraph,
    face_of: Vec<u32>,   // per dart: the face on its left
    next_dart: Vec<u32>, // per dart: the next dart around its face
    rings: Vec<Vec<Ring>>,
}

impl<'a> Around<'a> {
    fn new(g: &'a RoadGraph, faces: &Faces, rings: Vec<Vec<Ring>>) -> Around<'a> {
        let darts = 2 * g.edge_count();
        let (mut face_of, mut next_dart) = (vec![0; darts], vec![0; darts]);
        for f in 0..faces.count() {
            let d = faces.darts(f);
            for (i, &h) in d.iter().enumerate() {
                face_of[h as usize] = f as u32;
                next_dart[h as usize] = d[(i + 1) % d.len()];
            }
        }
        Around {
            g,
            face_of,
            next_dart,
            rings,
        }
    }

    /// The OSM point a dart starts at: its edge's first point, or last if the dart runs backward.
    fn start(&self, h: u32) -> u32 {
        let e = (h / 2) as usize;
        if h.is_multiple_of(2) {
            self.g.edge_first[e]
        } else {
            self.g.edge_last[e]
        }
    }

    /// The block's corner where dart h leaves its node: (island, position in its ring). Of two vertices in a row from
    /// the same point (an end cap's corners), the second, the one the dart leaves from.
    fn corner(&self, h: u32) -> Option<(usize, usize)> {
        let source = self.start(h);
        self.rings[self.face_of[h as usize] as usize]
            .iter()
            .enumerate()
            .find_map(|(i, ring)| {
                let j = ring.iter().position(|v| v.1 == source)?;
                let next = (j + 1) % ring.len();
                Some((i, if ring[next].1 == source { next } else { j }))
            })
    }

    fn corner_vertex(&self, h: u32) -> Option<(DVec2, u32)> {
        let (i, j) = self.corner(h)?;
        Some(self.rings[self.face_of[h as usize] as usize][i][j])
    }

    /// Why run(h) fails, if it does.
    fn diagnose(&self, h: u32, why: &mut Why) {
        let face = &self.rings[self.face_of[h as usize] as usize];
        if face.is_empty() {
            why.no_islands += 1;
            return;
        }
        let source = self.start(h);
        let Some((i, j)) = self.corner(h) else {
            why.no_corner += 1;
            return;
        };
        let ring = &face[i];
        let copies = ring.iter().filter(|v| v.1 == source).count();
        let pair = ring[(j + ring.len() - 1) % ring.len()].1 == source;
        if copies > 2 || (copies == 2 && !pair) {
            why.twice += 1;
        }
        if self.run(h).is_none() {
            why.run_broken += 1;
        }
    }

    /// The block's side along dart h: from its corner where h leaves its node, round its ring to its corner where the
    /// next dart leaves (the first vertex from that point), both included.
    fn run(&self, h: u32) -> Option<Ring> {
        let (i, j) = self.corner(h)?;
        let ring = &self.rings[self.face_of[h as usize] as usize][i];
        let end = self.start(self.next_dart[h as usize]);
        let mut run = vec![ring[j]];
        for k in 1..ring.len() {
            let v = ring[(j + k) % ring.len()];
            run.push(v);
            if v.1 == end {
                return Some(run);
            }
        }
        None
    }
}
