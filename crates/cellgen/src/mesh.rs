//! The draped ground as GPU buffers: positions and normals (f32, in the cell's ENU frame: x east, y north, z up, from
//! its center on the ellipsoid, as the TS cellFrame), a material per vertex (the kind), and u32 indices, one range per
//! kind. Each piece is triangulated with earcut, holes and all; every vertex of a piece lies in one flat terrain
//! triangle, so its normal is that triangle's.

use crate::geodesy::{self, Frame};
use crate::s2;
use crate::terrain::{Draped, Terrain};
use glam::{DVec2, DVec3};

#[derive(Default)]
pub struct Mesh {
    pub positions: Vec<[f32; 3]>,
    pub normals: Vec<[f32; 3]>,
    pub material: Vec<u8>,
    pub indices: Vec<u32>,
    pub ranges: Vec<[u32; 3]>, // per kind present: kind, first index, index count
    pub failed: usize,         // pieces earcut couldn't triangulate
}

/// The draped ground triangulated, in the ENU frame at the cell's center. `face` and `cell` place (s, t).
pub fn build(d: &Draped, terrain: &Terrain, face: u32, cell: [f64; 4]) -> Mesh {
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
    let normal = |tri: u32| {
        let (square, upper) = ((tri / 2) as usize, tri % 2 == 1);
        let (i, j) = (square % n, square / n);
        let at = |a: usize, b: usize| lattice[b * side + a];
        let (pa, pb, pc, pd) = (at(i, j), at(i + 1, j), at(i, j + 1), at(i + 1, j + 1));
        let nm = if upper {
            (pd - pa).cross(pc - pa)
        } else {
            (pb - pa).cross(pd - pa)
        };
        nm.normalize().as_vec3().to_array()
    };

    let mut mesh = Mesh::default();
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
            let first = mesh.positions.len() as u32;
            for &v in &verts {
                mesh.positions
                    .push(local(d.st[v], d.h[v]).as_vec3().to_array());
                mesh.normals.push(nm);
                mesh.material.push(kind);
            }
            mesh.indices.extend(tris.iter().map(|&t| first + t as u32));
        }
        // Index ranges by kind: pieces come grouped by kind, so each kind is one run.
        match mesh.ranges.last_mut() {
            Some(r) if r[0] == kind as u32 => r[2] = mesh.indices.len() as u32 - r[1],
            _ => {
                let start = mesh.ranges.last().map_or(0, |r| r[1] + r[2]);
                mesh.ranges
                    .push([kind as u32, start, mesh.indices.len() as u32 - start]);
            }
        }
    }
    mesh
}
