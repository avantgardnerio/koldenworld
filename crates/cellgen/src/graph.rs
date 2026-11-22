//! The road graph, as indices into RoadWays (no coordinates of its own).

use crate::ways::RoadWays;
use std::collections::HashMap;

/// Each way cut at every OSM node it shares with another way, so nodes are intersections and dead ends, and an
/// edge is the run of one way's points between two of them.
#[derive(Default)]
pub struct RoadGraph {
    pub node_point: Vec<u32>, // a point (index into the ways' node columns) at the node; any copy will do
    pub edge_start: Vec<u32>, // nodes + 1 offsets into edge_list (CSR)
    pub edge_list: Vec<u32>,  // each node's edges; a self-loop is listed twice
    pub edge_way: Vec<u32>,   // the way an edge is a piece of: its attributes
    pub edge_first: Vec<u32>, // the edge's points are edge_first..=edge_last of the ways' node columns
    pub edge_last: Vec<u32>,
    pub edge_from: Vec<u32>, // node at edge_first
    pub edge_to: Vec<u32>,   // node at edge_last
}

impl RoadGraph {
    pub fn node_count(&self) -> usize {
        self.node_point.len()
    }

    pub fn edge_count(&self) -> usize {
        self.edge_way.len()
    }

    /// The edges meeting at a node.
    pub fn edges_at(&self, n: usize) -> &[u32] {
        &self.edge_list[self.edge_start[n] as usize..self.edge_start[n + 1] as usize]
    }

    pub fn degree(&self, n: usize) -> usize {
        self.edges_at(n).len()
    }

    /// An edge's street name ("" when unnamed).
    pub fn street_name<'a>(&self, ways: &'a RoadWays, e: usize) -> &'a str {
        &ways.names[ways.name[self.edge_way[e] as usize] as usize]
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

    // Each node's edges, CSR: count per node, prefix sum, fill.
    let nodes = g.node_count();
    g.edge_start = vec![0; nodes + 1];
    for e in 0..g.edge_count() {
        g.edge_start[g.edge_from[e] as usize + 1] += 1;
        g.edge_start[g.edge_to[e] as usize + 1] += 1;
    }
    for n in 0..nodes {
        g.edge_start[n + 1] += g.edge_start[n];
    }
    g.edge_list = vec![0; g.edge_start[nodes] as usize];
    let mut fill = g.edge_start[..nodes].to_vec();
    for e in 0..g.edge_count() {
        for n in [g.edge_from[e], g.edge_to[e]] {
            g.edge_list[fill[n as usize] as usize] = e as u32;
            fill[n as usize] += 1;
        }
    }
    g
}
