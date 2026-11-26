//! Crossings: where two road segments cross with no node in common (a road over or under another, or a crossing
//! the data doesn't join). The ground is a partition in 2D, where such a crossing is pavement meeting pavement, so
//! both ways get a new shared point there and the faces traced around them don't overlap. The points have negative
//! node ids (OSM's are positive): they're for the ground only, not junctions for markings (or for cars, which never
//! see this graph).
//!
//! Only proper crossings are split: each segment's ends strictly on opposite sides of the other (exact orientation
//! tests). Touching (an end on the other segment) and collinear overlaps are counted, not split.

use crate::ways::RoadWays;
use std::collections::HashMap;

/// What splitting ran into.
#[derive(Debug, Default)]
pub struct Crossings {
    pub split: usize,    // proper crossings, each a new node in both ways
    pub touching: usize, // pairs meeting at an end with no shared node, or overlapping along a line: left alone
}

/// How two segments meet.
enum Meet {
    Apart,
    Touch,
    /// Properly, at t along the first and u along the second (both strictly between 0 and 1).
    Cross(f64, f64),
}

/// Whether a node id is a crossing's (made here), not OSM's.
pub fn is_crossing(node_id: i64) -> bool {
    node_id < 0
}

/// Splits every way at each proper crossing with another segment (of another way, or of itself). Needs `ways.st`.
pub fn split(ways: &RoadWays) -> (RoadWays, Crossings) {
    let mut stats = Crossings::default();
    // Segments by their first point: i to i + 1, within a way.
    let segments: Vec<u32> = (0..ways.osm_id.len())
        .flat_map(|w| ways.node_start[w]..ways.node_start[w + 1] - 1)
        .collect();
    let st = |i: u32| ways.st[i as usize];
    let bbox = |i: u32| {
        let (a, b) = (st(i), st(i + 1));
        [
            a[0].min(b[0]),
            a[1].min(b[1]),
            a[0].max(b[0]),
            a[1].max(b[1]),
        ]
    };

    // A uniform grid over every segment's box, about one segment a bucket; each segment in every bucket its box
    // touches. A pair is tested only in the bucket holding the low corner of their boxes' overlap: once.
    let all = segments
        .iter()
        .fold([f64::MAX, f64::MAX, f64::MIN, f64::MIN], |b, &i| {
            let s = bbox(i);
            [
                b[0].min(s[0]),
                b[1].min(s[1]),
                b[2].max(s[2]),
                b[3].max(s[3]),
            ]
        });
    let n = ((segments.len() as f64).sqrt().ceil() as usize).clamp(1, 1024);
    let size = [
        ((all[2] - all[0]) / n as f64).max(f64::MIN_POSITIVE),
        ((all[3] - all[1]) / n as f64).max(f64::MIN_POSITIVE),
    ];
    let bucket = |x: f64, y: f64| {
        (
            (((x - all[0]) / size[0]) as usize).min(n - 1),
            (((y - all[1]) / size[1]) as usize).min(n - 1),
        )
    };
    let mut buckets: Vec<Vec<u32>> = vec![Vec::new(); n * n];
    for &i in &segments {
        let b = bbox(i);
        let (lo, hi) = (bucket(b[0], b[1]), bucket(b[2], b[3]));
        for y in lo.1..=hi.1 {
            for x in lo.0..=hi.0 {
                buckets[y * n + x].push(i);
            }
        }
    }

    // Each crossing: its point, and where it falls along each of its two segments.
    let mut points: Vec<[f64; 2]> = Vec::new();
    let mut lonlats: Vec<[f64; 2]> = Vec::new();
    let mut on: HashMap<u32, Vec<(f64, u32)>> = HashMap::new(); // segment -> (along, crossing)
    for (k, list) in buckets.iter().enumerate() {
        for (x, &i) in list.iter().enumerate() {
            for &j in &list[x + 1..] {
                let (a, b) = (bbox(i), bbox(j));
                let low = [a[0].max(b[0]), a[1].max(b[1])];
                if low[0] > a[2].min(b[2]) || low[1] > a[3].min(b[3]) {
                    continue;
                }
                let (bx, by) = bucket(low[0], low[1]);
                if by * n + bx != k {
                    continue;
                }
                let ids = |s: u32| [ways.node_id[s as usize], ways.node_id[s as usize + 1]];
                if ids(i).iter().any(|id| ids(j).contains(id)) {
                    continue;
                }
                match cross([st(i), st(i + 1)], [st(j), st(j + 1)]) {
                    Meet::Apart => {}
                    Meet::Touch => stats.touching += 1,
                    Meet::Cross(t, u) => {
                        let c = points.len() as u32;
                        let lerp = |p: [f64; 2], q: [f64; 2], t: f64| {
                            [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]
                        };
                        points.push(lerp(st(i), st(i + 1), t));
                        let ll = |s: u32| ways.lonlat[s as usize];
                        lonlats.push(lerp(ll(i), ll(i + 1), t));
                        on.entry(i).or_default().push((t, c));
                        on.entry(j).or_default().push((u, c));
                    }
                }
            }
        }
    }
    stats.split = points.len();

    // The ways again, each crossing's point after its segment's first, in order along it.
    let mut out = RoadWays {
        node_start: vec![0],
        names: ways.names.clone(),
        ..Default::default()
    };
    for w in 0..ways.osm_id.len() {
        for i in ways.node_start[w]..ways.node_start[w + 1] {
            out.node_id.push(ways.node_id[i as usize]);
            out.lonlat.push(ways.lonlat[i as usize]);
            out.st.push(ways.st[i as usize]);
            if let Some(list) = on.get_mut(&i) {
                list.sort_by(|a, b| a.0.total_cmp(&b.0));
                for &(_, c) in list.iter() {
                    out.node_id.push(-(c as i64) - 1);
                    out.lonlat.push(lonlats[c as usize]);
                    out.st.push(points[c as usize]);
                }
            }
        }
        out.node_start.push(out.node_id.len() as u32);
        out.osm_id.push(ways.osm_id[w]);
        out.class.push(ways.class[w]);
        out.name.push(ways.name[w]);
        out.lanes_fwd.push(ways.lanes_fwd[w]);
        out.lanes_back.push(ways.lanes_back[w]);
        out.sidewalks.push(ways.sidewalks[w]);
        out.speed.push(ways.speed[w]);
        out.structure.push(ways.structure[w]);
    }
    (out, stats)
}

fn cross([p, q]: [[f64; 2]; 2], [r, s]: [[f64; 2]; 2]) -> Meet {
    let o = |a: [f64; 2], b: [f64; 2], c: [f64; 2]| {
        robust::orient2d(
            robust::Coord { x: a[0], y: a[1] },
            robust::Coord { x: b[0], y: b[1] },
            robust::Coord { x: c[0], y: c[1] },
        )
    };
    let (o1, o2, o3, o4) = (o(p, q, r), o(p, q, s), o(r, s, p), o(r, s, q));
    let sides = |a: f64, b: f64| (a > 0.0 && b < 0.0) || (a < 0.0 && b > 0.0);
    if sides(o1, o2) && sides(o3, o4) {
        // Twice the triangles' areas give where along each segment they cross.
        let t = o3 / (o3 - o4);
        let u = o1 / (o1 - o2);
        return Meet::Cross(t, u);
    }
    let within = |a: [f64; 2], b: [f64; 2], c: [f64; 2]| {
        c[0] >= a[0].min(b[0])
            && c[0] <= a[0].max(b[0])
            && c[1] >= a[1].min(b[1])
            && c[1] <= a[1].max(b[1])
    };
    let touch = (o1 == 0.0 && within(p, q, r))
        || (o2 == 0.0 && within(p, q, s))
        || (o3 == 0.0 && within(r, s, p))
        || (o4 == 0.0 && within(r, s, q));
    if touch { Meet::Touch } else { Meet::Apart }
}
