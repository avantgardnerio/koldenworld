//! Road ways, the input: OSM ways tagged highway=*, loaded from Postgres (road_ways) into columns.

use postgres::Client;

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
    pub names: Vec<String>,    // names[0] = ""
}

/// Sidewalk bits (decision 33): which sides of a way have one, looking along its stored node order.
pub const SIDEWALK_LEFT: u8 = 1;
pub const SIDEWALK_RIGHT: u8 = 2;

/// Town streets: where untagged roads get sidewalks on both sides (at most 40 mph).
const SIDEWALK_CLASSES: [&str; 6] = [
    "primary",
    "secondary",
    "tertiary",
    "unclassified",
    "residential",
    "living_street",
];
const SIDEWALK_MAX_SPEED: f32 = 40.0 * 0.44704;

/// Every road way intersecting a lon/lat box, ordered by OSM id.
pub fn load_road_ways(
    db: &mut Client,
    west: f64,
    south: f64,
    east: f64,
    north: f64,
) -> Result<RoadWays, Box<dyn std::error::Error>> {
    let rows = db.query(
        "SELECT osm_way_id, class, name, node_ids, ST_AsBinary(geom), lanes_fwd, lanes_back, speed_limit_mps,
                tags ->> 'sidewalk', tags ->> 'sidewalk:both', tags ->> 'sidewalk:left', tags ->> 'sidewalk:right',
                tags ->> 'oneway', tags ->> 'tunnel'
         FROM road_ways
         WHERE ST_Intersects(geom, ST_MakeEnvelope($1, $2, $3, $4, 4326))
         ORDER BY osm_way_id",
        &[&west, &south, &east, &north],
    )?;
    let mut ways = RoadWays {
        node_start: vec![0],
        names: vec![String::new()],
        ..Default::default()
    };
    let mut name_index = std::collections::HashMap::new();
    for row in &rows {
        let id: i64 = row.get(0);
        let class: &str = row.get(1);
        let name: Option<&str> = row.get(2);
        let node_ids: Vec<i64> = row.get(3);
        let points =
            wkb_line_string(row.get(4), &mut ways.lonlat).map_err(|e| format!("way {id}: {e}"))?;
        if points != node_ids.len() {
            return Err(
                format!("way {id}: {} node ids but {points} points", node_ids.len()).into(),
            );
        }
        ways.osm_id.push(id);
        ways.class.push(
            ROAD_CLASSES
                .iter()
                .position(|c| *c == class)
                .ok_or(format!("way {id}: unknown class {class}"))? as u8,
        );
        ways.name.push(match name {
            None | Some("") => 0,
            Some(n) => *name_index.entry(n.to_string()).or_insert_with(|| {
                ways.names.push(n.to_string());
                (ways.names.len() - 1) as u32
            }),
        });
        ways.node_id.extend_from_slice(&node_ids);
        ways.node_start.push(ways.node_id.len() as u32);
        let (lanes_fwd, lanes_back, speed): (i16, i16, f32) = (row.get(5), row.get(6), row.get(7));
        ways.lanes_fwd.push(lanes_fwd as u8);
        ways.lanes_back.push(lanes_back as u8);
        let tag = |i: usize| -> Option<&str> { row.get(i) };
        ways.sidewalks.push(sidewalks(
            class,
            speed,
            [tag(8), tag(9), tag(10), tag(11)],
            tag(12),
            tag(13),
        ));
    }
    Ok(ways)
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
    }
    Ok(ways)
}

/// Which sides of a way have a sidewalk (as osm-import's roadSidewalks): from sidewalk=*, sidewalk:both, :left and
/// :right (a separately mapped sidewalk counts), or, untagged, a town street (by class, speed, and not in a tunnel).
/// Left and right are of the stored node order, which runs against the way for oneway=-1.
fn sidewalks(
    class: &str,
    speed: f32,
    [sidewalk, both, left, right]: [Option<&str>; 4],
    oneway: Option<&str>,
    tunnel: Option<&str>,
) -> u8 {
    let yes = |v: Option<&str>| v.map(|v| v != "no" && v != "none");
    let (mut l, mut r) = match both.or(sidewalk) {
        Some("left") => (Some(true), Some(false)),
        Some("right") => (Some(false), Some(true)),
        b => (yes(b), yes(b)),
    };
    l = yes(left).or(l);
    r = yes(right).or(r);
    if l.is_none() && r.is_none() {
        let town = SIDEWALK_CLASSES.contains(&class)
            && speed <= SIDEWALK_MAX_SPEED + 0.01
            && matches!(tunnel, None | Some("no") | Some("building_passage"));
        (l, r) = (Some(town), Some(town));
    }
    if matches!(oneway, Some("-1") | Some("reverse")) {
        (l, r) = (r, l);
    }
    (if l == Some(true) { SIDEWALK_LEFT } else { 0 })
        | (if r == Some(true) { SIDEWALK_RIGHT } else { 0 })
}

/// A WKB LineString's points (as PostGIS's ST_AsBinary writes it: byte order, type 2, count, then x, y doubles).
pub fn wkb_line_string(wkb: &[u8], out: &mut Vec<[f64; 2]>) -> Result<usize, String> {
    if wkb.len() < 9 || wkb[0] != 1 {
        return Err("expected little-endian WKB".into());
    }
    let word = |at: usize| u32::from_le_bytes(wkb[at..at + 4].try_into().unwrap());
    if word(1) != 2 {
        return Err(format!(
            "expected a LineString (type 2), got type {}",
            word(1)
        ));
    }
    let n = word(5) as usize;
    if wkb.len() != 9 + 16 * n {
        return Err(format!("{} bytes for {n} points", wkb.len()));
    }
    let double = |at: usize| f64::from_le_bytes(wkb[at..at + 8].try_into().unwrap());
    out.extend((0..n).map(|k| [double(9 + 16 * k), double(17 + 16 * k)]));
    Ok(n)
}
