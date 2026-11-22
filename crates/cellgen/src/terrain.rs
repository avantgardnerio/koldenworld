//! Draping: the cell's ground cut by the terrain grid, so every piece lies in one terrain triangle and every vertex
//! takes its height from that triangle's plane. Ground and terrain are then one surface.
//!
//! The terrain is an (n + 1)² lattice evenly spaced in the cell's (s, t), each square split along the diagonal from
//! (i, j) to (i + 1, j + 1) into triangles a-b-d (lower right) and a-d-c (upper left), as the TS terrain mesh
//! (terrain.ts terrainMesh). Cutting happens in grid coordinates (lattice spacing 1, on Clipper's integer grid), where
//! squares are rectangles; the diagonal becomes one too after a shear, (x, y) → (x − y, y).

use crate::clip::UNITS;
use crate::geom::{self, Metric};
use clipper2_rust::{Path64, Paths64, Point64, Rect64, rect_clip_64};
use glam::DVec2;

/// Clipper units per lattice spacing in grid coordinates (a spacing is about 17 m: a unit is 17 µm).
const G: f64 = 1_000_000.0;

pub struct Terrain {
    pub n: usize,
    pub heights: Vec<f64>, // (n + 1)², rows from t = t0 (t outer, s inner), m above the ellipsoid
    origin: DVec2,         // (s0, t0)
    size: DVec2,           // (s1 − s0, t1 − t0)
}

/// Ground pieces cut to terrain triangles, as columns: piece p is points start[p]..start[p + 1], of kind kind[p] in
/// triangle tri[p] ((j·n + i)·2, + 1 for the upper-left one). A hole is a piece wound clockwise, in the same triangle.
#[derive(Default)]
pub struct Draped {
    pub kind: Vec<u8>,
    pub tri: Vec<u32>,
    pub start: Vec<u32>,
    pub st: Vec<DVec2>,
    pub h: Vec<f64>,
}

impl Terrain {
    pub fn new(n: usize, heights: Vec<f64>, cell: [f64; 4]) -> Terrain {
        Terrain {
            n,
            heights,
            origin: DVec2::new(cell[0], cell[1]),
            size: DVec2::new(cell[2] - cell[0], cell[3] - cell[1]),
        }
    }

    /// Every kind's ground (Clipper paths in metres around the cell) cut to the terrain triangles and draped.
    pub fn cut(&self, kinds: &[&Paths64], metric: &Metric) -> Draped {
        let n = self.n as i64;
        let g = G as i64;
        let mut out = Draped {
            start: vec![0],
            ..Default::default()
        };
        for (k, paths) in kinds.iter().enumerate() {
            let grid: Paths64 = paths
                .iter()
                .map(|p| p.iter().map(|q| self.to_grid(q, metric)).collect())
                .collect();
            for j in 0..n {
                let row = rect_clip_64(
                    &Rect64::new(0, j * g, n * g, (j + 1) * g),
                    &overlapping(&grid, None, Some(j)),
                );
                for i in 0..n {
                    let square = rect_clip_64(
                        &Rect64::new(i * g, j * g, (i + 1) * g, (j + 1) * g),
                        &overlapping(&row, Some(i), None),
                    );
                    if square.is_empty() {
                        continue;
                    }
                    // The diagonal x − y = (i − j)·G: sheared, a vertical line; lower-right triangle on its right.
                    let sheared: Paths64 = square
                        .iter()
                        .map(|p| {
                            p.iter()
                                .map(|q| Point64::new_z(q.x - q.y, q.y, q.z))
                                .collect()
                        })
                        .collect();
                    let d = (i - j) * g;
                    for (upper, rect) in [
                        (0, Rect64::new(d, j * g, d + g, (j + 1) * g)),
                        (1, Rect64::new(d - g, j * g, d, (j + 1) * g)),
                    ] {
                        for p in rect_clip_64(&rect, &sheared) {
                            let piece: Path64 = p
                                .iter()
                                .map(|q| Point64::new_z(q.x + q.y, q.y, q.z))
                                .collect();
                            self.push(&mut out, k as u8, ((j * n + i) * 2 + upper) as u32, &piece);
                        }
                    }
                }
            }
        }
        out
    }

    /// How lit a terrain triangle is, 0..1 (light from the cell's upper left): for shading pictures. `spacing` is the
    /// lattice spacing in metres along s and t.
    pub fn light(&self, tri: u32, spacing: DVec2) -> f64 {
        let (square, upper) = ((tri / 2) as usize, tri % 2 == 1);
        let (i, j, side) = (square % self.n, square / self.n, self.n + 1);
        let h = |a: usize, b: usize| self.heights[b * side + a];
        let (ha, hb, hc, hd) = (h(i, j), h(i + 1, j), h(i, j + 1), h(i + 1, j + 1));
        let slope = if upper {
            DVec2::new((hd - hc) / spacing.x, (hc - ha) / spacing.y)
        } else {
            DVec2::new((hb - ha) / spacing.x, (hd - hb) / spacing.y)
        };
        (0.75 + 6.0 * slope.dot(DVec2::new(-1.0, 1.0).normalize())).clamp(0.0, 1.0)
    }

    /// Area of a draped kind, m² (to check the cut kept it).
    pub fn area(&self, d: &Draped, kind: u8, metric: &Metric) -> f64 {
        (0..d.kind.len())
            .filter(|&p| d.kind[p] == kind)
            .map(|p| {
                geom::signed_area(
                    d.st[d.start[p] as usize..d.start[p + 1] as usize]
                        .iter()
                        .copied(),
                )
            })
            .sum::<f64>()
            * metric.area_scale()
    }

    fn to_grid(&self, q: &Point64, metric: &Metric) -> Point64 {
        let st = metric.st(DVec2::new(q.x as f64, q.y as f64) / UNITS);
        let g = (st - self.origin) / self.size * self.n as f64 * G;
        Point64::new_z(g.x.round() as i64, g.y.round() as i64, q.z)
    }

    fn push(&self, out: &mut Draped, kind: u8, tri: u32, piece: &Path64) {
        if piece.len() < 3 {
            return;
        }
        let (square, upper) = ((tri / 2) as usize, tri % 2 == 1);
        let (i, j) = (square % self.n, square / self.n);
        let side = self.n + 1;
        let h = |a: usize, b: usize| self.heights[b * side + a];
        let (ha, hb, hc, hd) = (h(i, j), h(i + 1, j), h(i, j + 1), h(i + 1, j + 1));
        for q in piece {
            let (fx, fy) = (q.x as f64 / G - i as f64, q.y as f64 / G - j as f64);
            // The triangle's plane: a-b-d below the diagonal, a-d-c above it.
            let height = if upper {
                ha + fy * (hc - ha) + fx * (hd - hc)
            } else {
                ha + fx * (hb - ha) + fy * (hd - hb)
            };
            out.st.push(
                self.origin + DVec2::new(q.x as f64, q.y as f64) / G / self.n as f64 * self.size,
            );
            out.h.push(height);
        }
        out.kind.push(kind);
        out.tri.push(tri);
        out.start.push(out.st.len() as u32);
    }
}

/// The paths whose bounding box overlaps grid column i and/or row j (None: any).
fn overlapping(paths: &Paths64, i: Option<i64>, j: Option<i64>) -> Paths64 {
    let g = G as i64;
    paths
        .iter()
        .filter(|p| {
            let (x0, x1) = (
                p.iter().map(|q| q.x).min().unwrap_or(0),
                p.iter().map(|q| q.x).max().unwrap_or(0),
            );
            let (y0, y1) = (
                p.iter().map(|q| q.y).min().unwrap_or(0),
                p.iter().map(|q| q.y).max().unwrap_or(0),
            );
            i.is_none_or(|i| x1 > i * g && x0 < (i + 1) * g)
                && j.is_none_or(|j| y1 > j * g && y0 < (j + 1) * g)
        })
        .cloned()
        .collect()
}
