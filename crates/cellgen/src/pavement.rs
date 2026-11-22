//! Pavement: the polygons where the roads go, in the void the shrunk blocks leave, built from the blocks' own
//! vertices through their ids (each shrunk vertex knows the dart whose side it's on, and which is the corner where
//! that side starts).
//!
//! A road strip for edge e is the run of the block on its left from the corner of dart 2e to the next corner round
//! its ring, then the run of the block on its right from the corner of dart 2e + 1 to its next corner (at a dead end,
//! round the end cap's two corners). A junction, where three or more roads meet, is the ring through the corners of
//! the blocks around its node, in the node's counterclockwise order. Strips and junctions share corners, so they
//! tile the void. A dart with no corner left was swallowed (its whole side lies inside the junction's overshoot): its
//! strip isn't made and the junction goes without it. A face with no islands (an outside, a vanished block) leaves
//! its strips unmade.

use crate::faces::Faces;
use crate::graph::RoadGraph;
use crate::polygon::{Polygon, corner_id, is_corner};
use glam::DVec2;

/// One island's ring as (position, id) pairs, in ring order.
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
    pub swallowed: usize,  // its face has islands, but none has the dart's corner
    pub twice: usize, // the corner appears twice in its island, apart (not as an end cap's pair)
    pub run_broken: usize, // the corner was found, but no other corner follows it
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
        let corners: Ring = g
            .ends_at(n)
            .iter()
            .filter_map(|&h| around.corner_vertex(h))
            .collect();
        if corners.len() >= 3 {
            out.junctions.push(ccw(corners.into_iter()));
        } else {
            out.missing_junctions += 1;
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
struct Around {
    face_of: Vec<u32>, // per dart: the face on its left
    rings: Vec<Vec<Ring>>,
}

impl Around {
    fn new(g: &RoadGraph, faces: &Faces, rings: Vec<Vec<Ring>>) -> Around {
        let darts = 2 * g.edge_count();
        let mut face_of = vec![0; darts];
        for f in 0..faces.count() {
            for &h in faces.darts(f) {
                face_of[h as usize] = f as u32;
            }
        }
        Around { face_of, rings }
    }

    /// The block's corner where dart h's side starts: (island, position in its ring). Of two in a row (an end cap's
    /// corners), the second, the one the side leaves from.
    fn corner(&self, h: u32) -> Option<(usize, usize)> {
        let id = corner_id(h);
        self.rings[self.face_of[h as usize] as usize]
            .iter()
            .enumerate()
            .find_map(|(i, ring)| {
                let j = ring.iter().position(|v| v.1 == id)?;
                let next = (j + 1) % ring.len();
                Some((i, if ring[next].1 == id { next } else { j }))
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
        let id = corner_id(h);
        let Some((i, j)) = self.corner(h) else {
            why.swallowed += 1;
            return;
        };
        let ring = &face[i];
        let copies = ring.iter().filter(|v| v.1 == id).count();
        let pair = ring[(j + ring.len() - 1) % ring.len()].1 == id;
        if copies > 2 || (copies == 2 && !pair) {
            why.twice += 1;
        }
        if self.run(h).is_none() {
            why.run_broken += 1;
        }
    }

    /// The block's side along dart h: from its corner round its ring to the next corner (whichever dart's: darts in
    /// between may have been swallowed), both included.
    fn run(&self, h: u32) -> Option<Ring> {
        let (i, j) = self.corner(h)?;
        let ring = &self.rings[self.face_of[h as usize] as usize][i];
        let mut run = vec![ring[j]];
        for k in 1..ring.len() {
            let v = ring[(j + k) % ring.len()];
            run.push(v);
            if is_corner(v.1) {
                return Some(run);
            }
        }
        None
    }
}
