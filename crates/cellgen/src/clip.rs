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
pub const UNITS: f64 = 1_000_000.0;
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
    pub areas: [f64; 5], // m²: the region (in the cell), then pavement, grass, sidewalk, lot
    pub known: [usize; 2], // output vertices whose id survived, of all
    pub parts: [Paths64; 4], // pavement, grass, sidewalk, lot as Clipper made them (micrometres)
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

/// The square's bounding box, metres around the cell.
pub fn square_bounds(square: &Paths64) -> (DVec2, DVec2) {
    square
        .iter()
        .flatten()
        .fold((DVec2::MAX, DVec2::MIN), |(lo, hi), p| {
            let v = DVec2::new(p.x as f64, p.y as f64) / UNITS;
            (lo.min(v), hi.max(v))
        })
}

/// The region split into its four kinds of ground, inside the cell's square. `widths[dart]` is that side's kerb,
/// grass and sidewalk widths (widths::dart_widths): every layer is the region less a strip along each dart's side of
/// the road, that dart's own distance out, so each side keeps its own widths and corners meet as their strips do.
pub fn ground(region: &Region, square: &Paths64, metric: &Metric, widths: &[[f64; 3]]) -> Ground {
    let path = |p: &Polygon| path_of(p, metric);
    let outer_raw = match region.outer {
        Outer::Road(p) => Some(path(p)),
        Outer::Cell => None,
    };
    let hole_rings: Vec<Path64> = region.holes.iter().map(|h| path(h)).collect();

    // The region: a road outer ring as Clipper sees it, nonzero (a ring crossing itself, a road over another with no
    // shared node, counts the overlap once; dead-end spikes have no area), less the holes' footprints (each ring
    // turned counterclockwise: the road piece's outline; a flat one, out and back, has none), in the cell.
    let outer_region = match &outer_raw {
        Some(raw) => union_subjects_64(&vec![raw.clone()], NONZERO),
        None => square.clone(),
    };
    let footprints: Paths64 = hole_rings
        .iter()
        .map(|ring| ring.iter().rev().cloned().collect())
        .collect();
    let b = intersect_64(
        &difference_64(
            &outer_region,
            &union_subjects_64(&footprints, NONZERO),
            NONZERO,
        ),
        square,
        NONZERO,
    );

    // Each road side in the region's rings: a run of one dart's vertices, through the next run's first (its end).
    let runs: Vec<(u32, Path64)> = outer_raw
        .iter()
        .chain(&hole_rings)
        .flat_map(dart_runs)
        .collect();
    // Ground clear of every road side by its own distance out to layer `level` (0 kerb, 1 grass, 2 sidewalk): the
    // region less each run buffered that far (square ends), runs of one distance in one offset.
    let clear = |level: usize| {
        let mut by_distance: Vec<(f64, Paths64)> = Vec::new();
        for (dart, run) in &runs {
            let d: f64 = widths[*dart as usize][..=level].iter().sum();
            match by_distance.iter_mut().find(|(e, _)| *e == d) {
                Some((_, paths)) => paths.push(run.clone()),
                None => by_distance.push((d, vec![run.clone()])),
            }
        }
        let strips: Paths64 = by_distance
            .iter()
            .filter(|(d, _)| *d > 0.0)
            .flat_map(|(d, paths)| {
                inflate_paths_64(
                    paths,
                    d * UNITS,
                    JoinType::Miter,
                    EndType::Square,
                    MITER,
                    0.0,
                )
            })
            .collect();
        difference_64(&b, &union_subjects_64(&strips, NONZERO), NONZERO)
    };
    let k = clear(0);
    let g = intersect_64(&clear(1), &k, NONZERO);
    let s = intersect_64(&clear(2), &g, NONZERO);
    let parts = [
        difference_64(&b, &k, NONZERO),
        difference_64(&k, &g, NONZERO),
        difference_64(&g, &s, NONZERO),
        s,
    ];

    let m2 = |p: &Paths64| area_paths(p) / (UNITS * UNITS);
    let areas = [
        m2(&b),
        m2(&parts[0]),
        m2(&parts[1]),
        m2(&parts[2]),
        m2(&parts[3]),
    ];
    let points = parts.iter().flatten().flatten();
    let known = [points.clone().filter(|p| p.z != 0).count(), points.count()];
    Ground {
        areas,
        known,
        parts,
    }
}

/// Area of Clipper paths, m².
pub fn area(paths: &Paths64) -> f64 {
    area_paths(paths) / (UNITS * UNITS)
}

/// Sum, union and what's left uncovered of the square, m², over sets of Clipper paths that should partition it: the
/// sum equals the union only if no two pieces overlap, and the union equals the square only if nothing is missing.
pub fn tally(square: &Paths64, sets: &[&Paths64]) -> [f64; 3] {
    let all: Paths64 = sets.iter().flat_map(|s| s.iter().cloned()).collect();
    let sum: f64 = sets.iter().map(|s| area(s)).sum();
    let union = union_subjects_64(&all, NONZERO);
    [
        sum,
        area(&union),
        area(&difference_64(square, &union, NONZERO)),
    ]
}

/// A ring cut into road sides: each maximal run of vertices on one dart's side, with the next run's first vertex as its
/// end. Vertices with no id (none in a face's ring) take the dart of the run they're in.
fn dart_runs(ring: &Path64) -> Vec<(u32, Path64)> {
    let n = ring.len();
    let dart = |i: usize| (ring[i % n].z - 1).max(0) as u32 / 2;
    // Start where a run starts, so none wraps round the ring's first vertex; one dart all round is one closed run.
    let Some(start) = (0..n).find(|&i| dart(i) != dart(i + n - 1)) else {
        let mut all = ring.clone();
        all.extend(ring.first().cloned());
        return vec![(dart(0), all)];
    };
    let mut runs = Vec::new();
    let mut i = start;
    while i < start + n {
        let d = dart(i);
        let mut run: Path64 = vec![ring[i % n]];
        i += 1;
        while i < start + n && dart(i) == d {
            run.push(ring[i % n]);
            i += 1;
        }
        run.push(ring[i % n]);
        runs.push((d, run));
    }
    runs
}

fn path_of(poly: &Polygon, metric: &Metric) -> Path64 {
    poly.vertices()
        .map(|(st, id)| point(metric.metres(st), id))
        .collect()
}

/// A point in metres around the cell, on Clipper's grid, carrying an id (MADE: none).
pub fn point(metres: DVec2, id: u32) -> Point64 {
    let m = metres * UNITS;
    let z = if id == MADE { 0 } else { id as i64 + 1 };
    Point64::new_z(m.x.round() as i64, m.y.round() as i64, z)
}

/// Clipper paths back as polygons in (s, t), ids from z.
pub fn from_paths(paths: &Paths64, metric: &Metric) -> Vec<Polygon> {
    paths
        .iter()
        .map(|path| {
            Polygon::from_points(path.iter().map(|p| {
                let st = metric.st(DVec2::new(p.x as f64, p.y as f64) / UNITS);
                (st, if p.z == 0 { MADE } else { (p.z - 1) as u32 })
            }))
        })
        .collect()
}
