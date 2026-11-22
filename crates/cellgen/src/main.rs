mod clip;
mod draw;
mod elevation;
mod faces;
mod geodesy;
mod geom;
mod graph;
mod markings;
mod mesh;
mod polygon;
mod s2;
mod terrain;
mod water;
mod ways;
mod widths;

use postgres::{Client, NoTls};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Same database as the TS cell server: the local socket, as the runtime role (trust auth).
    let mut db = Client::connect("host=/var/run/postgresql user=game dbname=game", NoTls)?;

    // The level-13 cell on Speer Boulevard between Broadway and Washington Street, Denver, where Cherry Creek runs
    // between its carriageways under seven bridges: a square in its cube face's (s, t), drawn with a quarter of
    // its size around it.
    let (face, st) = s2::lat_lon_to_face_st(39.7238, -104.9834);
    let cell = s2::cell_square(st, s2::CELL_LEVEL);
    let m = 0.25 * (cell[2] - cell[0]);
    let view = [cell[0] - m, cell[1] - m, cell[2] + m, cell[3] + m];

    // Every way in the view (Postgres finds them by lon/lat), then every node onto the cell's face, even one
    // whose own face is a neighbor.
    let [west, south, east, north] = s2::lat_lon_bounds(face, view, 0.001);
    let mut ways = ways::load_road_ways(&mut db, west, south, east, north)?;
    let water = water::load_water(&mut db, west, south, east, north)?;
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

    let path = "target/cell.png";
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
    let dart_widths = widths::dart_widths(&graph, &ways);
    let grounds: Vec<clip::Ground> = regions
        .iter()
        .map(|r| clip::ground(r, &square, &metric, &dart_widths))
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
    let [_, pav, gr, sw, lot] = sums;
    println!(
        "cell ground, {} regions in {took:.0?}: pavement {pav:.0}, grass {gr:.0}, sidewalk {sw:.0}, lot {lot:.0} m²; \
         regions not adding up: {off}; ids known on {} of {} vertices",
        regions.len(),
        known[0],
        known[1]
    );

    // Markings, cut out of the pavement where they're not in a junction zone: asphalt, yellow and white are kinds of
    // ground like the rest, every point exactly one.
    let started = std::time::Instant::now();
    let merge = |k: usize| -> clipper2_rust::Paths64 {
        grounds
            .iter()
            .flat_map(|g| g.parts[k].iter().cloned())
            .collect()
    };
    let nonzero = clipper2_rust::FillRule::NonZero;
    let pavement = clipper2_rust::union_subjects_64(&merge(0), nonzero);
    let (lo, hi) = clip::square_bounds(&square);
    let near = |p: glam::DVec2| {
        p.x >= lo.x - 50.0 && p.x <= hi.x + 50.0 && p.y >= lo.y - 50.0 && p.y <= hi.y + 50.0
    };
    let half_width: Vec<f64> = (0..graph.edge_count())
        .map(|e| dart_widths[2 * e][0].max(dart_widths[2 * e + 1][0]))
        .collect();
    let zones = markings::junction_zones(&graph, &ways, &metric, &half_width, near);
    let lines = markings::lines(&graph, &ways, &metric, near);
    let markable = clipper2_rust::difference_64(&pavement, &zones, nonzero);
    let yellow = clipper2_rust::intersect_64(
        &clipper2_rust::union_subjects_64(&lines.yellow, nonzero),
        &markable,
        nonzero,
    );
    let white = clipper2_rust::difference_64(
        &clipper2_rust::intersect_64(
            &clipper2_rust::union_subjects_64(&lines.white, nonzero),
            &markable,
            nonzero,
        ),
        &yellow,
        nonzero,
    );
    let asphalt = clipper2_rust::difference_64(
        &pavement,
        &clipper2_rust::union_subjects_64(&[yellow.clone(), white.clone()].concat(), nonzero),
        nonzero,
    );
    // Water: lines expanded like roads and areas, in the cell. Road (asphalt, markings, sidewalk: bridges keep their
    // walks) wins where they meet; water takes what it covers of the grass strips and lots.
    let water_all = clipper2_rust::intersect_64(&water.paths(face, &metric), &square, nonzero);
    let sidewalk = merge(2);
    let road = clipper2_rust::union_subjects_64(
        &[
            asphalt.clone(),
            yellow.clone(),
            white.clone(),
            sidewalk.clone(),
        ]
        .concat(),
        nonzero,
    );
    let water_left = clipper2_rust::difference_64(&water_all, &road, nonzero);
    let grass = clipper2_rust::difference_64(&merge(1), &water_left, nonzero);
    let lots = clipper2_rust::difference_64(&merge(3), &water_left, nonzero);
    let kinds = [
        &asphalt,
        &yellow,
        &white,
        &grass,
        &sidewalk,
        &lots,
        &water_left,
    ];
    let [sum, uncovered] = clip::tally(&square, &kinds);
    let m2: Vec<String> = kinds
        .iter()
        .map(|k| format!("{:.0}", clip::area(k)))
        .collect();
    println!(
        "cell ground, in {:.0?}: asphalt {} + yellow {} + white {} + grass {} + sidewalk {} + lot {} + water {} = \
         {sum:.2} m²; square {:.2} m²; uncovered {uncovered:.3} m², so overlapping at most {:.3} m²",
        started.elapsed(),
        m2[0],
        m2[1],
        m2[2],
        m2[3],
        m2[4],
        m2[5],
        m2[6],
        clip::area(&square),
        uncovered + (sum - clip::area(&square)).abs()
    );

    let polys: Vec<Vec<polygon::Polygon>> =
        kinds.iter().map(|k| clip::from_paths(k, &metric)).collect();
    let colors = [
        [72, 72, 76],
        [232, 190, 40],
        [240, 240, 236],
        [104, 150, 72],
        [196, 194, 186],
        [126, 170, 92],
        [64, 120, 190],
    ];
    let fills: Vec<(Vec<&polygon::Polygon>, [u8; 3])> = polys
        .iter()
        .zip(colors)
        .map(|(ps, c)| (ps.iter().collect(), c))
        .collect();
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
    draw::draw_png(&fills, &cell_frame, path)?;
    // Terrain: heights above the WGS84 ellipsoid at the cell's (n + 1)² lattice, evenly spaced in (s, t), row by row
    // (t outer, s inner), as the TS terrain (TERRAIN_N = 64).
    let started = std::time::Instant::now();
    let n = 64;
    let elevation = elevation::Elevation::region(
        std::path::Path::new("../../data/dem"),
        [west, south, east, north],
    )?;
    let heights: Vec<f64> = (0..=n)
        .flat_map(|b| (0..=n).map(move |a| (a, b)))
        .map(|(a, b)| {
            let st = [
                cell[0] + (cell[2] - cell[0]) * a as f64 / n as f64,
                cell[1] + (cell[3] - cell[1]) * b as f64 / n as f64,
            ];
            let (lat, lon) = s2::st_to_lat_lon(face, st);
            elevation.height(lat, lon)
        })
        .collect();
    let (lo, hi) = heights
        .iter()
        .fold((f64::MAX, f64::MIN), |(lo, hi), &h| (lo.min(h), hi.max(h)));
    println!(
        "terrain: {}² heights in {:.0?}, {lo:.2}..{hi:.2} m above the ellipsoid; {} without data",
        n + 1,
        started.elapsed(),
        elevation.missing.get()
    );
    std::fs::write(
        "target/heights.txt",
        heights
            .iter()
            .map(|h| format!("{h:.4}"))
            .collect::<Vec<_>>()
            .join("\n"),
    )?;
    let spacing = metric.to_m.col(0).length() * (cell[2] - cell[0]) / n as f64;
    draw::draw_heights(&heights, n, spacing, "target/heights.png")?;

    // The ground draped: every kind cut by the terrain grid, each vertex at its triangle's height.
    let started = std::time::Instant::now();
    let terrain = terrain::Terrain::new(n, heights, cell);
    let draped = terrain.cut(&kinds, &metric);
    let took = started.elapsed();
    let lost: Vec<String> = (0..kinds.len())
        .map(|k| {
            format!(
                "{:.3}",
                clip::area(kinds[k]) - terrain.area(&draped, k as u8, &metric)
            )
        })
        .collect();
    let (lo, hi) = draped
        .h
        .iter()
        .fold((f64::MAX, f64::MIN), |(lo, hi), &h| (lo.min(h), hi.max(h)));
    println!(
        "draped in {took:.0?}: {} pieces, {} vertices, {lo:.2}..{hi:.2} m; area lost per kind (m²): {}",
        draped.kind.len(),
        draped.st.len(),
        lost.join(", ")
    );
    let spacing = glam::DVec2::new(
        metric.to_m.col(0).length() * (cell[2] - cell[0]),
        metric.to_m.col(1).length() * (cell[3] - cell[1]),
    ) / n as f64;
    draw::draw_draped(
        &draped,
        &colors,
        |tri| terrain.light(tri, spacing),
        &cell_frame,
        "target/draped.png",
    )?;

    // GPU buffers: the draped pieces triangulated, positions and normals in the cell's ENU frame.
    let started = std::time::Instant::now();
    let mesh = mesh::build(&draped, &terrain, face, cell);
    let took = started.elapsed();
    let tri_area = |t: &[u32], flat: bool| {
        let p = |i: u32| {
            let v = glam::Vec3::from_array(mesh.positions[i as usize]).as_dvec3();
            if flat { v.with_z(0.0) } else { v }
        };
        (p(t[1]) - p(t[0])).cross(p(t[2]) - p(t[0])).length() / 2.0
    };
    let (flat, sloped): (f64, f64) = mesh
        .indices
        .chunks(3)
        .map(|t| (tri_area(t, true), tri_area(t, false)))
        .fold((0.0, 0.0), |a, b| (a.0 + b.0, a.1 + b.1));
    // The check: the triangles' top-down area against the cell's own, both in the ENU frame: the cell's boundary traced
    // through the exact (s, t) → ground map, 1,024 points a side (the map bends edges a little over a kilometre), at the
    // terrain's mean height (the ground is 1.6 km up, where a square is 0.05% bigger than on the ellipsoid; the cell's
    // own relief leaves the check a few m² either way).
    let mean_h = terrain.heights.iter().sum::<f64>() / terrain.heights.len() as f64;
    let cell_enu = {
        let (clat, clon) =
            s2::st_to_lat_lon(face, [(cell[0] + cell[2]) / 2.0, (cell[1] + cell[3]) / 2.0]);
        let frame = geodesy::Frame::at(clat, clon, 0.0);
        let k = 1024;
        let corners = [
            [cell[0], cell[1]],
            [cell[2], cell[1]],
            [cell[2], cell[3]],
            [cell[0], cell[3]],
        ];
        let ring = (0..4).flat_map(|c| {
            let (a, b) = (corners[c], corners[(c + 1) % 4]);
            (0..k).map(move |i| {
                [
                    a[0] + (b[0] - a[0]) * i as f64 / k as f64,
                    a[1] + (b[1] - a[1]) * i as f64 / k as f64,
                ]
            })
        });
        let ring = ring.map(|st| {
            let (lat, lon) = s2::st_to_lat_lon(face, st);
            frame.local(geodesy::ecef(lat, lon, mean_h)).truncate()
        });
        geom::signed_area(ring)
    };
    println!(
        "mesh in {took:.0?}: {} vertices, {} triangles ({} pieces failed); {} index ranges by kind; {:.1} MB; \
         area top-down {flat:.2} m², the cell at {mean_h:.0} m {cell_enu:.2} m² (off by {:.2}); on the slopes {sloped:.0} m²",
        mesh.positions.len(),
        mesh.indices.len() / 3,
        mesh.failed,
        mesh.ranges.len(),
        (mesh.positions.len() * 25 + mesh.indices.len() * 4) as f64 / 1e6,
        flat - cell_enu
    );
    draw::draw_mesh(&mesh, &colors, 4096, "target/mesh.png")?;

    // Close up: the busiest marked junction in the cell (most marked roads meeting), 70 m across.
    let marked = |e: usize| widths::profile(ways.class[graph.edge_way[e] as usize]).2;
    let in_cell =
        |p: [f64; 2]| p[0] > cell[0] && p[0] < cell[2] && p[1] > cell[1] && p[1] < cell[3];
    if let Some(n) = (0..graph.node_count())
        .filter(|&n| graph.degree(n) >= 3 && in_cell(ways.st[graph.node_point[n] as usize]))
        .max_by_key(|&n| {
            graph
                .ends_at(n)
                .iter()
                .filter(|&&h| marked((h / 2) as usize))
                .count()
        })
    {
        let c = ways.st[graph.node_point[n] as usize];
        let r = 35.0 / metric.to_m.col(0).length();
        let zoom = draw::View {
            view: [c[0] - r, c[1] - r, c[0] + r, c[1] + r],
            cell,
            size: 1400,
        };
        draw::draw_png(&fills, &zoom, "target/junction.png")?;
        let streets: Vec<&str> = graph
            .ends_at(n)
            .iter()
            .map(|&h| graph.street_name(&ways, (h / 2) as usize))
            .collect();
        println!("junction close-up: {streets:?}");
    }

    println!(
        "face {face}, cell s {:.6}..{:.6}, t {:.6}..{:.6}; wrote {path}",
        cell[0], cell[2], cell[1], cell[3]
    );
    Ok(())
}
