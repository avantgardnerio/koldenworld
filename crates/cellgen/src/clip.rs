//! One block's ground, by Clipper2: offsets and booleans in place of our shrink and pieces. Nested layers, each the
//! one before offset inward and clipped to it (K ⊆ B, G ⊆ K, S ⊆ G), and the categories their differences, so they
//! partition the block by construction: pavement B − K, grass K − G, sidewalk G − S, lot S.
//!
//! Clipper works in integers: metres around the cell, as millimetres. Each vertex carries its id (dart side or
//! corner, + 1 so 0 means unknown) in z, which offsets keep from the vertex they came from.

use crate::geom::Metric;
use crate::polygon::{MADE, Polygon};
use clipper2_rust::{
    EndType, FillRule, JoinType, Path64, Paths64, Point64, area_paths, difference_64,
    inflate_paths_64, intersect_64,
};
use glam::DVec2;

const MM: f64 = 1000.0;
/// A corner in a very sharp angle stops at this many offsets out.
const MITER: f64 = 4.0;

pub struct BlockGround {
    pub pavement: Vec<Polygon>,
    pub grass: Vec<Polygon>,
    pub sidewalk: Vec<Polygon>,
    pub lot: Vec<Polygon>,
    pub areas: [f64; 5],   // m²: the block, then pavement, grass, sidewalk, lot
    pub known: [usize; 2], // output vertices whose id survived, of all
}

/// The block split into its four kinds of ground: a kerb `kerb` metres in, then grass and sidewalk bands.
pub fn block_ground(
    block: &Polygon,
    metric: &Metric,
    kerb: f64,
    grass: f64,
    sidewalk: f64,
) -> BlockGround {
    let b = to_paths(block, metric);
    let shrink = |p: &Paths64, d: f64| {
        let inner = inflate_paths_64(p, -d * MM, JoinType::Miter, EndType::Polygon, MITER, 0.0);
        intersect_64(&inner, p, FillRule::NonZero)
    };
    let k = shrink(&b, kerb);
    let g = shrink(&k, grass);
    let s = shrink(&g, sidewalk);
    let parts = [
        difference_64(&b, &k, FillRule::NonZero),
        difference_64(&k, &g, FillRule::NonZero),
        difference_64(&g, &s, FillRule::NonZero),
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
    let [pavement, grass, sidewalk, lot] = parts.map(|p| from_paths(&p, metric));
    BlockGround {
        pavement,
        grass,
        sidewalk,
        lot,
        areas,
        known,
    }
}

fn to_paths(poly: &Polygon, metric: &Metric) -> Paths64 {
    let path: Path64 = poly
        .vertices()
        .map(|(st, id)| {
            let m = metric.metres(st) * MM;
            let z = if id == MADE { 0 } else { id as i64 + 1 };
            Point64::new_z(m.x.round() as i64, m.y.round() as i64, z)
        })
        .collect();
    vec![path]
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
