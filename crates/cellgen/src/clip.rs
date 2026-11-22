//! A region's ground, by Clipper2: offsets and booleans. Nested layers, each a further distance from the roads and
//! clipped to the one before (K ⊆ B, G ⊆ K, S ⊆ G), and the categories their differences, so they partition the region
//! by construction: pavement B − K, grass K − G, sidewalk G − S, lot S. Everything is clipped to the cell's square.
//!
//! A region is a block (its outer ring a road) or the cell itself (around the network: its outer edge no road), with
//! holes: the outside faces of the road pieces inside it (a parking loop, a lone driveway). Distances are measured in
//! from a road outer ring and out from every hole, so the lot keeps clear of both.
//!
//! Clipper works in integers: metres around the cell, as micrometres. Each vertex carries its id (dart side or
//! corner, + 1 so 0 means unknown) in z, which offsets keep from the vertex they came from.

use crate::geom::Metric;
use crate::polygon::{MADE, Polygon};
use clipper2_rust::{
    EndType, FillRule, JoinType, Path64, Paths64, Point64, area_paths, difference_64,
    inflate_paths_64, intersect_64, union_subjects_64,
};
use glam::DVec2;

/// Clipper's integer grid: micrometres. Clipping rounds new vertices to it, so the finer the grid the thinner the
/// slivers that rounding leaves along a cut (millimetres left about 0.5 m² along a cell's 4 km of edge).
const MM: f64 = 1_000_000.0;
/// A corner in a very sharp angle stops at this many offsets out.
const MITER: f64 = 4.0;
const NONZERO: FillRule = FillRule::NonZero;

/// A piece of ground to split: inside `outer`, outside every hole.
pub struct Region<'a> {
    pub outer: Outer<'a>,
    pub holes: Vec<&'a Polygon>, // outside faces of road pieces inside it, as traced (clockwise, or flat)
}

pub enum Outer<'a> {
    Road(&'a Polygon), // a block: its ring is road
    Cell,              // the cell's square: no road
}

#[derive(Default)]
pub struct Ground {
    pub pavement: Vec<Polygon>,
    pub grass: Vec<Polygon>,
    pub sidewalk: Vec<Polygon>,
    pub lot: Vec<Polygon>,
    pub areas: [f64; 5], // m²: the region (in the cell), then pavement, grass, sidewalk, lot
    pub known: [usize; 2], // output vertices whose id survived, of all
    pub native: Paths64, // every part as Clipper made it (micrometres), for checking without a round trip
}

/// The cell's square as a Clipper path (metres around the cell, as micrometres; no ids).
pub fn square(cell: [f64; 4], metric: &Metric) -> Paths64 {
    let [s0, t0, s1, t1] = cell;
    let corners = [[s0, t0], [s1, t0], [s1, t1], [s0, t1]];
    vec![
        corners
            .iter()
            .map(|&c| point(metric.metres(DVec2::from_array(c)), MADE))
            .collect(),
    ]
}

/// The region split into its four kinds of ground, inside the cell's square: a kerb `widths[0]` metres from the
/// roads, then grass `widths[1]` and sidewalk `widths[2]` bands.
pub fn ground(region: &Region, square: &Paths64, metric: &Metric, widths: [f64; 3]) -> Ground {
    let path = |p: &Polygon| path_of(p, metric);
    let outer_raw = match region.outer {
        Outer::Road(p) => Some(path(p)),
        Outer::Cell => None,
    };
    // Each hole's footprint: its ring turned counterclockwise (a road piece's outline), or, for a piece with no loop
    // at all (flat: its ring walks out and back), the line itself.
    let holes: Vec<(Path64, bool)> = region
        .holes
        .iter()
        .map(|h| {
            let mut ring = path(h);
            ring.reverse();
            (ring, h.signed_area() == 0.0)
        })
        .collect();

    // The region: a road outer ring as Clipper sees it, nonzero (a ring crossing itself, a road over another with no
    // shared node, counts the overlap once; dead-end spikes have no area), less the holes' footprints, in the cell.
    let outer_region = match &outer_raw {
        Some(raw) => union_subjects_64(&vec![raw.clone()], NONZERO),
        None => square.clone(),
    };
    let footprints: Paths64 = holes.iter().filter(|h| !h.1).map(|h| h.0.clone()).collect();
    let b = intersect_64(
        &difference_64(
            &outer_region,
            &union_subjects_64(&footprints, NONZERO),
            NONZERO,
        ),
        square,
        NONZERO,
    );

    // Ground at least `d` from every road: the outer ring offset in (from the raw ring, so dead-end spikes carve their
    // slots), less every hole grown by d.
    let clear = |d: f64| {
        let inside = match &outer_raw {
            Some(raw) => inflate_paths_64(
                &vec![raw.clone()],
                -d * MM,
                JoinType::Miter,
                EndType::Polygon,
                MITER,
                0.0,
            ),
            None => square.clone(),
        };
        let grown: Paths64 = holes
            .iter()
            .flat_map(|(ring, flat)| {
                let end = if *flat {
                    EndType::Joined
                } else {
                    EndType::Polygon
                };
                inflate_paths_64(
                    &vec![ring.clone()],
                    d * MM,
                    JoinType::Miter,
                    end,
                    MITER,
                    0.0,
                )
            })
            .collect();
        difference_64(&inside, &union_subjects_64(&grown, NONZERO), NONZERO)
    };
    let [kerb, grass, sidewalk] = widths;
    let k = intersect_64(&clear(kerb), &b, NONZERO);
    let g = intersect_64(&clear(kerb + grass), &k, NONZERO);
    let s = intersect_64(&clear(kerb + grass + sidewalk), &g, NONZERO);
    let parts = [
        difference_64(&b, &k, NONZERO),
        difference_64(&k, &g, NONZERO),
        difference_64(&g, &s, NONZERO),
        s,
    ];

    let m2 = |p: &Paths64| area_paths(p) / (MM * MM);
    let areas = [
        m2(&b),
        m2(&parts[0]),
        m2(&parts[1]),
        m2(&parts[2]),
        m2(&parts[3]),
    ];
    let points = parts.iter().flatten().flatten();
    let known = [points.clone().filter(|p| p.z != 0).count(), points.count()];
    let native: Paths64 = parts.iter().flatten().cloned().collect();
    let [pavement, grass, sidewalk, lot] = parts.map(|p| from_paths(&p, metric));
    Ground {
        pavement,
        grass,
        sidewalk,
        lot,
        areas,
        known,
        native,
    }
}

/// Area of Clipper paths, m².
pub fn area(paths: &Paths64) -> f64 {
    area_paths(paths) / (MM * MM)
}

/// Area of the union of all the grounds' parts, m²: equal to the sum of their areas only if none overlap.
pub fn union_area(grounds: &[Ground]) -> f64 {
    let all: Paths64 = grounds
        .iter()
        .flat_map(|g| g.native.iter().cloned())
        .collect();
    area(&union_subjects_64(&all, NONZERO))
}

/// What of the square no ground covers: each leftover's area (m²) and a point on it (metres).
pub fn uncovered(square: &Paths64, grounds: &[Ground]) -> Vec<(f64, DVec2)> {
    let all: Paths64 = grounds
        .iter()
        .flat_map(|g| g.native.iter().cloned())
        .collect();
    let left = difference_64(square, &union_subjects_64(&all, NONZERO), NONZERO);
    left.iter()
        .map(|p| {
            (
                area(&vec![p.clone()]),
                DVec2::new(p[0].x as f64, p[0].y as f64) / MM,
            )
        })
        .collect()
}

fn path_of(poly: &Polygon, metric: &Metric) -> Path64 {
    poly.vertices()
        .map(|(st, id)| point(metric.metres(st), id))
        .collect()
}

fn point(metres: DVec2, id: u32) -> Point64 {
    let m = metres * MM;
    let z = if id == MADE { 0 } else { id as i64 + 1 };
    Point64::new_z(m.x.round() as i64, m.y.round() as i64, z)
}

fn from_paths(paths: &Paths64, metric: &Metric) -> Vec<Polygon> {
    paths
        .iter()
        .map(|path| {
            Polygon::from_points(path.iter().map(|p| {
                let st = metric.st(DVec2::new(p.x as f64, p.y as f64) / MM);
                (st, if p.z == 0 { MADE } else { (p.z - 1) as u32 })
            }))
        })
        .collect()
}
