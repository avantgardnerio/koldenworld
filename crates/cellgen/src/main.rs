mod draw;
mod faces;
mod graph;
mod polygon;
mod s2;
mod shrink;
mod ways;

use postgres::{Client, NoTls};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Same database as the TS cell server: the local socket, as the runtime role (trust auth).
    let mut db = Client::connect("host=/var/run/postgresql user=game dbname=game", NoTls)?;

    // The level-13 cell at Five Points, Denver: a square in its cube face's (s, t), drawn with a quarter of
    // its size around it.
    let (face, st) = s2::lat_lon_to_face_st(39.7557, -104.9779);
    let cell = s2::cell_square(st, s2::CELL_LEVEL);
    let m = 0.25 * (cell[2] - cell[0]);
    let view = [cell[0] - m, cell[1] - m, cell[2] + m, cell[3] + m];

    // Every way in the view (Postgres finds them by lon/lat), then every node onto the cell's face, even one
    // whose own face is a neighbor.
    let [west, south, east, north] = s2::lat_lon_bounds(face, view, 0.001);
    let mut ways = ways::load_road_ways(&mut db, west, south, east, north)?;
    ways.st = ways
        .lonlat
        .iter()
        .map(|&[lon, lat]| s2::face_st(face, lat, lon))
        .collect();
    println!(
        "{} road ways, {} nodes, {} distinct names",
        ways.osm_id.len(),
        ways.node_id.len(),
        ways.names.len() - 1
    );

    let mut graph = graph::build_graph(&ways);
    let stats = graph::sort_ends_by_angle(&mut graph, &ways);
    println!("sorted every node's edge ends counterclockwise: {stats:?}");
    let mut by_degree = [0usize; 8];
    for n in 0..graph.node_count() {
        by_degree[graph.degree(n).min(7)] += 1;
    }
    println!(
        "graph: {} nodes, {} edges; nodes by degree 1..7+: {:?}",
        graph.node_count(),
        graph.edge_count(),
        &by_degree[1..]
    );

    // The busiest junctions: every node where five or more edges meet, with the streets meeting there in
    // counterclockwise order, each with its direction in (s, t) degrees (atan2 for printing only).
    for n in (0..graph.node_count()).filter(|&n| graph.degree(n) >= 5) {
        let o = ways.st[graph.node_point[n] as usize];
        let streets: Vec<String> = graph
            .ends_at(n)
            .iter()
            .map(|&end| {
                let name = graph.street_name(&ways, (end / 2) as usize);
                let name = if name.is_empty() { "(unnamed)" } else { name };
                match graph.end_toward(&ways, end) {
                    Some(k) => {
                        let p = ways.st[k];
                        let deg = (p[1] - o[1])
                            .atan2(p[0] - o[0])
                            .to_degrees()
                            .rem_euclid(360.0);
                        format!("{deg:.0}° {name}")
                    }
                    None => format!("(no direction) {name}"),
                }
            })
            .collect();
        println!(
            "  degree {} at {:?}: {}",
            graph.degree(n),
            ways.lonlat[graph.node_point[n] as usize],
            streets.join(", ")
        );
    }

    // The polygons of the raw graph: its faces. Blocks are counterclockwise (positive area), each connected
    // piece's outside clockwise; a piece with no loop at all has one face of zero area.
    let faces = faces::trace_faces(&graph);
    let polygons: Vec<polygon::Polygon> = (0..faces.count())
        .map(|f| faces.polygon(f, &graph, &ways))
        .collect();
    let metric = s2::cell_metric(face, cell);
    let m2_per_st2 = (metric[0][0] * metric[1][1] - metric[1][0] * metric[0][1]).abs();
    let mut blocks: Vec<f64> = Vec::new();
    let (mut outsides, mut flat) = (0, 0);
    for p in &polygons {
        let area = p.signed_area() * m2_per_st2;
        if area > 0.0 {
            blocks.push(area);
        } else if area < 0.0 {
            outsides += 1;
        } else {
            flat += 1;
        }
    }
    blocks.sort_by(f64::total_cmp);
    println!(
        "faces: {} ({} blocks, {outsides} outsides, {flat} with no area); blocks from {:.0} m² to {:.0} m², \
         median {:.0} m²",
        faces.count(),
        blocks.len(),
        blocks.first().unwrap_or(&0.0),
        blocks.last().unwrap_or(&0.0),
        blocks.get(blocks.len() / 2).unwrap_or(&0.0)
    );
    // Euler's formula, a check that the faces are a planar map: V − E + F = 2 per connected piece.
    let pieces = graph.component_count();
    println!(
        "Euler: V − E + F = {} − {} + {} = {}; 2 × {pieces} pieces = {}",
        graph.node_count(),
        graph.edge_count(),
        faces.count(),
        graph.node_count() as i64 - graph.edge_count() as i64 + faces.count() as i64,
        2 * pieces
    );

    // Every block shrunk by half a road (4 m, until widths come from lanes), its self-crossings cut away.
    let mut stats = shrink::ShrinkStats::default();
    let shrunk: Vec<polygon::Polygon> = polygons
        .iter()
        .filter(|p| p.signed_area() > 0.0)
        .filter_map(|p| p.shrink(4.0, metric, &mut stats))
        .collect();
    let area = |ps: &mut dyn Iterator<Item = &polygon::Polygon>| -> f64 {
        ps.map(|p| p.signed_area().max(0.0)).sum::<f64>() * m2_per_st2 / 1e6
    };
    println!(
        "shrunk by 4 m: {} blocks left of {}; {stats:?}; block area {:.3} km² → {:.3} km²",
        shrunk.len(),
        blocks.len(),
        area(&mut polygons.iter()),
        area(&mut shrunk.iter())
    );

    let path = "target/five-points.png";
    draw::draw_png(&ways, &graph, &shrunk, view, cell, 4096, path)?;
    println!(
        "face {face}, cell s {:.6}..{:.6}, t {:.6}..{:.6}; wrote {path}",
        cell[0], cell[2], cell[1], cell[3]
    );
    Ok(())
}
