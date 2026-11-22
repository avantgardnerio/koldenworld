//! The road graph, as indices into RoadWays (no coordinates of its own).

use crate::ways::RoadWays;
use std::cmp::Ordering;
use std::collections::HashMap;

/// Each way cut at every OSM node it shares with another way, so nodes are intersections and dead ends, and an
/// edge is the run of one way's points between two of them.
///
/// A node lists the edge *ends* meeting it (half-edges): end id 2·e is edge e's from end, 2·e + 1 its to end, so
/// a self-loop's two appearances at its node stay apart.
#[derive(Default)]
pub struct RoadGraph {
    pub node_point: Vec<u32>, // a point (index into the ways' node columns) at the node; any copy will do
    pub end_start: Vec<u32>,  // nodes + 1 offsets into end_list (CSR)
    pub end_list: Vec<u32>,   // each node's edge ends; counterclockwise after sort_ends_by_angle
    pub edge_way: Vec<u32>,   // the way an edge is a piece of: its attributes
    pub edge_first: Vec<u32>, // the edge's points are edge_first..=edge_last of the ways' node columns
    pub edge_last: Vec<u32>,
    pub edge_from: Vec<u32>, // node at edge_first
    pub edge_to: Vec<u32>,   // node at edge_last
}

/// What sorting by angle ran into: exact ties are reported, never broken by a tolerance.
#[derive(Debug, Default)]
pub struct AngleStats {
    pub ties: usize, // neighboring ends leaving a node in exactly the same direction
    pub zero_length: usize, // ends whose whole edge sits on its node (no direction at all)
}

impl RoadGraph {
    pub fn node_count(&self) -> usize {
        self.node_point.len()
    }

    pub fn edge_count(&self) -> usize {
        self.edge_way.len()
    }

    /// The edge ends meeting at a node.
    pub fn ends_at(&self, n: usize) -> &[u32] {
        &self.end_list[self.end_start[n] as usize..self.end_start[n + 1] as usize]
    }

    pub fn degree(&self, n: usize) -> usize {
        self.ends_at(n).len()
    }

    /// Each node's connected piece: the index of a node in the same piece (union-find over the edges).
    pub fn components(&self) -> Vec<u32> {
        let mut parent: Vec<u32> = (0..self.node_count() as u32).collect();
        fn root(parent: &mut [u32], mut i: u32) -> u32 {
            while parent[i as usize] != i {
                parent[i as usize] = parent[parent[i as usize] as usize];
                i = parent[i as usize];
            }
            i
        }
        for e in 0..self.edge_count() {
            let (a, b) = (
                root(&mut parent, self.edge_from[e]),
                root(&mut parent, self.edge_to[e]),
            );
            parent[a as usize] = b;
        }
        (0..self.node_count() as u32)
            .map(|i| root(&mut parent, i))
            .collect()
    }

    /// How many connected pieces.
    pub fn component_count(&self) -> usize {
        let c = self.components();
        (0..c.len()).filter(|&i| c[i] == i as u32).count()
    }

    /// An edge's street name ("" when unnamed).
    pub fn street_name<'a>(&self, ways: &'a RoadWays, e: usize) -> &'a str {
        &ways.names[ways.name[self.edge_way[e] as usize] as usize]
    }

    /// The point an end leaves its node toward: the nearest point along its edge at a different position (two OSM
    /// nodes can share coordinates), or None if the whole edge sits on the node.
    pub fn end_toward(&self, ways: &RoadWays, end: u32) -> Option<usize> {
        let e = (end / 2) as usize;
        let (first, last) = (self.edge_first[e] as usize, self.edge_last[e] as usize);
        let at = |k: usize| ways.st[k] != ways.st[if end.is_multiple_of(2) { first } else { last }];
        if end.is_multiple_of(2) {
            (first + 1..=last).find(|&k| at(k))
        } else {
            (first..last).rev().find(|&k| at(k))
        }
    }
}

/// Cuts every way at each OSM node it shares with another way (or with itself, where it crosses or loops back),
/// as well as at its ends. Node and edge ids follow the ways' order.
pub fn build_graph(ways: &RoadWays) -> RoadGraph {
    let mut uses: HashMap<i64, u32> = HashMap::new();
    for &id in &ways.node_id {
        *uses.entry(id).or_default() += 1;
    }

    let mut g = RoadGraph::default();
    let mut node_of: HashMap<i64, u32> = HashMap::new();
    let mut node = |g: &mut RoadGraph, point: usize| {
        *node_of.entry(ways.node_id[point]).or_insert_with(|| {
            g.node_point.push(point as u32);
            (g.node_point.len() - 1) as u32
        })
    };
    for w in 0..ways.osm_id.len() {
        let (a, b) = (ways.node_start[w] as usize, ways.node_start[w + 1] as usize);
        let mut start = a;
        for i in a + 1..b {
            if i < b - 1 && uses[&ways.node_id[i]] < 2 {
                continue;
            }
            let (from, to) = (node(&mut g, start), node(&mut g, i));
            g.edge_way.push(w as u32);
            g.edge_first.push(start as u32);
            g.edge_last.push(i as u32);
            g.edge_from.push(from);
            g.edge_to.push(to);
            start = i;
        }
    }

    // Each node's edge ends, CSR: count per node, prefix sum, fill.
    let nodes = g.node_count();
    g.end_start = vec![0; nodes + 1];
    for e in 0..g.edge_count() {
        g.end_start[g.edge_from[e] as usize + 1] += 1;
        g.end_start[g.edge_to[e] as usize + 1] += 1;
    }
    for n in 0..nodes {
        g.end_start[n + 1] += g.end_start[n];
    }
    g.end_list = vec![0; g.end_start[nodes] as usize];
    let mut fill = g.end_start[..nodes].to_vec();
    for e in 0..g.edge_count() {
        for (end, n) in [(2 * e, g.edge_from[e]), (2 * e + 1, g.edge_to[e])] {
            g.end_list[fill[n as usize] as usize] = end as u32;
            fill[n as usize] += 1;
        }
    }
    g
}

/// Orders each node's edge ends counterclockwise in (s, t), starting from the +s direction. Exact: directions are
/// split by half-plane (plain comparisons), then ordered by the sign of an exact orientation test (Shewchuk's
/// adaptive predicate). No angles are computed. (s, t) isn't metric, but a linear map that doesn't mirror keeps the
/// cyclic order of directions, so this is the order on the ground too.
pub fn sort_ends_by_angle(g: &mut RoadGraph, ways: &RoadWays) -> AngleStats {
    let mut stats = AngleStats::default();
    for n in 0..g.node_count() {
        let o = ways.st[g.node_point[n] as usize];
        let (a, b) = (g.end_start[n] as usize, g.end_start[n + 1] as usize);
        let toward: Vec<Option<[f64; 2]>> = g.end_list[a..b]
            .iter()
            .map(|&end| g.end_toward(ways, end).map(|k| ways.st[k]))
            .collect();
        stats.zero_length += toward.iter().filter(|p| p.is_none()).count();

        // Sort positions within the node's slice, then apply them.
        let mut order: Vec<usize> = (0..b - a).collect();
        order.sort_by(|&i, &j| ccw(o, toward[i], toward[j]));
        stats.ties += order
            .windows(2)
            .filter(|w| ccw(o, toward[w[0]], toward[w[1]]) == Ordering::Equal)
            .count();
        let sorted: Vec<u32> = order.iter().map(|&i| g.end_list[a + i]).collect();
        g.end_list[a..b].copy_from_slice(&sorted);
    }
    stats
}

/// Counterclockwise order of two directions leaving `o` toward p and q, from the +s direction. A missing direction
/// (a zero-length edge) sorts first.
fn ccw(o: [f64; 2], p: Option<[f64; 2]>, q: Option<[f64; 2]>) -> Ordering {
    let (p, q) = match (p, q) {
        (None, None) => return Ordering::Equal,
        (None, _) => return Ordering::Less,
        (_, None) => return Ordering::Greater,
        (Some(p), Some(q)) => (p, q),
    };
    // Half-plane: angles in [0°, 180°) first, then [180°, 360°).
    let half = |p: [f64; 2]| !(p[1] > o[1] || (p[1] == o[1] && p[0] > o[0]));
    half(p).cmp(&half(q)).then_with(|| {
        let turn = robust::orient2d(
            robust::Coord { x: o[0], y: o[1] },
            robust::Coord { x: p[0], y: p[1] },
            robust::Coord { x: q[0], y: q[1] },
        );
        // q counterclockwise from p: p comes first. (A sign test, not total_cmp: a tie may come back as -0.0.)
        if turn > 0.0 {
            Ordering::Less
        } else if turn < 0.0 {
            Ordering::Greater
        } else {
            Ordering::Equal
        }
    })
}
