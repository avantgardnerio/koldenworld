//! Simplified lines, for coarser tiers: each way's and each water line's and ring's points thinned by
//! Douglas–Peucker to within a tolerance, in metres, before anything is built from them. A way's ends and every node
//! it shares with a way (or with itself) stay, so the graph's junctions are the same; only the points between them go.

use crate::aeroways::Aeroways;
use crate::buildings::Buildings;
use crate::clip::UNITS;
use crate::geom::Metric;
use crate::s2;
use crate::water::Water;
use crate::ways::RoadWays;
use clipper2_rust::Path64;
use glam::DVec2;
use std::collections::HashMap;

/// The ways with only the points needed to stay within `tolerance` m of each line. Needs `ways.st`.
pub fn simplify(ways: &RoadWays, metric: &Metric, tolerance: f64) -> RoadWays {
    let mut uses: HashMap<i64, u32> = HashMap::new();
    for &id in &ways.node_id {
        *uses.entry(id).or_default() += 1;
    }
    let metres = |i: usize| metric.metres(DVec2::from_array(ways.st[i]));
    let mut keep = vec![false; ways.node_id.len()];
    for w in 0..ways.osm_id.len() {
        let (a, b) = (ways.node_start[w] as usize, ways.node_start[w + 1] as usize);
        // Fixed points: the ends and shared nodes; each run between two of them thinned on its own.
        let fixed: Vec<usize> = (a..b)
            .filter(|&i| i == a || i == b - 1 || uses[&ways.node_id[i]] >= 2)
            .collect();
        for run in fixed.windows(2) {
            keep[run[0]] = true;
            keep[run[1]] = true;
            douglas_peucker(run[0], run[1], &metres, tolerance, &mut keep);
        }
        keep[a] = true;
    }
    ways.keep_points(&keep)
}

/// The water with only the points needed to stay within `tolerance` m of each line and ring (their ends kept).
pub fn simplify_water(water: &Water, face: u32, metric: &Metric, tolerance: f64) -> Water {
    let metres = |i: usize| {
        let [lon, lat] = water.lonlat[i];
        metric.metres(DVec2::from_array(s2::face_st(face, lat, lon)))
    };
    let mut keep = vec![false; water.lonlat.len()];
    for runs in [&water.line_start, &water.ring_start] {
        for r in runs.windows(2) {
            let (a, b) = (r[0] as usize, r[1] as usize);
            if b > a {
                keep[a] = true;
                keep[b - 1] = true;
                douglas_peucker(a, b - 1, &metres, tolerance, &mut keep);
            }
        }
    }
    water.keep_points(&keep)
}

/// The airports with only the points needed to stay within `tolerance` m of each line and ring (their ends kept).
pub fn simplify_aeroways(a: &Aeroways, face: u32, metric: &Metric, tolerance: f64) -> Aeroways {
    let metres = |i: usize| {
        let [lon, lat] = a.lonlat[i];
        metric.metres(DVec2::from_array(s2::face_st(face, lat, lon)))
    };
    let mut keep = vec![false; a.lonlat.len()];
    for runs in [&a.line_start, &a.ring_start] {
        for r in runs.windows(2) {
            let (first, end) = (r[0] as usize, r[1] as usize);
            if end > first {
                keep[first] = true;
                keep[end - 1] = true;
                douglas_peucker(first, end - 1, &metres, tolerance, &mut keep);
            }
        }
    }
    a.keep_points(&keep)
}

/// The buildings with only the points needed to stay within `tolerance` m of each ring (its first and last, the
/// same point, kept).
pub fn simplify_buildings(b: &Buildings, face: u32, metric: &Metric, tolerance: f64) -> Buildings {
    let metres = |i: usize| {
        let [lon, lat] = b.lonlat[i];
        metric.metres(DVec2::from_array(s2::face_st(face, lat, lon)))
    };
    let mut keep = vec![false; b.lonlat.len()];
    for r in b.ring_start.windows(2) {
        let (first, last) = (r[0] as usize, r[1] as usize - 1);
        if last > first {
            keep[first] = true;
            keep[last] = true;
            // A closed ring: split at its farthest point from the first, so both halves have a real chord.
            let far = (first..=last)
                .max_by(|&x, &y| {
                    metres(x)
                        .distance(metres(first))
                        .total_cmp(&metres(y).distance(metres(first)))
                })
                .unwrap_or(first);
            keep[far] = true;
            douglas_peucker(first, far, &metres, tolerance, &mut keep);
            douglas_peucker(far, last, &metres, tolerance, &mut keep);
        }
    }
    b.keep_points(&keep)
}

/// A closed ring (Clipper path in metres × UNITS, not repeating its first point) with only the points needed to stay
/// within `tolerance` m; None if fewer than three are left.
pub fn simplify_ring(ring: &Path64, tolerance: f64) -> Option<Path64> {
    let n = ring.len();
    if n < 3 {
        return None;
    }
    let metres = |i: usize| {
        let p = ring[i % n];
        DVec2::new(p.x as f64, p.y as f64) / UNITS
    };
    let far = (0..n)
        .max_by(|&x, &y| {
            metres(x)
                .distance(metres(0))
                .total_cmp(&metres(y).distance(metres(0)))
        })
        .unwrap_or(0);
    let mut keep = vec![false; n + 1];
    keep[0] = true;
    keep[far] = true;
    douglas_peucker(0, far, &metres, tolerance, &mut keep);
    douglas_peucker(far, n, &metres, tolerance, &mut keep);
    let out: Path64 = (0..n).filter(|&i| keep[i]).map(|i| ring[i]).collect();
    (out.len() >= 3).then_some(out)
}

/// Marks the points between `first` and `last` (exclusive) that the line needs to stay within `tolerance`.
fn douglas_peucker(
    first: usize,
    last: usize,
    metres: &impl Fn(usize) -> DVec2,
    tolerance: f64,
    keep: &mut [bool],
) {
    let mut stack = vec![(first, last)];
    while let Some((a, b)) = stack.pop() {
        if b <= a + 1 {
            continue;
        }
        let (p, q) = (metres(a), metres(b));
        let (far, d) = (a + 1..b)
            .map(|i| (i, distance_to_segment(metres(i), p, q)))
            .fold((a, -1.0), |best, x| if x.1 > best.1 { x } else { best });
        if d > tolerance {
            keep[far] = true;
            stack.push((a, far));
            stack.push((far, b));
        }
    }
}

fn distance_to_segment(x: DVec2, p: DVec2, q: DVec2) -> f64 {
    let d = q - p;
    let t = if d.length_squared() > 0.0 {
        ((x - p).dot(d) / d.length_squared()).clamp(0.0, 1.0)
    } else {
        0.0
    };
    (x - (p + d * t)).length()
}
