//! A fine cell's road graph, nodes.arrow and edges.arrow, as the TS wrote them (buildRoadGraph in
//! packages/world/src/road-graph.ts, roadGraphToArrow in road-graph-arrow.ts): every way cut at each node it shares
//! with another (or itself), each piece an edge running from → to along its points, kept when the cell owns its
//! midpoint; nodes only for kept edges. Ids follow the ways' order.
//!
//! Draped on the drawn ground (decided 2026-11-26, docs/serverless-plan.md), not as the TS did: every node and point
//! at the ground's height under it (cell::Ground), with a point added wherever an edge crosses a lattice row, column
//! or diagonal, so the centreline lies on the drawn surface between points. Bridges and tunnels too (the ground draws
//! them on the terrain); no fill skirts (drop 0).
//!
//!   nodes.arrow                          edges.arrow
//!   x         float32                    from        uint32
//!   y         float32                    to          uint32
//!   z         float32                    class       dictionary<uint8, utf8>    ROAD_CLASSES
//!   drop      float32                    lanes_fwd   uint8
//!   osm_id    float64                    lanes_back  uint8
//!   edges     list<uint32>               speed_limit float32   m/s
//!                                        length      float32   m, along the points before draping
//!                                        name        dictionary<uint32, utf8>; "" = unnamed
//!                                        structure   dictionary<uint8, utf8>    ROAD_STRUCTURES
//!                                        sidewalks   uint8     bits: 1 left, 2 right (from → to)
//!                                        osm_way_id  float64
//!                                        points      list<fixed_size_list<float32, 2>>  x, y in m
//!                                        point_z     list<float32>  z per point, m (same offsets as points)
//!                                        point_drop  list<float32>  0
//!
//! The schema metadata (values JSON-encoded) holds the cell's token and ROAD_GRAPH_VERSION.

use crate::geodesy::{self, Frame};
use crate::s2;
use crate::ways::{ROAD_CLASSES, RoadWays};
use arrow_array::types::{UInt8Type, UInt32Type};
use arrow_array::{
    ArrayRef, DictionaryArray, FixedSizeListArray, Float32Array, Float64Array, ListArray,
    RecordBatch, StringArray, UInt8Array, UInt32Array,
};
use arrow_buffer::{OffsetBuffer, ScalarBuffer};
use arrow_ipc::writer::FileWriter;
use arrow_schema::{DataType, Field, Schema};
use std::collections::HashMap;
use std::sync::Arc;

/// The TS ROAD_GRAPH_VERSION, bumped for draping on the drawn ground.
pub const ROAD_GRAPH_VERSION: u32 = 5;
/// Edge structure, as the TS ROAD_STRUCTURES.
const ROAD_STRUCTURES: [&str; 3] = ["ground", "bridge", "tunnel"];
/// Lattice squares across a fine cell's ground (cell::TERRAIN_N): the grid the crossings are found on.
const LATTICE: f64 = crate::cell::TERRAIN_N as f64;

/// The graph as columns: node n's incident edges edge_list[edge_start[n]..edge_start[n + 1]] (a self-loop twice),
/// edge e's points point_start[e]..point_start[e + 1] (both end nodes included).
#[derive(Default)]
pub struct Graph {
    pub node_x: Vec<f32>,
    pub node_y: Vec<f32>,
    pub node_z: Vec<f32>,
    pub node_osm: Vec<f64>,
    pub edge_start: Vec<i32>,
    pub edge_list: Vec<u32>,
    pub from: Vec<u32>,
    pub to: Vec<u32>,
    pub class: Vec<u8>,
    pub lanes_fwd: Vec<u8>,
    pub lanes_back: Vec<u8>,
    pub speed: Vec<f32>,
    pub length: Vec<f32>,
    pub name: Vec<u32>,
    pub structure: Vec<u8>,
    pub sidewalks: Vec<u8>,
    pub osm_way: Vec<f64>,
    pub point_start: Vec<i32>,
    pub points: Vec<[f32; 2]>,
    pub point_z: Vec<f32>,
    pub names: Vec<String>,
}

/// The graph of `ways` (RoadWays::with_touching, so every cell cuts a way at the same nodes), keeping the edges
/// whose midpoint `owns` (lon, lat), projected to `frame`, not yet draped (z 0).
pub fn build(ways: &RoadWays, owns: impl Fn(f64, f64) -> bool, frame: &Frame) -> Graph {
    let mut uses: HashMap<i64, u32> = HashMap::new();
    for &id in &ways.node_id {
        *uses.entry(id).or_default() += 1;
    }
    let mut g = Graph {
        point_start: vec![0],
        names: ways.names.clone(),
        ..Default::default()
    };
    let mut node_index: HashMap<i64, u32> = HashMap::new();
    let mut node = |g: &mut Graph, id: i64, [lon, lat]: [f64; 2]| {
        *node_index.entry(id).or_insert_with(|| {
            let [x, y] = frame.project(lon, lat);
            g.node_x.push(x as f32);
            g.node_y.push(y as f32);
            g.node_osm.push(id as f64);
            (g.node_osm.len() - 1) as u32
        })
    };
    for w in 0..ways.osm_id.len() {
        let nodes = ways.node_start[w] as usize..ways.node_start[w + 1] as usize;
        let (ids, lonlat) = (&ways.node_id[nodes.clone()], &ways.lonlat[nodes]);
        let mut start = 0;
        for i in 1..ids.len() {
            if i < ids.len() - 1 && uses[&ids[i]] < 2 {
                continue;
            }
            // The point halfway by vertex count: a middle vertex, or the middle segment's midpoint.
            let (a, b) = (lonlat[(start + i) / 2], lonlat[(start + i).div_ceil(2)]);
            if !owns((a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0) {
                start = i;
                continue;
            }
            let from = node(&mut g, ids[start], lonlat[start]);
            let to = node(&mut g, ids[i], lonlat[i]);
            g.from.push(from);
            g.to.push(to);
            let mut length = 0.0;
            let mut prev = [0.0; 2];
            for (k, &[lon, lat]) in lonlat.iter().enumerate().take(i + 1).skip(start) {
                let q = frame.project(lon, lat);
                if k > start {
                    length += (q[0] - prev[0]).hypot(q[1] - prev[1]);
                }
                g.points.push([q[0] as f32, q[1] as f32]);
                prev = q;
            }
            g.class.push(ways.class[w]);
            g.lanes_fwd.push(ways.lanes_fwd[w]);
            g.lanes_back.push(ways.lanes_back[w]);
            g.speed.push(ways.speed[w]);
            g.length.push(length as f32);
            g.name.push(ways.name[w]);
            g.structure.push(ways.structure[w]);
            g.sidewalks.push(ways.sidewalks[w]);
            g.osm_way.push(ways.osm_id[w] as f64);
            g.point_start.push(g.points.len() as i32);
            start = i;
        }
    }
    // Incidence lists (CSR): a count per node, a prefix sum, then filled in edge order.
    let nodes = g.node_osm.len();
    g.edge_start = vec![0; nodes + 1];
    for e in 0..g.from.len() {
        g.edge_start[g.from[e] as usize + 1] += 1;
        g.edge_start[g.to[e] as usize + 1] += 1;
    }
    for n in 0..nodes {
        g.edge_start[n + 1] += g.edge_start[n];
    }
    g.edge_list = vec![0; g.edge_start[nodes] as usize];
    let mut fill: Vec<i32> = g.edge_start[..nodes].to_vec();
    for e in 0..g.from.len() {
        for n in [g.from[e], g.to[e]] {
            g.edge_list[fill[n as usize] as usize] = e as u32;
            fill[n as usize] += 1;
        }
    }
    g.node_z = vec![0.0; nodes];
    g.point_z = vec![0.0; g.points.len()];
    g
}

/// The graph on the drawn ground: each edge's points, plus a point wherever it crosses a lattice row, column or
/// diagonal (on the grid of fine cells' lattices, level CELL_LEVEL), each at `ground` (lat, lon → m above the
/// ellipsoid; cell::Ground) and placed at its true height in `frame`; nodes likewise.
pub fn drape(mut g: Graph, frame: &Frame, mut ground: impl FnMut(f64, f64) -> f64) -> Graph {
    let mut place = |[x, y]: [f64; 2]| {
        let [lon, lat] = frame.lon_lat(x, y);
        frame.local(geodesy::ecef(lat, lon, ground(lat, lon)))
    };
    // A point's lattice coordinates (lattice spacing 1) on its face.
    let grid = |[x, y]: [f64; 2]| {
        let [lon, lat] = frame.lon_lat(x, y);
        let (face, st) = s2::lat_lon_to_face_st(lat, lon);
        let scale = (1u64 << s2::CELL_LEVEL) as f64 * LATTICE;
        (face, [st[0] * scale, st[1] * scale])
    };
    let (mut points, mut point_z, mut point_start) = (Vec::new(), Vec::new(), vec![0]);
    for e in 0..g.from.len() {
        let pts = &g.points[g.point_start[e] as usize..g.point_start[e + 1] as usize];
        let mut push = |p: [f64; 2]| {
            let q = place(p);
            points.push([q.x as f32, q.y as f32]);
            point_z.push(q.z as f32);
        };
        for k in 0..pts.len() {
            let a = pts[k].map(f64::from);
            push(a);
            let Some(b) = pts.get(k + 1).map(|b| b.map(f64::from)) else {
                break;
            };
            let ((fa, ga), (fb, gb)) = (grid(a), grid(b));
            if fa != fb {
                continue; // across a face edge: no shared grid
            }
            let mut cuts: Vec<f64> = Vec::new();
            for (u, v) in [
                (ga[0], gb[0]),
                (ga[1], gb[1]),
                (ga[0] - ga[1], gb[0] - gb[1]),
            ] {
                let (lo, hi) = (u.min(v), u.max(v));
                let mut line = lo.floor() + 1.0;
                while line < hi {
                    cuts.push((line - u) / (v - u));
                    line += 1.0;
                }
            }
            cuts.sort_by(f64::total_cmp);
            cuts.dedup();
            for t in cuts.into_iter().filter(|&t| t > 0.0 && t < 1.0) {
                push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
            }
        }
        point_start.push(points.len() as i32);
    }
    for n in 0..g.node_osm.len() {
        let q = place([g.node_x[n] as f64, g.node_y[n] as f64]);
        (g.node_x[n], g.node_y[n], g.node_z[n]) = (q.x as f32, q.y as f32, q.z as f32);
    }
    (g.points, g.point_z, g.point_start) = (points, point_z, point_start);
    g
}

/// nodes.arrow and edges.arrow, as bytes.
pub fn encode(g: &Graph, token: &str) -> Result<(Vec<u8>, Vec<u8>), Box<dyn std::error::Error>> {
    let metadata = HashMap::from([
        ("cell".to_string(), format!("\"{token}\"")),
        (
            "roadGraphVersion".to_string(),
            ROAD_GRAPH_VERSION.to_string(),
        ),
    ]);
    let offsets = |o: &[i32]| OffsetBuffer::new(ScalarBuffer::from(o.to_vec()));
    let list = |name: &str, values: ArrayRef, o: &[i32]| -> ArrayRef {
        let item = Arc::new(Field::new(name, values.data_type().clone(), false));
        Arc::new(ListArray::new(item, offsets(o), values, None))
    };
    let f32s = |v: &[f32]| -> ArrayRef { Arc::new(Float32Array::from(v.to_vec())) };
    let nodes = vec![
        ("x", f32s(&g.node_x)),
        ("y", f32s(&g.node_y)),
        ("z", f32s(&g.node_z)),
        ("drop", f32s(&vec![0.0; g.node_osm.len()])),
        (
            "osm_id",
            Arc::new(Float64Array::from(g.node_osm.clone())) as ArrayRef,
        ),
        (
            "edges",
            list(
                "edge",
                Arc::new(UInt32Array::from(g.edge_list.clone())),
                &g.edge_start,
            ),
        ),
    ];
    let xy = Arc::new(Field::new("xy", DataType::Float32, false));
    let points: ArrayRef = Arc::new(FixedSizeListArray::new(
        xy,
        2,
        Arc::new(Float32Array::from_iter_values(
            g.points.iter().flatten().copied(),
        )),
        None,
    ));
    let names: Vec<&str> = g.names.iter().map(String::as_str).collect();
    let edges = vec![
        (
            "from",
            Arc::new(UInt32Array::from(g.from.clone())) as ArrayRef,
        ),
        ("to", Arc::new(UInt32Array::from(g.to.clone()))),
        (
            "class",
            Arc::new(DictionaryArray::<UInt8Type>::try_new(
                UInt8Array::from(g.class.clone()),
                Arc::new(StringArray::from(ROAD_CLASSES.to_vec())),
            )?),
        ),
        ("lanes_fwd", Arc::new(UInt8Array::from(g.lanes_fwd.clone()))),
        (
            "lanes_back",
            Arc::new(UInt8Array::from(g.lanes_back.clone())),
        ),
        ("speed_limit", f32s(&g.speed)),
        ("length", f32s(&g.length)),
        (
            "name",
            Arc::new(DictionaryArray::<UInt32Type>::try_new(
                UInt32Array::from(g.name.clone()),
                Arc::new(StringArray::from(names)),
            )?),
        ),
        (
            "structure",
            Arc::new(DictionaryArray::<UInt8Type>::try_new(
                UInt8Array::from(g.structure.clone()),
                Arc::new(StringArray::from(ROAD_STRUCTURES.to_vec())),
            )?),
        ),
        ("sidewalks", Arc::new(UInt8Array::from(g.sidewalks.clone()))),
        (
            "osm_way_id",
            Arc::new(Float64Array::from(g.osm_way.clone())),
        ),
        ("points", list("point", points, &g.point_start)),
        ("point_z", list("z", f32s(&g.point_z), &g.point_start)),
        (
            "point_drop",
            list("drop", f32s(&vec![0.0; g.point_z.len()]), &g.point_start),
        ),
    ];
    Ok((ipc(nodes, &metadata)?, ipc(edges, &metadata)?))
}

/// One record batch of these columns as an Arrow IPC file.
fn ipc(
    columns: Vec<(&str, ArrayRef)>,
    metadata: &HashMap<String, String>,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let schema = Arc::new(Schema::new_with_metadata(
        columns
            .iter()
            .map(|(name, a)| Field::new(*name, a.data_type().clone(), false))
            .collect::<Vec<_>>(),
        metadata.clone(),
    ));
    let batch = RecordBatch::try_new(
        schema.clone(),
        columns.into_iter().map(|(_, a)| a).collect(),
    )?;
    let mut out = Vec::new();
    let mut writer = FileWriter::try_new(&mut out, &schema)?;
    writer.write(&batch)?;
    writer.finish()?;
    drop(writer);
    Ok(out)
}
