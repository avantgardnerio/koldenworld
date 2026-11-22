//! How wide each side of each road is, by dart: the kerb (half the road), then the grass strip and the sidewalk on a
//! side that has a sidewalk, none on a side that hasn't (the lot runs to the kerb: a freeway's side).
//!
//! Half the road is (lanes forward + lanes back) × the class's lane width ÷ 2 + its shoulder, as the TS road surface
//! (road-surface.ts ROAD_PROFILES, edgeHalfWidth), the same on both sides of the OSM centerline. Dart 2e runs the way's
//! direction, so its side (the face on its left) is the way's left; dart 2e + 1 has the right.

use crate::graph::RoadGraph;
use crate::ways::{ROAD_CLASSES, RoadWays, SIDEWALK_LEFT, SIDEWALK_RIGHT};

/// Grass strip and sidewalk, m, where a side has a sidewalk.
pub const GRASS: f64 = 1.5;
pub const SIDEWALK: f64 = 1.8;

/// (lane width, shoulder), m, by class: as ROAD_PROFILES in packages/world/src/road-surface.ts.
const PROFILES: [(f64, f64); ROAD_CLASSES.len()] = [
    (3.7, 2.5), // motorway
    (3.7, 1.5), // motorway_link
    (3.6, 1.5), // trunk
    (3.6, 1.0), // trunk_link
    (3.4, 1.0), // primary
    (3.4, 0.5), // primary_link
    (3.4, 1.0), // secondary
    (3.4, 0.5), // secondary_link
    (3.3, 1.0), // tertiary
    (3.3, 0.5), // tertiary_link
    (3.0, 1.0), // unclassified
    (3.0, 1.0), // residential
    (3.0, 0.5), // living_street
    (2.8, 0.2), // service
    (3.0, 0.5), // road
];

/// Per dart: [kerb, grass, sidewalk] widths, m, out from the centerline.
pub fn dart_widths(g: &RoadGraph, ways: &RoadWays) -> Vec<[f64; 3]> {
    (0..2 * g.edge_count())
        .map(|h| {
            let w = g.edge_way[h / 2] as usize;
            let (lane, shoulder) = PROFILES[ways.class[w] as usize];
            let lanes = (ways.lanes_fwd[w] + ways.lanes_back[w]) as f64;
            let side = if h % 2 == 0 {
                SIDEWALK_LEFT
            } else {
                SIDEWALK_RIGHT
            };
            let walk = ways.sidewalks[w] & side != 0;
            let kerb = lanes * lane / 2.0 + shoulder;
            if walk {
                [kerb, GRASS, SIDEWALK]
            } else {
                [kerb, 0.0, 0.0]
            }
        })
        .collect()
}
