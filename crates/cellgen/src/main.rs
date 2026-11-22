use postgres::{Client, NoTls};

/// OSM highway=* values we store, as in packages/world/src/road-graph.ts; a way's class is an index into this.
const ROAD_CLASSES: [&str; 15] = [
    "motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link", "secondary", "secondary_link",
    "tertiary", "tertiary_link", "unclassified", "residential", "living_street", "service", "road",
];

/// Road ways as columns (no object per way or point): per-way columns, and per-node columns
/// with each way's nodes at node_start[w]..node_start[w + 1] (CSR).
#[derive(Default)]
struct RoadWays {
    osm_id: Vec<i64>,
    class: Vec<u8>,          // index into ROAD_CLASSES
    name: Vec<u32>,          // index into names; 0 = unnamed
    node_start: Vec<u32>,    // ways + 1 offsets into the node columns
    node_id: Vec<i64>,       // OSM node ids, in way order
    lonlat: Vec<[f64; 2]>,   // degrees, one per node id
    names: Vec<String>,      // names[0] = ""
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Same database as the TS cell server: the local socket, as the runtime role (trust auth).
    let mut db = Client::connect("host=/var/run/postgresql user=game dbname=game", NoTls)?;

    // Five Points, Denver, with a box of about ±550 m around it.
    let (lat, lon, d) = (39.7557, -104.9779, 0.005);
    let ways = load_road_ways(&mut db, lon - d, lat - d, lon + d, lat + d)?;

    println!("{} road ways, {} nodes, {} distinct names", ways.osm_id.len(), ways.node_id.len(), ways.names.len() - 1);

    let path = "target/five-points.png";
    draw_png(&ways, [lon - d, lat - d, lon + d, lat + d], 1024, path)?;
    println!("wrote {path}");
    Ok(())
}

fn load_road_ways(db: &mut Client, west: f64, south: f64, east: f64, north: f64) -> Result<RoadWays, Box<dyn std::error::Error>> {
    let rows = db.query(
        "SELECT osm_way_id, class, name, node_ids, ST_AsBinary(geom) FROM road_ways
         WHERE ST_Intersects(geom, ST_MakeEnvelope($1, $2, $3, $4, 4326))
         ORDER BY osm_way_id",
        &[&west, &south, &east, &north],
    )?;
    let mut ways = RoadWays { node_start: vec![0], names: vec![String::new()], ..Default::default() };
    let mut name_index = std::collections::HashMap::new();
    for row in &rows {
        let id: i64 = row.get(0);
        let class: &str = row.get(1);
        let name: Option<&str> = row.get(2);
        let node_ids: Vec<i64> = row.get(3);
        let points = wkb_line_string(row.get(4), &mut ways.lonlat).map_err(|e| format!("way {id}: {e}"))?;
        if points != node_ids.len() {
            return Err(format!("way {id}: {} node ids but {points} points", node_ids.len()).into());
        }
        ways.osm_id.push(id);
        ways.class.push(ROAD_CLASSES.iter().position(|c| *c == class).ok_or(format!("way {id}: unknown class {class}"))? as u8);
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

/// Every way as a line, top-down, with lon and lat taken as plain x and y: `bbox` (west, south, east, north) fills a
/// `size` px square, north up.
fn draw_png(ways: &RoadWays, [west, south, east, north]: [f64; 4], size: u32, path: &str) -> Result<(), Box<dyn std::error::Error>> {
    let mut pixmap = tiny_skia::Pixmap::new(size, size).ok_or("bad image size")?;
    pixmap.fill(tiny_skia::Color::WHITE);
    let to_px = |[lon, lat]: [f64; 2]| {
        (((lon - west) / (east - west) * size as f64) as f32, ((north - lat) / (north - south) * size as f64) as f32)
    };

    let mut paint = tiny_skia::Paint::default();
    paint.set_color_rgba8(60, 60, 60, 255);
    paint.anti_alias = true;
    let stroke = tiny_skia::Stroke { width: 2.0, ..Default::default() };

    for w in 0..ways.osm_id.len() {
        let points = &ways.lonlat[ways.node_start[w] as usize..ways.node_start[w + 1] as usize];
        let mut line = tiny_skia::PathBuilder::new();
        let (x, y) = to_px(points[0]);
        line.move_to(x, y);
        for &p in &points[1..] {
            let (x, y) = to_px(p);
            line.line_to(x, y);
        }
        if let Some(line) = line.finish() {
            pixmap.stroke_path(&line, &paint, &stroke, tiny_skia::Transform::identity(), None);
        }
    }
    pixmap.save_png(path)?;
    Ok(())
}

/// A WKB LineString's points (as PostGIS's ST_AsBinary writes it: byte order, type 2, count, then x, y doubles).
fn wkb_line_string(wkb: &[u8], out: &mut Vec<[f64; 2]>) -> Result<usize, String> {
    if wkb.len() < 9 || wkb[0] != 1 {
        return Err("expected little-endian WKB".into());
    }
    let word = |at: usize| u32::from_le_bytes(wkb[at..at + 4].try_into().unwrap());
    if word(1) != 2 {
        return Err(format!("expected a LineString (type 2), got type {}", word(1)));
    }
    let n = word(5) as usize;
    if wkb.len() != 9 + 16 * n {
        return Err(format!("{} bytes for {n} points", wkb.len()));
    }
    let double = |at: usize| f64::from_le_bytes(wkb[at..at + 8].try_into().unwrap());
    out.extend((0..n).map(|k| [double(9 + 16 * k), double(17 + 16 * k)]));
    Ok(n)
}
