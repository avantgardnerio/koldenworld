//! Bands: the strips between two layers of the same blocks, one shrunk from the other (the grass between the kerb and
//! the sidewalk, the sidewalk between the grass and the lot).
//!
//! A band piece for dart h is the outer layer's run along h (its corner to the next corner), then the inner layer's
//! run along h back. Neighboring pieces share the edge between a corner on the outer layer and the same dart's corner
//! on the inner one, so the pieces tile the band all the way round, corners included. Where a face has no inner
//! islands left (the block was too narrow for more), its outer islands are band whole.

use crate::graph::RoadGraph;
use crate::layer::{Layer, Why, ccw};
use crate::polygon::Polygon;

#[derive(Default)]
pub struct Band {
    pub pieces: Vec<Polygon>,
    pub missing: usize, // darts whose piece couldn't be made
    pub why: Why,       // per missing piece: why its inner run wasn't found
}

/// The band between `outer` and `inner` (inner being outer's islands shrunk further).
pub fn band(g: &RoadGraph, outer: &Layer, inner: &Layer) -> Band {
    let mut out = Band::default();
    let mut whole = vec![false; inner.face_count()];
    for h in 0..2 * g.edge_count() as u32 {
        let Some(outer_run) = outer.run(h) else {
            continue;
        };
        let face = inner.face_of(h);
        if inner.islands(face).is_empty() {
            // Nothing left inside: the outer islands are band, once per face.
            if !std::mem::replace(&mut whole[face], true) {
                for ring in outer.islands(face) {
                    out.pieces.push(Polygon::from_points(ring.iter().copied()));
                }
            }
            continue;
        }
        match inner.run(h) {
            Some(inner_run) => out.pieces.push(ccw(outer_run
                .into_iter()
                .chain(inner_run.into_iter().rev()))),
            None => {
                out.missing += 1;
                inner.diagnose(h, &mut out.why);
            }
        }
    }
    out
}
