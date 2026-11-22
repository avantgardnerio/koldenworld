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
#[derive(Default)]
pub struct RoadWays {
    pub osm_id: Vec<i64>,
    pub class: Vec<u8>,        // index into ROAD_CLASSES
    pub name: Vec<u32>,        // index into names; 0 = unnamed
    pub node_start: Vec<u32>,  // ways + 1 offsets into the node columns
    pub node_id: Vec<i64>,     // OSM node ids, in way order
    pub lonlat: Vec<[f64; 2]>, // degrees, one per node id
    pub st: Vec<[f64; 2]>,     // (s, t) on the cell's face, one per node id (filled after loading)
    pub names: Vec<String>,    // names[0] = ""
}

/// Every road way intersecting a lon/lat box, ordered by OSM id.
pub fn load_road_ways(
    db: &mut Client,
    west: f64,
    south: f64,
    east: f64,
    north: f64,
) -> Result<RoadWays, Box<dyn std::error::Error>> {
    let rows = db.query(
        "SELECT osm_way_id, class, name, node_ids, ST_AsBinary(geom) FROM road_ways
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
    }
    Ok(ways)
}

/// A WKB LineString's points (as PostGIS's ST_AsBinary writes it: byte order, type 2, count, then x, y doubles).
fn wkb_line_string(wkb: &[u8], out: &mut Vec<[f64; 2]>) -> Result<usize, String> {
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
