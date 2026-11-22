//! A layer: the islands every face was shrunk to (none for a face not shrunk or vanished), looked up by dart. Each
//! island vertex knows the dart whose side it's on and which is the corner where that side starts, so a dart's run
//! along any layer can be found, and layers built from each other line up dart by dart.

use crate::faces::Faces;
use crate::graph::RoadGraph;
use crate::polygon::{Polygon, corner_id, is_corner};
use glam::DVec2;

/// One island's ring as (position, id) pairs, in ring order.
pub type Ring = Vec<(DVec2, u32)>;

pub struct Layer {
    face_of: Vec<u32>,     // per dart: the face on its left
    rings: Vec<Vec<Ring>>, // per face: its islands' rings
}

/// Why a dart's run couldn't be found.
#[derive(Debug, Default)]
pub struct Why {
    pub no_islands: usize, // its face has no islands: an outside, or a block that vanished
    pub swallowed: usize,  // its face has islands, but none has the dart's corner
    pub twice: usize, // the corner appears twice in its island, apart (not as an end cap's pair)
    pub run_broken: usize, // the corner was found, but no other corner follows it
}

impl Layer {
    pub fn new(g: &RoadGraph, faces: &Faces, islands: &[Vec<Polygon>]) -> Layer {
        let mut face_of = vec![0; 2 * g.edge_count()];
        for f in 0..faces.count() {
            for &h in faces.darts(f) {
                face_of[h as usize] = f as u32;
            }
        }
        let rings = islands
            .iter()
            .map(|isl| isl.iter().map(|p| p.vertices().collect()).collect())
            .collect();
        Layer { face_of, rings }
    }

    pub fn face_count(&self) -> usize {
        self.rings.len()
    }

    /// The face on dart h's left.
    pub fn face_of(&self, h: u32) -> usize {
        self.face_of[h as usize] as usize
    }

    /// A face's islands, as rings.
    pub fn islands(&self, face: usize) -> &[Ring] {
        &self.rings[face]
    }

    /// The vertex at the corner where dart h's side starts.
    pub fn corner_vertex(&self, h: u32) -> Option<(DVec2, u32)> {
        let (i, j) = self.corner(h)?;
        Some(self.rings[self.face_of(h)][i][j])
    }

    /// The island's side along dart h: from its corner round its ring to the next corner (whichever dart's: darts in
    /// between may have been swallowed), both included; where that corner is two in a row (an end cap), through both,
    /// so the cap's own side belongs to the dart arriving at it.
    pub fn run(&self, h: u32) -> Option<Ring> {
        let (i, j) = self.corner(h)?;
        let ring = &self.rings[self.face_of(h)][i];
        let at = |k: usize| ring[(j + k) % ring.len()];
        let mut run = vec![ring[j]];
        let end = (1..ring.len()).find(|&k| is_corner(at(k).1))?;
        run.extend((1..=end).map(at));
        let mut k = end + 1;
        while k < ring.len() && at(k).1 == at(end).1 {
            run.push(at(k));
            k += 1;
        }
        Some(run)
    }

    /// Why run(h) fails, if it does.
    pub fn diagnose(&self, h: u32, why: &mut Why) {
        let face = &self.rings[self.face_of(h)];
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

    /// The corner where dart h's side starts: (island, position in its ring). Of two in a row (an end cap's corners),
    /// the second, the one the side leaves from.
    fn corner(&self, h: u32) -> Option<(usize, usize)> {
        let id = corner_id(h);
        self.rings[self.face_of(h)]
            .iter()
            .enumerate()
            .find_map(|(i, ring)| {
                let j = ring.iter().position(|v| v.1 == id)?;
                let next = (j + 1) % ring.len();
                Some((i, if ring[next].1 == id { next } else { j }))
            })
    }
}

/// A polygon through these points (a point repeating the one before it dropped: where two runs meet), turned
/// counterclockwise if they run clockwise.
pub fn ccw(points: impl Iterator<Item = (DVec2, u32)>) -> Polygon {
    let mut points: Ring = points.collect();
    points.dedup_by(|b, a| a.0 == b.0);
    if points.len() > 1 && points[0].0 == points[points.len() - 1].0 {
        points.pop();
    }
    if crate::geom::signed_area(points.iter().map(|p| p.0)) < 0.0 {
        points.reverse();
    }
    Polygon::from_points(points)
}
