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

use crate::graph::RoadGraph;
use crate::layer::{Layer, Ring, Why, ccw};
use crate::polygon::Polygon;

#[derive(Default)]
pub struct Pavement {
    pub strips: Vec<Polygon>,
    pub junctions: Vec<Polygon>,
    pub missing_strips: usize,
    pub missing_junctions: usize,
    pub why: Why, // per strip side that failed
}

/// The roads between the kerbs: `kerb` is the blocks shrunk by half a road.
pub fn pave(g: &RoadGraph, kerb: &Layer) -> Pavement {
    let mut out = Pavement::default();
    for e in 0..g.edge_count() as u32 {
        for h in [2 * e, 2 * e + 1] {
            kerb.diagnose(h, &mut out.why);
        }
        match (kerb.run(2 * e), kerb.run(2 * e + 1)) {
            (Some(left), Some(right)) => out.strips.push(ccw(left.into_iter().chain(right))),
            _ => out.missing_strips += 1,
        }
    }
    for n in (0..g.node_count()).filter(|&n| g.degree(n) >= 3) {
        let corners: Ring = g
            .ends_at(n)
            .iter()
            .filter_map(|&h| kerb.corner_vertex(h))
            .collect();
        if corners.len() >= 3 {
            out.junctions.push(ccw(corners.into_iter()));
        } else {
            out.missing_junctions += 1;
        }
    }
    out
}
