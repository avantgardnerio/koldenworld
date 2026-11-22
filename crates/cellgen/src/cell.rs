//! A cell, built: from its roads and water in Postgres and its terrain, to its ground as GPU buffers in Arrow.
//!
//! 1. The road graph of every way around the cell, each node's ends sorted counterclockwise, and its faces.
//! 2. Regions (every block, with the road pieces inside it as holes, and the cell around the network), each split into
//!    pavement, grass, sidewalk and lot by Clipper offsets of each road side to its own widths (clip.rs).
//! 3. Markings cut out of the pavement (asphalt, yellow, white), and water, which road wins against.
//! 4. Seven kinds partitioning the cell's square, checked: their sum is the square and nothing is left uncovered.
//! 5. The terrain lattice's heights, the ground cut by its triangles and draped (terrain.rs), and triangulated into
//!    buffers in the cell's ENU frame (mesh.rs), checked against the cell's own area at the ground's height.

use crate::ways::{ROAD_CLASSES, RoadWays};
use crate::{
    aeroways, buildings, clip, crossings, draw, elevation, faces, geodesy, geom, graph,
    ground_arrow, markings, mesh, polygon, s2, simplify, terrain, water, ways, widths,
};
use clipper2_rust::{FillRule, Paths64, difference_64, intersect_64, union_subjects_64};
use deadpool_postgres::Pool;
use glam::DVec2;
use std::path::Path;
use std::time::Instant;

/// The kinds of ground, in material order.
pub const KINDS: [&str; 13] = [
    "asphalt", "yellow", "white", "grass", "sidewalk", "lot", "water", "runway", "taxiway",
    "apron", "forest", "rock", "snow",
];
/// Where open ground (lot) becomes forest, rock or snow (landcover.rs): kinds of their own, in KINDS order.
const COVERS: mesh::Covers = mesh::Covers {
    lot: 5,
    forest: 10,
    rock: 11,
    snow: 12,
};
const COLORS: [[u8; 3]; 13] = [
    [72, 72, 76],
    [232, 190, 40],
    [240, 240, 236],
    [104, 150, 72],
    [196, 194, 186],
    [126, 170, 92],
    [64, 120, 190],
    [164, 166, 170],
    [125, 128, 134],
    [143, 145, 150],
    [62, 98, 58],
    [134, 124, 110],
    [238, 240, 244],
];
/// How closely round water ends and bends follow their arcs, m, at full detail.
const ARC_TOLERANCE: f64 = 0.05;
/// Terrain lattice squares across a cell (TERRAIN_N in the TS).
pub const TERRAIN_N: usize = 64;

/// A cell: its cube face, its (s, t) square, its token.
pub struct Cell {
    pub face: u32,
    pub level: u32,
    pub square: [f64; 4],
    pub token: String,
}

/// What a build draws: everything (the default), or less, for coarser tiers.
pub struct Options {
    /// Roads of this class and above (an index into ROAD_CLASSES, most important first); None: every road.
    pub min_class: Option<u8>,
    /// Road lines thinned to within this many metres before building (Douglas–Peucker); 0: every point.
    pub simplify: f64,
    /// Terrain lattice squares across the cell: TERRAIN_N, or fewer for a coarser ground.
    pub terrain: usize,
    pub markings: bool,
    pub sidewalks: bool,
    /// Roads and airports at all (the far tier has neither: too thin to see).
    pub roads: bool,
    pub airports: bool,
    /// Waterways narrower than this, m, left out (water areas always in).
    pub min_waterway: f64,
}

/// The coarse tier: tiles at this level (about 9 km across), drawn where fine cells aren't loaded.
pub const COARSE_LEVEL: u32 = 10;
/// The far tier: tiles at this level (about 70 km across), drawn where coarse tiles aren't: terrain, land cover, lakes
/// and big rivers.
pub const FAR_LEVEL: u32 = 7;

impl Options {
    /// What a cell at `level` draws: everything at the cells' level (13); at the coarse tier the residential streets
    /// and up (not service roads), simplified to 2 m, on a 32-square lattice, without markings or sidewalks; at the far
    /// tier (and above) no roads or airports, water simplified to 20 m (waterways 15 m wide and up), on a 128-square
    /// lattice.
    pub fn for_level(level: u32) -> Options {
        if level > COARSE_LEVEL {
            return Options::default();
        }
        let coarse = Options {
            min_class: ROAD_CLASSES
                .iter()
                .position(|c| *c == "residential")
                .map(|i| i as u8),
            simplify: 2.0,
            terrain: 32,
            markings: false,
            sidewalks: false,
            ..Options::default()
        };
        if level > FAR_LEVEL {
            return coarse;
        }
        Options {
            simplify: 20.0,
            terrain: 128,
            roads: false,
            airports: false,
            min_waterway: 15.0,
            ..coarse
        }
    }
}

impl Default for Options {
    fn default() -> Options {
        Options {
            min_class: None,
            simplify: 0.0,
            terrain: TERRAIN_N,
            markings: true,
            sidewalks: true,
            roads: true,
            airports: true,
            min_waterway: 0.0,
        }
    }
}

/// A built cell: its ground tables as Arrow bytes, and a line per stage.
pub struct Built {
    pub ground: Vec<u8>,
    pub triangles: Vec<u8>,
    pub buildings: Option<(Vec<u8>, Vec<u8>)>, // coarse tiles: the massing, as buildings.arrow and buildings_triangles.arrow
    pub log: Vec<String>,
}

impl Cell {
    /// The level-13 cell at a point.
    pub fn at(lat: f64, lon: f64) -> Cell {
        let (face, st) = s2::lat_lon_to_face_st(lat, lon);
        let square = s2::cell_square(st, s2::CELL_LEVEL);
        Cell {
            face,
            level: s2::CELL_LEVEL,
            square,
            token: s2::token(s2::cell_id(face, st, s2::CELL_LEVEL)),
        }
    }

    /// A cell by token, at any level, or None if it isn't one.
    pub fn from_token(token: &str) -> Option<Cell> {
        let (face, square) = s2::cell_from_token(token)?;
        let level = (-(square[2] - square[0]).log2()).round() as u32;
        let id = s2::cell_id(
            face,
            [(square[0] + square[2]) / 2.0, (square[1] + square[3]) / 2.0],
            level,
        );
        (s2::token(id) == token).then(|| Cell {
            face,
            level,
            square,
            token: token.to_string(),
        })
    }

    /// Whether the cell holds a point (as the TS cellFromLatLon at its level).
    pub fn owns(&self, lon: f64, lat: f64) -> bool {
        let (face, st) = s2::lat_lon_to_face_st(lat, lon);
        face == self.face
            && s2::cell_id(face, st, self.level)
                == s2::cell_id(self.face, self.center(), self.level)
    }

    /// The lon/lat box everything for the cell is loaded from: its square and a quarter of a cell further each way.
    pub fn load_box(&self) -> [f64; 4] {
        let cell = self.square;
        let m = 0.25 * (cell[2] - cell[0]);
        let view = [cell[0] - m, cell[1] - m, cell[2] + m, cell[3] + m];
        s2::lat_lon_bounds(self.face, view, 0.001)
    }

    fn center(&self) -> [f64; 2] {
        [
            (self.square[0] + self.square[2]) / 2.0,
            (self.square[1] + self.square[3]) / 2.0,
        ]
    }
}

/// What a cell is built from: its roads, water and heights, and a coarse tile's buildings.
pub struct Inputs {
    ways: RoadWays,
    water: water::Water,
    aeroways: aeroways::Aeroways,
    heights: Heights,
    buildings: Option<buildings::Buildings>,
}

/// An error that can cross an await (loading runs concurrently).
pub type LoadError = Box<dyn std::error::Error + Send + Sync>;

impl Inputs {
    /// From Postgres (road_ways, waterways, water_areas; buildings, for a coarse tile) and the elevation data under
    /// `data` (data/dem), all at once: each query on its own connection from `pool`, the elevation files on a
    /// blocking thread.
    pub async fn load(
        pool: &Pool,
        data: &Path,
        c: &Cell,
        options: &Options,
    ) -> Result<Inputs, LoadError> {
        let [west, south, east, north] = c.load_box();
        let dem = data.join("dem");
        let (ways, water, aeroways, buildings, heights) = tokio::try_join!(
            async {
                if !options.roads {
                    return Ok(RoadWays::empty());
                }
                let db = pool.get().await?;
                ways::load_road_ways(&db, west, south, east, north).await
            },
            async {
                let db = pool.get().await?;
                water::load_water(&db, west, south, east, north, options.min_waterway).await
            },
            async {
                if !options.airports {
                    return Ok(aeroways::Aeroways::empty());
                }
                let db = pool.get().await?;
                aeroways::load(&db, [west, south, east, north]).await
            },
            async {
                if c.level != COARSE_LEVEL {
                    return Ok(None);
                }
                let db = pool.get().await?;
                let owns = |lon, lat| c.owns(lon, lat);
                Ok::<_, LoadError>(Some(
                    buildings::load(&db, [west, south, east, north], owns).await?,
                ))
            },
            async {
                tokio::task::spawn_blocking(move || {
                    elevation::Elevation::region(&dem, [west, south, east, north])
                        .map_err(|e| e.to_string())
                })
                .await?
                .map_err(LoadError::from)
            },
        )?;
        Ok(Inputs {
            ways,
            water,
            aeroways,
            heights: Heights::Dem(heights),
            buildings,
        })
    }

    /// Fixed ways (every one of them, whatever the cell), no water, no buildings, and flat terrain `height` m above
    /// the ellipsoid: for tests and fixtures, no database or elevation data needed.
    pub fn fixture(ways: &RoadWays, height: f64, c: &Cell) -> Inputs {
        Inputs {
            ways: ways.clone(),
            water: water::Water::empty(),
            aeroways: aeroways::Aeroways::empty(),
            heights: Heights::Flat(height),
            buildings: (c.level == COARSE_LEVEL).then(buildings::Buildings::default),
        }
    }
}

/// Ground heights: the elevation data, or flat.
enum Heights {
    Dem(elevation::Elevation),
    Flat(f64),
}

impl Heights {
    fn height(&self, lat: f64, lon: f64) -> f64 {
        match self {
            Heights::Dem(e) => e.height(lat, lon),
            Heights::Flat(h) => *h,
        }
    }

    fn missing(&self) -> usize {
        match self {
            Heights::Dem(e) => e.missing.get(),
            Heights::Flat(_) => 0,
        }
    }
}

/// Builds a cell from its inputs. With `pictures`, also draws cell.png, heights.png, draped.png and mesh.png there.
pub fn build(
    inputs: Inputs,
    c: &Cell,
    options: &Options,
    pictures: Option<&Path>,
) -> Result<Built, Box<dyn std::error::Error>> {
    let (face, cell) = (c.face, c.square);
    let mut log = Vec::new();
    let nonzero = FillRule::NonZero;

    // 1. Every way around the cell (a quarter of a cell further each way), every node onto its face.
    let started = Instant::now();
    let Inputs {
        mut ways,
        water,
        aeroways,
        heights,
        buildings: owned,
    } = inputs;
    if let Some(min) = options.min_class {
        ways = ways.keep(|w| ways.class[w] <= min);
    }
    if !options.roads {
        ways = ways.keep(|_| false);
    }
    if !options.sidewalks {
        ways.sidewalks.fill(0);
    }
    ways.st = ways
        .lonlat
        .iter()
        .map(|&[lon, lat]| s2::face_st(face, lat, lon))
        .collect();
    let metric = s2::cell_metric(face, cell);
    let points = ways.node_id.len();
    if options.simplify > 0.0 {
        ways = simplify::simplify(&ways, &metric, options.simplify);
    }
    let (water, aeroways) = if options.simplify > 0.0 {
        (
            simplify::simplify_water(&water, face, &metric, options.simplify),
            simplify::simplify_aeroways(&aeroways, face, &metric, options.simplify),
        )
    } else {
        (water, aeroways)
    };
    let (ways, crossed) = crossings::split(&ways);
    let mut graph = graph::build_graph(&ways);
    let angles = graph::sort_ends_by_angle(&mut graph, &ways);
    let faces = faces::trace_faces(&graph);
    let polygons: Vec<polygon::Polygon> = (0..faces.count())
        .map(|f| faces.polygon(f, &graph, &ways))
        .collect();
    // Euler's formula, V − E + F = 2 per connected piece, holds where the roads are a planar map (a road over another
    // with no shared node, a bridge, breaks it; harmless in 2D).
    let euler = graph.node_count() as i64 - graph.edge_count() as i64 + faces.count() as i64;
    log.push(format!(
        "graph in {:.0?}: {} ways, {} nodes, {} edges, {} faces; Euler {euler} for {} pieces; {angles:?}; \
         {points} points, {} after simplifying; {} crossings split, {} touching left",
        started.elapsed(),
        ways.osm_id.len(),
        graph.node_count(),
        graph.edge_count(),
        faces.count(),
        graph.component_count(),
        ways.node_id.len() - crossed.split * 2,
        crossed.split,
        crossed.touching
    ));

    // 2. Regions: every block, with the road pieces inside it (their outside faces) as holes, and the cell around the
    // network (its outer edge no road), with the network's outside as a hole.
    let started = Instant::now();
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
        let (lo, hi) = p.positions().fold((DVec2::MAX, DVec2::MIN), |(lo, hi), q| {
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
    let off = grounds
        .iter()
        .filter(|g| {
            let [b, pav, gr, sw, lot] = g.areas;
            (b - (pav + gr + sw + lot)).abs() > 0.01
        })
        .count();
    let known = grounds
        .iter()
        .fold([0, 0], |k, g| [k[0] + g.known[0], k[1] + g.known[1]]);
    log.push(format!(
        "ground in {:.0?}: {} regions, {off} not adding up; ids known on {} of {} vertices",
        started.elapsed(),
        regions.len(),
        known[0],
        known[1]
    ));

    // 3. Markings, cut out of the pavement where they're not in a junction zone; then water, which road (asphalt,
    // markings, sidewalk: bridges keep their walks) wins against, taking what it covers of grass and lots.
    let started = Instant::now();
    let merge = |k: usize| -> Paths64 {
        grounds
            .iter()
            .flat_map(|g| g.parts[k].iter().cloned())
            .collect()
    };
    let pavement = union_subjects_64(&merge(0), nonzero);
    let (lo, hi) = clip::square_bounds(&square);
    let near = |p: DVec2| {
        p.x >= lo.x - 50.0 && p.x <= hi.x + 50.0 && p.y >= lo.y - 50.0 && p.y <= hi.y + 50.0
    };
    let half_width: Vec<f64> = (0..graph.edge_count())
        .map(|e| dart_widths[2 * e][0].max(dart_widths[2 * e + 1][0]))
        .collect();
    let (yellow, white) = if options.markings {
        let zones = markings::junction_zones(&graph, &ways, &metric, &half_width, near);
        let lines = markings::lines(&graph, &ways, &metric, near);
        let markable = difference_64(&pavement, &zones, nonzero);
        let yellow = intersect_64(
            &union_subjects_64(&lines.yellow, nonzero),
            &markable,
            nonzero,
        );
        let white = difference_64(
            &intersect_64(
                &union_subjects_64(&lines.white, nonzero),
                &markable,
                nonzero,
            ),
            &yellow,
            nonzero,
        );
        (yellow, white)
    } else {
        (Paths64::new(), Paths64::new())
    };
    let asphalt = difference_64(
        &pavement,
        &union_subjects_64(&[yellow.clone(), white.clone()].concat(), nonzero),
        nonzero,
    );
    let sidewalk = merge(2);
    let road = union_subjects_64(
        &[
            asphalt.clone(),
            yellow.clone(),
            white.clone(),
            sidewalk.clone(),
        ]
        .concat(),
        nonzero,
    );
    // Airports: road wins (service roads cross aprons), then runways over taxiways over aprons.
    let arc = options.simplify.max(ARC_TOLERANCE);
    let [runway, taxiway, apron] = aeroways.paths(face, &metric, arc);
    let mut taken = road.clone();
    let [runway, taxiway, apron] = [runway, taxiway, apron].map(|kind| {
        let mine = difference_64(&intersect_64(&kind, &square, nonzero), &taken, nonzero);
        taken = union_subjects_64(&[taken.clone(), mine.clone()].concat(), nonzero);
        mine
    });
    // Water takes what road and airports don't; grass and lots what's left.
    let water = difference_64(
        &intersect_64(&water.paths(face, &metric, arc), &square, nonzero),
        &taken,
        nonzero,
    );
    let covered = union_subjects_64(&[taken, water.clone()].concat(), nonzero);
    let grass = difference_64(&merge(1), &covered, nonzero);
    let lots = difference_64(&merge(3), &covered, nonzero);

    // 4. The check: every kind summing to the square with nothing uncovered, so nothing overlapping.
    let kinds = [
        &asphalt, &yellow, &white, &grass, &sidewalk, &lots, &water, &runway, &taxiway, &apron,
    ];
    let [sum, uncovered] = clip::tally(&square, &kinds);
    let square_m2 = clip::area(&square);
    let areas: Vec<String> = KINDS
        .iter()
        .zip(&kinds)
        .map(|(n, k)| format!("{n} {:.0}", clip::area(k)))
        .collect();
    log.push(format!(
        "kinds in {:.0?}: {} = {sum:.2} m²; square {square_m2:.2} m²; uncovered {uncovered:.3} m², overlapping at most {:.3} m²",
        started.elapsed(),
        areas.join(" + "),
        uncovered + (sum - square_m2).abs()
    ));

    // 5. Terrain heights on the lattice, the ground draped on its triangles, and the buffers.
    let started = Instant::now();
    let n = options.terrain;
    // The lattice with a one-point rim outside the cell (rows and columns −1 to n + 1), so the normals at the cell's
    // edge see the ground beyond it, as the neighbor's do.
    let rim: Vec<f64> = (-1..=n as i64 + 1)
        .flat_map(|b| (-1..=n as i64 + 1).map(move |a| (a, b)))
        .map(|(a, b)| {
            let st = [
                cell[0] + (cell[2] - cell[0]) * a as f64 / n as f64,
                cell[1] + (cell[3] - cell[1]) * b as f64 / n as f64,
            ];
            let (lat, lon) = s2::st_to_lat_lon(face, st);
            heights.height(lat, lon)
        })
        .collect();
    let lattice: Vec<f64> = (1..=n + 1)
        .flat_map(|b| (1..=n + 1).map(move |a| (a, b)))
        .map(|(a, b)| rim[b * (n + 3) + a])
        .collect();
    let terrain = terrain::Terrain::new(n, lattice, cell);
    let draped = terrain.cut(&kinds, &metric);
    let lost = (0..kinds.len())
        .map(|k| (clip::area(kinds[k]) - terrain.area(&draped, k as u8, &metric)).abs())
        .fold(0.0, f64::max);
    let mesh = mesh::build(&draped, &terrain, &rim, face, cell, &COVERS);
    let (flat, cell_m2) = mesh_check(&mesh, &terrain, face, cell);
    log.push(format!(
        "terrain and mesh in {:.0?}: {} heights ({} without data), {} pieces (area lost at most {lost:.3} m² a kind), \
         {} vertices, {} triangles ({} failed); top-down {flat:.2} m², the cell at the ground's height {cell_m2:.2} m²",
        started.elapsed(),
        terrain.heights.len(),
        heights.missing(),
        draped.kind.len(),
        mesh.positions.len(),
        mesh.indices.len() / 3,
        mesh.failed
    ));

    let center = s2::st_to_lat_lon(face, c.center());
    let (ground, triangles) = ground_arrow::encode(&mesh, &KINDS, &c.token, center)?;

    // 6. Coarse tiles: the buildings as massing.
    let buildings = match &owned {
        Some(b) => {
            let started = Instant::now();
            let simple = simplify::simplify_buildings(b, face, &metric, buildings::SIMPLIFY);
            let m = buildings::massing(&simple, face, &metric, buildings::GAP, buildings::OUTLINE);
            let prisms = buildings::extrude(&m, &terrain, &metric, face, cell, c.level);
            log.push(format!(
                "buildings in {:.0?}: {} buildings, {} massing rings, {} vertices, {} triangles ({} roofs failed)",
                started.elapsed(),
                b.osm_id.len(),
                m.paths.len(),
                prisms.positions.len(),
                prisms.indices.len() / 3,
                prisms.failed
            ));
            Some(ground_arrow::encode(
                &prisms,
                &["wall", "roof"],
                &c.token,
                center,
            )?)
        }
        None => None,
    };

    if let Some(dir) = pictures {
        std::fs::create_dir_all(dir)?;
        let polys: Vec<Vec<polygon::Polygon>> =
            kinds.iter().map(|k| clip::from_paths(k, &metric)).collect();
        let fills: Vec<(Vec<&polygon::Polygon>, [u8; 3])> = polys
            .iter()
            .zip(COLORS)
            .map(|(ps, c)| (ps.iter().collect(), c))
            .collect();
        let margin = 0.02 * (cell[2] - cell[0]);
        let frame = draw::View {
            view: [
                cell[0] - margin,
                cell[1] - margin,
                cell[2] + margin,
                cell[3] + margin,
            ],
            cell,
            size: 4096,
        };
        draw::draw_png(&fills, &frame, dir.join("cell.png").to_str().ok_or("path")?)?;
        let spacing = DVec2::new(
            metric.to_m.col(0).length() * (cell[2] - cell[0]),
            metric.to_m.col(1).length() * (cell[3] - cell[1]),
        ) / n as f64;
        draw::draw_heights(
            &terrain.heights,
            n,
            spacing.x,
            dir.join("heights.png").to_str().ok_or("path")?,
        )?;
        draw::draw_draped(
            &draped,
            &COLORS,
            |tri| terrain.light(tri, spacing),
            &frame,
            dir.join("draped.png").to_str().ok_or("path")?,
        )?;
        draw::draw_mesh(
            &mesh,
            &COLORS,
            4096,
            dir.join("mesh.png").to_str().ok_or("path")?,
        )?;
    }
    Ok(Built {
        ground,
        triangles,
        buildings,
        log,
    })
}

/// The triangles' top-down area, and the cell's own in the same ENU frame: its boundary traced through the exact
/// (s, t) → ground map, 1,024 points a side (the map bends edges a little over a kilometre), at the terrain's mean
/// height (a square 1.6 km up is 0.05% bigger than on the ellipsoid; the cell's relief leaves a few m² either way).
fn mesh_check(
    mesh: &mesh::Mesh,
    terrain: &terrain::Terrain,
    face: u32,
    cell: [f64; 4],
) -> (f64, f64) {
    let flat: f64 = mesh
        .indices
        .chunks(3)
        .map(|t| {
            let p = |i: u32| {
                glam::Vec3::from_array(mesh.positions[i as usize])
                    .as_dvec3()
                    .with_z(0.0)
            };
            (p(t[1]) - p(t[0])).cross(p(t[2]) - p(t[0])).length() / 2.0
        })
        .sum();
    let mean_h = terrain.heights.iter().sum::<f64>() / terrain.heights.len() as f64;
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
    (flat, geom::signed_area(ring))
}
