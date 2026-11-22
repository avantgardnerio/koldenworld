//! Road markings, as the TS road surface draws them (road-surface.ts): on marked classes (tertiary and above), a
//! double yellow line on two-way roads at c = (lanes back − lanes forward) × lane width ÷ 2 right of the centerline,
//! and dashed white lines between lanes running the same way, a lane width apart from c (3 m dashes, 9 m gaps: US).
//! They stop 1 m short of a dead end's end and run through plain joins (degree 2).
//!
//! Intersections get none: a junction zone is where the pavement strips of the roads meeting at a node (three or
//! more) overlap, plus 1 m. Everything comes back as Clipper paths (metres around the cell, on its grid), the lines
//! still to be cut to the pavement.

use crate::clip::{UNITS, point};
use crate::crossings;
use crate::geom::Metric;
use crate::graph::RoadGraph;
use crate::polygon::MADE;
use crate::ways::RoadWays;
use crate::widths::profile;
use clipper2_rust::{
    EndType, FillRule, JoinType, Path64, Paths64, inflate_paths_64, intersect_64, union_subjects_64,
};
use glam::DVec2;

const WIDTH: f64 = 0.12; // a line, m
const DOUBLE_GAP: f64 = 0.18; // between the two yellow lines, m
const DASH: f64 = 3.0; // US: 10 ft lines,
const GAP: f64 = 9.0; // 30 ft gaps
const CLEAR: f64 = 1.0; // kept free around a junction or before a dead end, m
/// How far along each road from a node its strip is considered for the junction zone, m.
const NEAR: f64 = 40.0;

pub struct Lines {
    pub yellow: Paths64,
    pub white: Paths64,
}

/// Every marked road's lines, uncut. `near` selects which edges to mark (by their points, in metres).
pub fn lines(
    g: &RoadGraph,
    ways: &RoadWays,
    metric: &Metric,
    near: impl Fn(DVec2) -> bool,
) -> Lines {
    let (mut yellow, mut white): (Vec<Vec<DVec2>>, Vec<Vec<DVec2>>) = (Vec::new(), Vec::new());
    for e in 0..g.edge_count() {
        let w = g.edge_way[e] as usize;
        let (lane, _, marked) = profile(ways.class[w]);
        let line = centerline(g, ways, metric, e);
        if !marked || !line.iter().any(|&p| near(p)) {
            continue;
        }
        // Stop short of a dead end.
        let dead = |n: u32| g.degree(n as usize) == 1;
        let from = if dead(g.edge_from[e]) { CLEAR } else { 0.0 };
        let to = length(&line) - if dead(g.edge_to[e]) { CLEAR } else { 0.0 };
        if to - from < DASH {
            continue;
        }
        let line = slice(&line, from, to);

        let (fwd, back) = (ways.lanes_fwd[w] as f64, ways.lanes_back[w] as f64);
        let c = (back - fwd) * lane / 2.0;
        if back > 0.0 {
            let o = (DOUBLE_GAP + WIDTH) / 2.0;
            yellow.push(offset(&line, c - o));
            yellow.push(offset(&line, c + o));
        }
        let dividers = (1..fwd as usize)
            .map(|i| c + i as f64 * lane)
            .chain((1..back as usize).map(|i| c - i as f64 * lane));
        for o in dividers {
            let side = offset(&line, o);
            let len = length(&side);
            let mut s = 0.0;
            while s + DASH <= len {
                white.push(slice(&side, s, s + DASH));
                s += DASH + GAP;
            }
        }
    }
    let ribbons = |lines: Vec<Vec<DVec2>>| {
        let paths: Paths64 = lines
            .iter()
            .map(|l| l.iter().map(|&p| point(p, MADE)).collect())
            .collect();
        inflate_paths_64(
            &paths,
            WIDTH / 2.0 * UNITS,
            JoinType::Miter,
            EndType::Butt,
            4.0,
            0.0,
        )
    };
    Lines {
        yellow: ribbons(yellow),
        white: ribbons(white),
    }
}

/// Where markings stop: at each node where three or more roads meet, the overlap of their pavement strips (each the
/// road's first NEAR metres from the node, its half width `half_width[e]` either side), grown by CLEAR.
pub fn junction_zones(
    g: &RoadGraph,
    ways: &RoadWays,
    metric: &Metric,
    half_width: &[f64],
    near: impl Fn(DVec2) -> bool,
) -> Paths64 {
    let mut zones = Paths64::new();
    // Junctions: three or more ends, and a node OSM has (a road crossing over another meets it at none).
    let junction = |n: usize| {
        g.degree(n) >= 3 && !crossings::is_crossing(ways.node_id[g.node_point[n] as usize])
    };
    for n in (0..g.node_count()).filter(|&n| junction(n)) {
        if !near(metric.metres(DVec2::from_array(ways.st[g.node_point[n] as usize]))) {
            continue;
        }
        let strips: Vec<Paths64> = g
            .ends_at(n)
            .iter()
            .map(|&h| {
                let e = (h / 2) as usize;
                let mut line = centerline(g, ways, metric, e);
                if h % 2 == 1 {
                    line.reverse();
                }
                let line = slice(&line, 0.0, length(&line).min(NEAR));
                let path: Path64 = line.iter().map(|&p| point(p, MADE)).collect();
                inflate_paths_64(
                    &vec![path],
                    half_width[e] * UNITS,
                    JoinType::Miter,
                    EndType::Butt,
                    4.0,
                    0.0,
                )
            })
            .collect();
        for i in 0..strips.len() {
            for j in i + 1..strips.len() {
                zones.extend(intersect_64(&strips[i], &strips[j], FillRule::NonZero));
            }
        }
    }
    let zones = union_subjects_64(&zones, FillRule::NonZero);
    inflate_paths_64(
        &zones,
        CLEAR * UNITS,
        JoinType::Miter,
        EndType::Polygon,
        4.0,
        0.0,
    )
}

/// An edge's centerline in metres around the cell, from → to.
fn centerline(g: &RoadGraph, ways: &RoadWays, metric: &Metric, e: usize) -> Vec<DVec2> {
    ways.st[g.edge_first[e] as usize..=g.edge_last[e] as usize]
        .iter()
        .map(|&st| metric.metres(DVec2::from_array(st)))
        .collect()
}

fn length(line: &[DVec2]) -> f64 {
    line.windows(2).map(|w| (w[1] - w[0]).length()).sum()
}

/// The part of a polyline between two distances along it.
fn slice(line: &[DVec2], from: f64, to: f64) -> Vec<DVec2> {
    let mut out = Vec::new();
    let mut at = 0.0;
    for w in line.windows(2) {
        let len = (w[1] - w[0]).length();
        let (a, b) = (at, at + len);
        let lerp = |d: f64| w[0] + (w[1] - w[0]) * ((d - a) / len);
        if b > from && a < to && len > 0.0 {
            if out.is_empty() {
                out.push(lerp(from.max(a)));
            }
            out.push(lerp(to.min(b)));
        }
        at = b;
    }
    out
}

/// A polyline moved `o` metres to its right (negative: left), mitered at bends.
fn offset(line: &[DVec2], o: f64) -> Vec<DVec2> {
    let n = line.len();
    let right = |i: usize| (line[i + 1] - line[i]).normalize_or_zero().perp() * -1.0;
    (0..n)
        .map(|i| {
            let normal = match (i.checked_sub(1).map(right), (i + 1 < n).then(|| right(i))) {
                (Some(a), Some(b)) => {
                    let m = (a + b).normalize_or_zero();
                    m / m.dot(a).max(0.25)
                }
                (Some(a), None) | (None, Some(a)) => a,
                (None, None) => DVec2::ZERO,
            };
            line[i] + normal * o
        })
        .collect()
}
