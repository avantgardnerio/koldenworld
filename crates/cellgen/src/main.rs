use postgres::{Client, NoTls};

/// OSM highway=* values we store, as in packages/world/src/road-graph.ts; a way's class is an index into this.
const ROAD_CLASSES: [&str; 15] = [
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
struct RoadWays {
    osm_id: Vec<i64>,
    class: Vec<u8>,        // index into ROAD_CLASSES
    name: Vec<u32>,        // index into names; 0 = unnamed
    node_start: Vec<u32>,  // ways + 1 offsets into the node columns
    node_id: Vec<i64>,     // OSM node ids, in way order
    lonlat: Vec<[f64; 2]>, // degrees, one per node id
    names: Vec<String>,    // names[0] = ""
}

/// Level of our cells: 2^13 cells across each cube face, about 1.1 km.
const CELL_LEVEL: u32 = 13;
const DEG: f64 = std::f64::consts::PI / 180.0;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Same database as the TS cell server: the local socket, as the runtime role (trust auth).
    let mut db = Client::connect("host=/var/run/postgresql user=game dbname=game", NoTls)?;

    // The level-13 cell at Five Points, Denver: a square in its cube face's (s, t), drawn with a quarter of
    // its size around it.
    let (face, [s, t]) = lat_lon_to_face_st(39.7557, -104.9779);
    let n = (1u32 << CELL_LEVEL) as f64;
    let cell = [
        (s * n).floor() / n,
        (t * n).floor() / n,
        ((s * n).floor() + 1.0) / n,
        ((t * n).floor() + 1.0) / n,
    ];
    let m = 0.25 / n;
    let view = [cell[0] - m, cell[1] - m, cell[2] + m, cell[3] + m];

    // Postgres finds ways by lon/lat: the view's corners, padded (its edges bow a little in lon/lat).
    let corners = [
        [view[0], view[1]],
        [view[2], view[1]],
        [view[2], view[3]],
        [view[0], view[3]],
    ]
    .map(|st| st_to_lat_lon(face, st));
    let pad = 0.001;
    let (south, north) = (
        corners.iter().map(|c| c.0).fold(f64::MAX, f64::min) - pad,
        corners.iter().map(|c| c.0).fold(f64::MIN, f64::max) + pad,
    );
    let (west, east) = (
        corners.iter().map(|c| c.1).fold(f64::MAX, f64::min) - pad,
        corners.iter().map(|c| c.1).fold(f64::MIN, f64::max) + pad,
    );
    let ways = load_road_ways(&mut db, west, south, east, north)?;
    println!(
        "{} road ways, {} nodes, {} distinct names",
        ways.osm_id.len(),
        ways.node_id.len(),
        ways.names.len() - 1
    );

    // Every node onto the cell's face, even one whose own face is a neighbor.
    let st: Vec<[f64; 2]> = ways
        .lonlat
        .iter()
        .map(|&[lon, lat]| face_st(face, lat, lon))
        .collect();

    let path = "target/five-points.png";
    draw_png(&ways, &st, view, cell, 1024, path)?;
    println!(
        "face {face}, cell s {:.6}..{:.6}, t {:.6}..{:.6}; wrote {path}",
        cell[0], cell[2], cell[1], cell[3]
    );
    Ok(())
}

fn load_road_ways(
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

/// Every way as a line in (s, t) on the cell's face, with the cell's square in red: `view` (s0, t0, s1, t1) fills
/// a `size` px square, s to the right and t up.
fn draw_png(
    ways: &RoadWays,
    st: &[[f64; 2]],
    view: [f64; 4],
    cell: [f64; 4],
    size: u32,
    path: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut pixmap = tiny_skia::Pixmap::new(size, size).ok_or("bad image size")?;
    pixmap.fill(tiny_skia::Color::WHITE);
    let to_px = |[s, t]: [f64; 2]| {
        (
            ((s - view[0]) / (view[2] - view[0]) * size as f64) as f32,
            ((view[3] - t) / (view[3] - view[1]) * size as f64) as f32,
        )
    };
    let mut paint = tiny_skia::Paint {
        anti_alias: true,
        ..Default::default()
    };
    let stroke = tiny_skia::Stroke {
        width: 2.0,
        ..Default::default()
    };
    let mut draw =
        |points: &mut dyn Iterator<Item = [f64; 2]>, closed: bool, paint: &tiny_skia::Paint| {
            let mut line = tiny_skia::PathBuilder::new();
            for (k, p) in points.enumerate() {
                let (x, y) = to_px(p);
                if k == 0 {
                    line.move_to(x, y)
                } else {
                    line.line_to(x, y)
                }
            }
            if closed {
                line.close();
            }
            if let Some(line) = line.finish() {
                pixmap.stroke_path(
                    &line,
                    paint,
                    &stroke,
                    tiny_skia::Transform::identity(),
                    None,
                );
            }
        };

    paint.set_color_rgba8(60, 60, 60, 255);
    for w in 0..ways.osm_id.len() {
        draw(
            &mut st[ways.node_start[w] as usize..ways.node_start[w + 1] as usize]
                .iter()
                .copied(),
            false,
            &paint,
        );
    }
    paint.set_color_rgba8(220, 40, 40, 255);
    let [s0, t0, s1, t1] = cell;
    draw(
        &mut [[s0, t0], [s1, t0], [s1, t1], [s0, t1]].into_iter(),
        true,
        &paint,
    );

    pixmap.save_png(path)?;
    Ok(())
}

// --- S2's cube faces (a slice of packages/world/src/s2.ts) -----------------------------------------------
// The sphere is projected onto a cube: a direction's face is its largest axis, (u, v) in [-1, 1] is where it
// meets that face (gnomonic), and (s, t) in [0, 1] stretches (u, v) quadratically to even out cell sizes.
// Lat/lon are taken as spherical coordinates, as S2 does.

/// The face a point is on, and its (s, t) there.
fn lat_lon_to_face_st(lat: f64, lon: f64) -> (u32, [f64; 2]) {
    let [x, y, z] = lat_lon_to_xyz(lat, lon);
    let (ax, ay, az) = (x.abs(), y.abs(), z.abs());
    let mut face = if ax > ay {
        if ax > az { 0 } else { 2 }
    } else if ay > az {
        1
    } else {
        2
    };
    if [x, y, z][face as usize] < 0.0 {
        face += 3;
    }
    (face, face_st(face, lat, lon))
}

/// A point's (s, t) on a given face, whichever face it's nearest (a point just over the face's edge).
fn face_st(face: u32, lat: f64, lon: f64) -> [f64; 2] {
    let [x, y, z] = lat_lon_to_xyz(lat, lon);
    let [u, v] = match face {
        0 => [y / x, z / x],
        1 => [-x / y, z / y],
        2 => [-x / z, -y / z],
        3 => [z / x, y / x],
        4 => [z / y, -x / y],
        _ => [-y / z, -x / z],
    };
    [uv_to_st(u), uv_to_st(v)]
}

/// The inverse of face_st: (lat, lon) in degrees.
fn st_to_lat_lon(face: u32, [s, t]: [f64; 2]) -> (f64, f64) {
    let (u, v) = (st_to_uv(s), st_to_uv(t));
    let [x, y, z] = match face {
        0 => [1.0, u, v],
        1 => [-u, 1.0, v],
        2 => [-u, -v, 1.0],
        3 => [-1.0, -v, -u],
        4 => [v, -1.0, -u],
        _ => [v, u, -1.0],
    };
    (z.atan2(x.hypot(y)) / DEG, y.atan2(x) / DEG)
}

fn lat_lon_to_xyz(lat: f64, lon: f64) -> [f64; 3] {
    let cos_lat = (lat * DEG).cos();
    [
        cos_lat * (lon * DEG).cos(),
        cos_lat * (lon * DEG).sin(),
        (lat * DEG).sin(),
    ]
}

fn uv_to_st(u: f64) -> f64 {
    if u >= 0.0 {
        0.5 * (1.0 + 3.0 * u).sqrt()
    } else {
        1.0 - 0.5 * (1.0 - 3.0 * u).sqrt()
    }
}

fn st_to_uv(s: f64) -> f64 {
    if s >= 0.5 {
        (4.0 * s * s - 1.0) / 3.0
    } else {
        (1.0 - 4.0 * (1.0 - s) * (1.0 - s)) / 3.0
    }
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
