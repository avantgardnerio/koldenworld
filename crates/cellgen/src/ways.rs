//! Road ways, the input: OSM ways tagged highway=*, from the cell files into columns.

use crate::extract::Extracted;
use crate::osm::Osm;

/// OSM highway=* values we store, as in packages/world/src/road-graph.ts; a way's class is an index into this.
pub const ROAD_CLASSES: [&str; 15] = [
    "motorway",
    "motorway_link",
    "trunk",
    "trunk_link",
    "primary",
    "primary_link",
    "secondary",
    "secondary_link",
    "tertiary",
    "tertiary_link",
    "unclassified",
    "residential",
    "living_street",
    "service",
    "road",
];

/// Road ways as columns (no object per way or point): per-way columns, and per-node columns
/// with each way's nodes at node_start[w]..node_start[w + 1] (CSR).
#[derive(Default, Clone)]
pub struct RoadWays {
    pub osm_id: Vec<i64>,
    pub class: Vec<u8>,        // index into ROAD_CLASSES
    pub name: Vec<u32>,        // index into names; 0 = unnamed
    pub node_start: Vec<u32>,  // ways + 1 offsets into the node columns
    pub node_id: Vec<i64>,     // OSM node ids, in way order
    pub lonlat: Vec<[f64; 2]>, // degrees, one per node id
    pub st: Vec<[f64; 2]>,     // (s, t) on the cell's face, one per node id (filled after loading)
    pub lanes_fwd: Vec<u8>,    // lanes in the way's direction
    pub lanes_back: Vec<u8>,   // lanes against it; 0 = one-way
    pub sidewalks: Vec<u8>,    // bits: SIDEWALK_LEFT, SIDEWALK_RIGHT of the way's direction
    pub speed: Vec<f32>,       // speed limit, m/s
    pub structure: Vec<u8>,    // 0 on the ground, 1 bridge, 2 tunnel (as the TS ROAD_STRUCTURES)
    pub names: Vec<String>,    // names[0] = ""
}

/// Sidewalk bits (decision 33): which sides of a way have one, looking along its stored node order.
pub const SIDEWALK_LEFT: u8 = 1;
pub const SIDEWALK_RIGHT: u8 = 2;

impl RoadWays {
    /// The road ways of OSM loaded for a box (local::load_box) and extracted: those intersecting the box, ordered by
    /// OSM id, named by name=* or else ref=*, nodes in the direction of travel.
    pub fn from_extracted(osm: &Osm, x: &Extracted, bbox: [f64; 4]) -> RoadWays {
        let r = &x.roads;
        RoadWays::of(
            osm,
            x,
            (0..r.way.len()).filter(|&i| meets(x, i, bbox)).collect(),
        )
    }

    /// As the TS loadRoadWays returns them, for a road graph that's cut the same way whichever cell builds it: the
    /// road ways intersecting the box plus every way sharing a node with one of them, wherever it is (OSM loaded
    /// over `reach(x, bbox)` has them all), ordered by OSM id.
    pub fn with_touching(osm: &Osm, x: &Extracted, bbox: [f64; 4]) -> RoadWays {
        let r = &x.roads;
        let nodes = |i: usize| &r.node_id[r.node_start[i] as usize..r.node_start[i + 1] as usize];
        let hit: std::collections::HashSet<i64> = (0..r.way.len())
            .filter(|&i| meets(x, i, bbox))
            .flat_map(|i| nodes(i).iter().copied())
            .collect();
        let order = (0..r.way.len())
            .filter(|&i| nodes(i).iter().any(|n| hit.contains(n)))
            .collect();
        RoadWays::of(osm, x, order)
    }

    /// The extracted roads at these indices, ordered by OSM id.
    fn of(osm: &Osm, x: &Extracted, mut order: Vec<usize>) -> RoadWays {
        let r = &x.roads;
        let text = |w: usize, key: &str| {
            let k = osm.strings.find(key)?;
            osm.way_tags
                .get(w, k)
                .map(|v| osm.strings.text[v as usize].as_str())
        };
        order.sort_by_key(|&i| osm.way_id[r.way[i] as usize]);
        let mut ways = RoadWays::empty();
        let mut name_index = std::collections::HashMap::new();
        for i in order {
            let w = r.way[i] as usize;
            let nodes = r.node_start[i] as usize..r.node_start[i + 1] as usize;
            ways.osm_id.push(osm.way_id[w]);
            ways.class.push(r.class[i]);
            ways.name.push(match text(w, "name").or(text(w, "ref")) {
                None | Some("") => 0,
                Some(n) => *name_index.entry(n.to_string()).or_insert_with(|| {
                    ways.names.push(n.to_string());
                    (ways.names.len() - 1) as u32
                }),
            });
            ways.node_id.extend_from_slice(&r.node_id[nodes.clone()]);
            ways.lonlat.extend_from_slice(&r.lonlat[nodes]);
            ways.node_start.push(ways.node_id.len() as u32);
            ways.lanes_fwd.push(r.lanes_fwd[i]);
            ways.lanes_back.push(r.lanes_back[i]);
            ways.sidewalks.push(r.sidewalks[i]);
            ways.speed.push(r.speed[i]);
            ways.structure.push(r.structure[i]);
        }
        ways
    }

    /// No ways at all.
    pub fn empty() -> RoadWays {
        RoadWays {
            node_start: vec![0],
            names: vec![String::new()],
            ..Default::default()
        }
    }

    /// The ways with only the points marked in `keep` (one per point; keep each way's ends).
    pub fn keep_points(&self, keep: &[bool]) -> RoadWays {
        let mut out = self.keep(|_| true);
        let has_st = !self.st.is_empty();
        out.node_id.clear();
        out.lonlat.clear();
        out.st.clear();
        out.node_start = vec![0];
        for w in 0..self.osm_id.len() {
            for i in
                (self.node_start[w] as usize..self.node_start[w + 1] as usize).filter(|&i| keep[i])
            {
                out.node_id.push(self.node_id[i]);
                out.lonlat.push(self.lonlat[i]);
                if has_st {
                    out.st.push(self.st[i]);
                }
            }
            out.node_start.push(out.node_id.len() as u32);
        }
        out
    }

    /// The ways for which `keep(way)` holds, in order (names kept whole).
    pub fn keep(&self, keep: impl Fn(usize) -> bool) -> RoadWays {
        let mut out = RoadWays {
            node_start: vec![0],
            names: self.names.clone(),
            ..Default::default()
        };
        for w in (0..self.osm_id.len()).filter(|&w| keep(w)) {
            let nodes = self.node_start[w] as usize..self.node_start[w + 1] as usize;
            out.osm_id.push(self.osm_id[w]);
            out.class.push(self.class[w]);
            out.name.push(self.name[w]);
            out.node_id.extend_from_slice(&self.node_id[nodes.clone()]);
            out.lonlat.extend_from_slice(&self.lonlat[nodes.clone()]);
            if !self.st.is_empty() {
                out.st.extend_from_slice(&self.st[nodes]);
            }
            out.node_start.push(out.node_id.len() as u32);
            out.lanes_fwd.push(self.lanes_fwd[w]);
            out.lanes_back.push(self.lanes_back[w]);
            out.sidewalks.push(self.sidewalks[w]);
            out.speed.push(self.speed[w]);
            out.structure.push(self.structure[w]);
        }
        out
    }
}

/// How far the roads intersecting the box reach (the box grown to cover them): every road sharing a node with them
/// overlaps it, so an OSM load over it (local::load_box) has them all.
pub fn reach(x: &Extracted, bbox: [f64; 4]) -> [f64; 4] {
    let r = &x.roads;
    let mut out = bbox;
    for i in (0..r.way.len()).filter(|&i| meets(x, i, bbox)) {
        for &[lon, lat] in &r.lonlat[r.node_start[i] as usize..r.node_start[i + 1] as usize] {
            out = [
                out[0].min(lon),
                out[1].min(lat),
                out[2].max(lon),
                out[3].max(lat),
            ];
        }
    }
    out
}

/// Whether extracted road i intersects the box (ST_Intersects).
fn meets(x: &Extracted, i: usize, bbox: [f64; 4]) -> bool {
    let r = &x.roads;
    crate::boxes::line_meets_box(
        &r.lonlat[r.node_start[i] as usize..r.node_start[i + 1] as usize],
        bbox,
    )
}

/// Road ways from JSON: an array of the TS RoadWayInput (osmWayId, nodeIds, points as [lon, lat], class, name,
/// lanesFwd, lanesBack, speedLimitMps, and optionally sidewalks: bits, default none). For fixtures and tests.
pub fn from_json(text: &str) -> Result<RoadWays, Box<dyn std::error::Error>> {
    let input: serde_json::Value = serde_json::from_str(text)?;
    let mut ways = RoadWays {
        node_start: vec![0],
        names: vec![String::new()],
        ..Default::default()
    };
    let mut name_index = std::collections::HashMap::new();
    for w in input.as_array().ok_or("expected an array of ways")? {
        let field = |k: &str| w.get(k).ok_or_else(|| format!("a way without {k}"));
        let id = field("osmWayId")?
            .as_i64()
            .ok_or("osmWayId isn't an integer")?;
        let class = field("class")?.as_str().ok_or("class isn't a string")?;
        let node_ids: Vec<i64> = field("nodeIds")?
            .as_array()
            .ok_or("nodeIds isn't an array")?
            .iter()
            .filter_map(|v| v.as_i64())
            .collect();
        let points = field("points")?.as_array().ok_or("points isn't an array")?;
        if points.len() != node_ids.len() {
            return Err(format!(
                "way {id}: {} node ids but {} points",
                node_ids.len(),
                points.len()
            )
            .into());
        }
        for p in points {
            let p = p.as_array().ok_or("a point isn't [lon, lat]")?;
            ways.lonlat
                .push([p[0].as_f64().unwrap_or(0.0), p[1].as_f64().unwrap_or(0.0)]);
        }
        ways.osm_id.push(id);
        ways.class.push(
            ROAD_CLASSES
                .iter()
                .position(|c| *c == class)
                .ok_or(format!("way {id}: unknown class {class}"))? as u8,
        );
        ways.name
            .push(match w.get("name").and_then(|n| n.as_str()) {
                None | Some("") => 0,
                Some(n) => *name_index.entry(n.to_string()).or_insert_with(|| {
                    ways.names.push(n.to_string());
                    (ways.names.len() - 1) as u32
                }),
            });
        ways.node_id.extend_from_slice(&node_ids);
        ways.node_start.push(ways.node_id.len() as u32);
        ways.lanes_fwd
            .push(field("lanesFwd")?.as_u64().unwrap_or(1) as u8);
        ways.lanes_back
            .push(field("lanesBack")?.as_u64().unwrap_or(0) as u8);
        ways.sidewalks
            .push(w.get("sidewalks").and_then(|s| s.as_u64()).unwrap_or(0) as u8);
        ways.speed.push(
            w.get("speedLimitMps")
                .and_then(|s| s.as_f64())
                .unwrap_or(0.0) as f32,
        );
        ways.structure
            .push(match w.get("structure").and_then(|s| s.as_str()) {
                Some("bridge") => 1,
                Some("tunnel") => 2,
                _ => 0,
            });
    }
    Ok(ways)
}
