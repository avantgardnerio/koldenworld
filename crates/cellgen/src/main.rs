mod draw;
mod graph;
mod s2;
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

    let graph = graph::build_graph(&ways);
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

    // The busiest junctions: every node where five or more edges meet, with the streets meeting there.
    for n in (0..graph.node_count()).filter(|&n| graph.degree(n) >= 5) {
        let streets: Vec<&str> = graph
            .edges_at(n)
            .iter()
            .map(|&e| graph.street_name(&ways, e as usize))
            .collect();
        println!(
            "  degree {} at {:?}: {streets:?}",
            graph.degree(n),
            ways.lonlat[graph.node_point[n] as usize]
        );
    }

    let path = "target/five-points.png";
    draw::draw_png(&ways, &graph, view, cell, 1024, path)?;
    println!(
        "face {face}, cell s {:.6}..{:.6}, t {:.6}..{:.6}; wrote {path}",
        cell[0], cell[2], cell[1], cell[3]
    );
    Ok(())
}
