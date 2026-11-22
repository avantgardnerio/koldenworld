mod bands;
mod clip;
mod draw;
mod faces;
mod geom;
mod graph;
mod layer;
mod pavement;
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
    let m2_per_st2 = metric.area_scale();
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

    // Layers, each the one before shrunk further, every vertex still knowing its dart: the kerb (blocks shrunk by
    // half a road, 4 m until widths come from lanes), the back of the grass (1.5 m in), the back of the sidewalk
    // (1.8 m further). What's left inside is the lot.
    let area = |ps: &mut dyn Iterator<Item = &polygon::Polygon>| -> f64 {
        ps.map(|p| p.signed_area().max(0.0)).sum::<f64>() * m2_per_st2 / 1e6
    };
    let mut stats = shrink::ShrinkStats::default();
    let kerb: Vec<Vec<polygon::Polygon>> = polygons
        .iter()
        .map(|p| {
            if p.signed_area() > 0.0 {
                p.shrink(4.0, &metric, &mut stats)
            } else {
                Vec::new()
            }
        })
        .collect();
    println!("kerb, 4 m in: {stats:?}");
    let shrink_layer = |layer: &[Vec<polygon::Polygon>], d: f64, name: &str| {
        let mut stats = shrink::ShrinkStats::default();
        let next: Vec<Vec<polygon::Polygon>> = layer
            .iter()
            .map(|islands| {
                islands
                    .iter()
                    .flat_map(|p| p.shrink(d, &metric, &mut stats))
                    .collect()
            })
            .collect();
        println!("{name}, {d} m further: {stats:?}");
        next
    };
    let grass_back = shrink_layer(&kerb, 1.5, "back of the grass");
    let lot_islands = shrink_layer(&grass_back, 1.8, "back of the sidewalk");
    let lot_polygons: Vec<&polygon::Polygon> = lot_islands.iter().flatten().collect();
    let [kerb, grass_back, lots] =
        [&kerb, &grass_back, &lot_islands].map(|l| layer::Layer::new(&graph, &faces, l));

    // The roads in the void, then the bands between the layers.
    let pavement = pavement::pave(&graph, &kerb);
    let grass = bands::band(&graph, &kerb, &grass_back);
    let sidewalk = bands::band(&graph, &grass_back, &lots);
    println!(
        "pavement: {} strips ({} missing), {} junctions ({} missing); {:.3} km²; failed strip sides: {:?}",
        pavement.strips.len(),
        pavement.missing_strips,
        pavement.junctions.len(),
        pavement.missing_junctions,
        area(&mut pavement.strips.iter().chain(&pavement.junctions)),
        pavement.why
    );
    for (name, b) in [("grass", &grass), ("sidewalk", &sidewalk)] {
        println!(
            "{name}: {} pieces ({} missing: {:?}); {:.3} km²",
            b.pieces.len(),
            b.missing,
            b.why,
            area(&mut b.pieces.iter())
        );
    }
    println!(
        "lots: {} islands; {:.3} km² (blocks were {:.3} km²)",
        lot_polygons.len(),
        area(&mut lot_polygons.iter().copied()),
        area(&mut polygons.iter())
    );

    let path = "target/five-points.png";
    let frame = draw::View {
        view,
        cell,
        size: 4096,
    };
    fn all(ps: &[polygon::Polygon]) -> Vec<&polygon::Polygon> {
        ps.iter().collect()
    }
    let pavement_polygons = all(&pavement.strips)
        .into_iter()
        .chain(&pavement.junctions)
        .collect();
    let fills = [
        (lot_polygons, [126, 170, 92]), // lots: lawn, a shade lighter than the grass strip
        (pavement_polygons, [72, 72, 76]), // asphalt
        (all(&grass.pieces), [104, 150, 72]), // grass
        (all(&sidewalk.pieces), [196, 194, 186]), // concrete
    ];
    draw::draw_png(&fills, &frame, "target/five-points-ours.png")?;
    // The cell's ground by Clipper2. Regions: every block, with the road pieces inside it (their outside faces) as
    // holes, and the cell itself around the network (its outer edge no road), with the network's outside as a hole.
    let started = std::time::Instant::now();
    let components = graph.components();
    let piece = |f: usize| components[graph.edge_from[(faces.darts(f)[0] / 2) as usize] as usize];
    let is_block = |f: usize| polygons[f].signed_area() > 0.0;
    let mut holes_of: Vec<Vec<&polygon::Polygon>> = vec![Vec::new(); faces.count()];
    let mut around: Vec<&polygon::Polygon> = Vec::new();
    for f in (0..faces.count()).filter(|&f| !is_block(f)) {
        // The innermost block of another piece this one lies in, if any.
        let probe = polygons[f].positions().next().ok_or("empty face")?;
        let host = (0..faces.count())
            .filter(|&b| is_block(b) && piece(b) != piece(f) && polygons[b].contains(probe))
            .min_by(|&a, &b| {
                polygons[a]
                    .signed_area()
                    .total_cmp(&polygons[b].signed_area())
            });
        match host {
            Some(b) => holes_of[b].push(&polygons[f]),
            None => around.push(&polygons[f]),
        }
    }
    // Whether a block's bounding box overlaps the cell's square (vertices alone miss a block round a corner).
    let in_cell = |p: &polygon::Polygon| {
        let (lo, hi) = p
            .positions()
            .fold((glam::DVec2::MAX, glam::DVec2::MIN), |(lo, hi), q| {
                (lo.min(q), hi.max(q))
            });
        lo.x <= cell[2] && hi.x >= cell[0] && lo.y <= cell[3] && hi.y >= cell[1]
    };
    let mut regions: Vec<clip::Region> = (0..faces.count())
        .filter(|&f| is_block(f))
        .map(|f| clip::Region {
            outer: clip::Outer::Road(&polygons[f]),
            holes: std::mem::take(&mut holes_of[f]),
        })
        .filter(|r| matches!(r.outer, clip::Outer::Road(p) if in_cell(p)) || !r.holes.is_empty())
        .collect();
    regions.push(clip::Region {
        outer: clip::Outer::Cell,
        holes: around,
    });
    let square = clip::square(cell, &metric);
    let grounds: Vec<clip::Ground> = regions
        .iter()
        .map(|r| clip::ground(r, &square, &metric, [4.0, 1.5, 1.8]))
        .collect();
    let took = started.elapsed();

    // The checks: each region's ground adds up to it, the cell's to the square, and nothing overlaps (the union of
    // every piece is as big as their sum).
    let mut sums = [0.0; 5];
    let mut known = [0; 2];
    let mut off = 0;
    for g in &grounds {
        for (s, a) in sums.iter_mut().zip(g.areas) {
            *s += a;
        }
        known[0] += g.known[0];
        known[1] += g.known[1];
        let [b, pav, gr, sw, lot] = g.areas;
        off += ((b - (pav + gr + sw + lot)).abs() > 0.01) as usize;
    }
    let kind = |pick: fn(&clip::Ground) -> &Vec<polygon::Polygon>| -> Vec<&polygon::Polygon> {
        grounds.iter().flat_map(|g| pick(g).iter()).collect()
    };
    let square_m2 = clip::area(&square);
    let union_m2 = clip::union_area(&grounds);
    let uncovered: f64 = clip::uncovered(&square, &grounds).iter().map(|l| l.0).sum();
    let [_, pav, gr, sw, lot] = sums;
    println!(
        "cell ground, {} regions in {took:.0?}: pavement {:.0} + grass {:.0} + sidewalk {:.0} + lot {:.0} = {:.2} m²; \
         square {:.2} m²; union {:.2} m²; uncovered {:.3} m²; regions not adding up: {off}; ids known on {} of {} vertices",
        regions.len(),
        pav,
        gr,
        sw,
        lot,
        pav + gr + sw + lot,
        square_m2,
        union_m2,
        uncovered,
        known[0],
        known[1]
    );
    let clipped = [
        (kind(|g| &g.lot), [126, 170, 92]),
        (kind(|g| &g.pavement), [72, 72, 76]),
        (kind(|g| &g.grass), [104, 150, 72]),
        (kind(|g| &g.sidewalk), [196, 194, 186]),
    ];
    let margin = 0.02 * (cell[2] - cell[0]);
    let cell_frame = draw::View {
        view: [
            cell[0] - margin,
            cell[1] - margin,
            cell[2] + margin,
            cell[3] + margin,
        ],
        cell,
        size: 4096,
    };
    draw::draw_png(&clipped, &cell_frame, path)?;

    println!(
        "face {face}, cell s {:.6}..{:.6}, t {:.6}..{:.6}; wrote {path}",
        cell[0], cell[2], cell[1], cell[3]
    );
    Ok(())
}
