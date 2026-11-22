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

/// (lane width m, shoulder m, marked: centerlines and lane lines), by class: as ROAD_PROFILES in
/// packages/world/src/road-surface.ts (tertiary and above are marked; US residential streets mostly aren't).
const PROFILES: [(f64, f64, bool); ROAD_CLASSES.len()] = [
    (3.7, 2.5, true),  // motorway
    (3.7, 1.5, true),  // motorway_link
    (3.6, 1.5, true),  // trunk
    (3.6, 1.0, true),  // trunk_link
    (3.4, 1.0, true),  // primary
    (3.4, 0.5, true),  // primary_link
    (3.4, 1.0, true),  // secondary
    (3.4, 0.5, true),  // secondary_link
    (3.3, 1.0, true),  // tertiary
    (3.3, 0.5, true),  // tertiary_link
    (3.0, 1.0, false), // unclassified
    (3.0, 1.0, false), // residential
    (3.0, 0.5, false), // living_street
    (2.8, 0.2, false), // service
    (3.0, 0.5, false), // road
];

/// Per dart: [kerb, grass, sidewalk] widths, m, out from the centerline.
pub fn dart_widths(g: &RoadGraph, ways: &RoadWays) -> Vec<[f64; 3]> {
    (0..2 * g.edge_count())
        .map(|h| {
            let w = g.edge_way[h / 2] as usize;
            let (lane, shoulder, _) = PROFILES[ways.class[w] as usize];
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

/// A class's (lane width m, shoulder m, marked).
pub fn profile(class: u8) -> (f64, f64, bool) {
    PROFILES[class as usize]
}
