//! The draped ground as GPU buffers: positions (f32, in the cell's ENU frame: x east, y north, z up, from its center
//! on the ellipsoid, as the TS cellFrame), normals (i8 × 127, and a zero to make four bytes, as the GPU takes them), a
//! material per vertex (the kind), and indices, one range per kind. Each piece is triangulated with earcut, holes and
//! all; every vertex of a piece lies in one flat terrain triangle, so its normal is that triangle's. Vertices alike in
//! all three (position, normal, material) are one vertex. Open ground (lots) takes its material from its triangle's land
//! cover (grass, forest, rock, snow), so a lot's pieces can be any of four materials.

use crate::geodesy::{self, Frame};
use crate::landcover::{self, Cover};
use crate::s2;
use crate::terrain::{Draped, Terrain};
use glam::{DVec2, DVec3};
use std::collections::HashMap;

#[derive(Default)]
pub struct Mesh {
    pub positions: Vec<[f32; 3]>,
    pub normals: Vec<[i8; 4]>,
    pub material: Vec<u8>,
    pub indices: Vec<u32>,
    pub child: Vec<u8>, // per vertex, if any: which of the tile's 64 fine cells it's in (buildings)
    pub ranges: Vec<[u32; 3]>, // per kind present: kind, first index, index count
    pub failed: usize,  // pieces earcut couldn't triangulate
}

/// The materials open ground becomes: the lot kind (grass) and the kinds for forest, rock and snow.
pub struct Covers {
    pub lot: u8,
    pub forest: u8,
    pub rock: u8,
    pub snow: u8,
}

/// The draped ground triangulated, in the ENU frame at the cell's center. `face` and `cell` place (s, t).
pub fn build(d: &Draped, terrain: &Terrain, face: u32, cell: [f64; 4], covers: &Covers) -> Mesh {
    let (clat, clon) =
        s2::st_to_lat_lon(face, [(cell[0] + cell[2]) / 2.0, (cell[1] + cell[3]) / 2.0]);
    let frame = Frame::at(clat, clon, 0.0);
    let local = |st: DVec2, h: f64| {
        let (lat, lon) = s2::st_to_lat_lon(face, st.to_array());
        frame.local(geodesy::ecef(lat, lon, h))
    };
    // The terrain lattice in the frame, for each triangle's normal.
    let (n, side) = (terrain.n, terrain.n + 1);
    let lattice: Vec<DVec3> = (0..side * side)
        .map(|k| {
            let (a, b) = (k % side, k / side);
            let st = DVec2::new(
                cell[0] + (cell[2] - cell[0]) * a as f64 / n as f64,
                cell[1] + (cell[3] - cell[1]) * b as f64 / n as f64,
            );
            local(st, terrain.heights[k])
        })
        .collect();
    // A triangle's corners (lattice indices): below the diagonal (a, b, d), above it (a, d, c).
    let corners = |tri: u32| {
        let (square, upper) = ((tri / 2) as usize, tri % 2 == 1);
        let (i, j) = (square % n, square / n);
        let at = |a: usize, b: usize| b * side + a;
        let (a, b, c, dd) = (at(i, j), at(i + 1, j), at(i, j + 1), at(i + 1, j + 1));
        if upper { [a, dd, c] } else { [a, b, dd] }
    };
    let unit_normal = |tri: u32| {
        let [a, b, c] = corners(tri).map(|k| lattice[k]);
        (b - a).cross(c - a).normalize()
    };
    let normal = |tri: u32| {
        let nm = unit_normal(tri) * 127.0;
        [nm.x, nm.y, nm.z].map(|c| c.round() as i8)
    };
    // What a piece of `kind` in triangle `tri` is drawn as: open ground by its triangle's cover.
    let material = |kind: u8, tri: u32| {
        if kind != covers.lot {
            return kind;
        }
        let h = corners(tri)
            .iter()
            .map(|&k| terrain.heights[k])
            .sum::<f64>()
            / 3.0;
        match landcover::cover(h, unit_normal(tri).z) {
            Cover::Grass => covers.lot,
            Cover::Forest => covers.forest,
            Cover::Rock => covers.rock,
            Cover::Snow => covers.snow,
        }
    };

    let mut mesh = Mesh::default();
    // Triangles by material, so each material is one range.
    let mut buckets: Vec<Vec<u32>> = Vec::new();
    let mut welded: HashMap<([u32; 3], [i8; 3], u8), u32> = HashMap::new();
    let ring = |p: usize| d.start[p] as usize..d.start[p + 1] as usize;
    let mut p = 0;
    while p < d.kind.len() {
        // A group: the pieces of one kind in one triangle; each outer ring with its holes (Draped's outer column).
        let (kind, tri) = (d.kind[p], d.tri[p]);
        let group: Vec<usize> = (p..d.kind.len())
            .take_while(|&q| d.kind[q] == kind && d.tri[q] == tri)
            .collect();
        p += group.len();
        let nm = normal(tri);
        let mat = material(kind, tri);
        if buckets.len() <= mat as usize {
            buckets.resize(mat as usize + 1, Vec::new());
        }
        for &o in group.iter().filter(|&&q| d.outer[q] as usize == q) {
            let mine: Vec<usize> = group
                .iter()
                .copied()
                .filter(|&h| h != o && d.outer[h] as usize == o)
                .collect();
            // Earcut in local metres-ish coordinates (from the ring's first point), for conditioning.
            let base = d.st[ring(o).start];
            let mut flat: Vec<f64> = Vec::new();
            let mut hole_starts = Vec::new();
            let mut verts: Vec<usize> = Vec::new();
            for (k, &r) in std::iter::once(&o).chain(&mine).enumerate() {
                if k > 0 {
                    hole_starts.push(verts.len());
                }
                for v in ring(r) {
                    let q = (d.st[v] - base) * 1e6;
                    flat.extend([q.x, q.y]);
                    verts.push(v);
                }
            }
            let Ok(tris) = earcutr::earcut(&flat, &hole_starts, 2) else {
                mesh.failed += 1;
                continue;
            };
            let ids: Vec<u32> = verts
                .iter()
                .map(|&v| {
                    let at = local(d.st[v], d.h[v]).as_vec3().to_array();
                    *welded
                        .entry((at.map(f32::to_bits), nm, mat))
                        .or_insert_with(|| {
                            mesh.positions.push(at);
                            mesh.normals.push([nm[0], nm[1], nm[2], 0]);
                            mesh.material.push(mat);
                            (mesh.positions.len() - 1) as u32
                        })
                })
                .collect();
            // Every triangle counterclockwise seen from above (the viewer culls back faces): (s, t) on an S2 face is
            // right-handed from outside the globe, so counterclockwise there is counterclockwise on the ground.
            for t in tris.chunks(3) {
                let at = |k: usize| DVec2::new(flat[2 * t[k]], flat[2 * t[k] + 1]);
                let ccw = (at(1) - at(0)).perp_dot(at(2) - at(0)) >= 0.0;
                let [a, b, c] = if ccw {
                    [t[0], t[1], t[2]]
                } else {
                    [t[0], t[2], t[1]]
                };
                let [a, b, c] = [a, b, c].map(|k| ids[k]);
                // Two corners at one point (earcut keeps a ring's repeated points): no triangle.
                if a != b && b != c && a != c {
                    buckets[mat as usize].extend([a, b, c]);
                }
            }
        }
    }
    for (mat, indices) in buckets.into_iter().enumerate() {
        if !indices.is_empty() {
            mesh.ranges
                .push([mat as u32, mesh.indices.len() as u32, indices.len() as u32]);
            mesh.indices.extend(indices);
        }
    }
    mesh
}
