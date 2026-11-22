//! Buildings for the coarse tier, as massing: from far away a city is blocks and towers, not 100,000 houses. The
//! footprints of buildings under TOWER metres are merged where they're within GAP of each other (grown by half the
//! gap, unioned, shrunk back: a closing), each merged shape at the area-weighted mean height of the buildings in it;
//! towers stay their own shapes at their own heights (and keep their ids, so one can change on its own).
//!
//! Loaded from Postgres (buildings: outlines, not building:parts); a tile has the buildings it owns, by the same point
//! as the TS (the area centroid of the first outer ring), so each building is in exactly one tile, the parent of its
//! fine cell. Extruded as prisms (walls from just below the lowest ground under the outline, a flat roof at the mean
//! ground height plus the height) in the tile's frame, each vertex knowing which of the tile's 64 fine cells its shape
//! is in, so a viewer can hide the shapes where it has the fine cells' own buildings.

use crate::clip::{UNITS, point};
use crate::geodesy::{self, Frame};
use crate::geom::Metric;
use crate::mesh::Mesh;
use crate::polygon::MADE;
use crate::s2;
use crate::simplify;
use crate::terrain::Terrain;
use crate::ways::wkb_line_string;
use clipper2_rust::{
    EndType, FillRule, JoinType, Path64, Paths64, Point64, PointInPolygonResult, inflate_paths_64,
    point_in_polygon, union_subjects_64,
};
use glam::DVec2;
use postgres::Client;

/// Merged where closer than this, m.
pub const GAP: f64 = 10.0;
/// Footprints simplified to within this, m, before merging.
pub const SIMPLIFY: f64 = 1.0;
/// Merged outlines simplified to within this, m.
pub const OUTLINE: f64 = 3.0;
/// At least this tall, m: a tower, kept on its own.
pub const TOWER: f64 = 40.0;

/// Buildings as columns: per building an id and a height, and its polygons' rings (outer counterclockwise, holes
/// clockwise) as runs of points (CSR).
#[derive(Default)]
pub struct Buildings {
    pub osm_id: Vec<i64>,
    pub height: Vec<f64>,
    pub ring_start: Vec<u32>, // buildings' rings: per building, rings ring_of[b]..ring_of[b + 1]
    pub ring_of: Vec<u32>,    // buildings + 1 offsets into ring_start
    pub lonlat: Vec<[f64; 2]>,
}

impl Buildings {
    /// Only the buildings at these indices (in order).
    pub fn only(&self, which: &[usize]) -> Buildings {
        let mut out = Buildings {
            ring_start: vec![0],
            ring_of: vec![0],
            ..Default::default()
        };
        for &k in which {
            out.osm_id.push(self.osm_id[k]);
            out.height.push(self.height[k]);
            for r in self.ring_of[k] as usize..self.ring_of[k + 1] as usize {
                out.lonlat.extend_from_slice(
                    &self.lonlat[self.ring_start[r] as usize..self.ring_start[r + 1] as usize],
                );
                out.ring_start.push(out.lonlat.len() as u32);
            }
            out.ring_of.push((out.ring_start.len() - 1) as u32);
        }
        out
    }

    /// The buildings with only the points marked in `keep` (one per point); a ring left with under four points (a
    /// closed triangle) is dropped.
    pub fn keep_points(&self, keep: &[bool]) -> Buildings {
        let mut out = Buildings {
            osm_id: self.osm_id.clone(),
            height: self.height.clone(),
            ring_start: vec![0],
            ring_of: vec![0],
            lonlat: Vec::new(),
        };
        for k in 0..self.osm_id.len() {
            for r in self.ring_of[k] as usize..self.ring_of[k + 1] as usize {
                let ring: Vec<[f64; 2]> = (self.ring_start[r]..self.ring_start[r + 1])
                    .filter(|&i| keep[i as usize])
                    .map(|i| self.lonlat[i as usize])
                    .collect();
                if ring.len() >= 4 {
                    out.lonlat.extend(ring);
                    out.ring_start.push(out.lonlat.len() as u32);
                }
            }
            out.ring_of.push((out.ring_start.len() - 1) as u32);
        }
        out
    }
}

/// Merged buildings: shapes (outer rings counterclockwise and their holes clockwise, as Clipper paths in metres ×
/// UNITS) with a height per path (a hole has its outer's), and the towers, each with its building's id.
pub struct Massing {
    pub paths: Paths64,
    pub height: Vec<f64>,
    pub tower: Vec<Option<i64>>, // the building's OSM id, for a tower's paths
}

/// Every building whose footprint touches a lon/lat box and whose owner point `owns` (lon, lat).
pub fn load(
    db: &mut Client,
    [west, south, east, north]: [f64; 4],
    owns: impl Fn(f64, f64) -> bool,
) -> Result<Buildings, Box<dyn std::error::Error>> {
    let rows = db.query(
        "SELECT osm_id, height_m, (r).path[1], ST_AsBinary(ST_ExteriorRing((r).geom)) FROM (
           SELECT osm_id, height_m, ST_DumpRings((ST_Dump(ST_ForcePolygonCCW(geom))).geom) AS r FROM buildings
           WHERE NOT is_part AND geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
           ORDER BY osm_type, osm_id
         ) rings",
        &[&west, &south, &east, &north],
    )?;
    let mut b = Buildings {
        ring_start: vec![0],
        ring_of: vec![0],
        ..Default::default()
    };
    for row in &rows {
        let id: i64 = row.get(0);
        if b.osm_id.last() != Some(&id) {
            if !b.osm_id.is_empty() {
                b.ring_of.push((b.ring_start.len() - 1) as u32);
            }
            b.osm_id.push(id);
            b.height.push(row.get::<_, f32>(1) as f64);
        }
        wkb_line_string(row.get(3), &mut b.lonlat)?;
        b.ring_start.push(b.lonlat.len() as u32);
    }
    if !b.osm_id.is_empty() {
        b.ring_of.push((b.ring_start.len() - 1) as u32);
    }
    let owned: Vec<usize> = (0..b.osm_id.len())
        .filter(|&k| {
            let r = b.ring_of[k] as usize;
            let [lon, lat] =
                owner_point(&b.lonlat[b.ring_start[r] as usize..b.ring_start[r + 1] as usize]);
            owns(lon, lat)
        })
        .collect();
    Ok(b.only(&owned))
}

/// A building's owner point: the area centroid of its first outer ring (lon, lat), as cell.ts ownerPoint.
fn owner_point(ring: &[[f64; 2]]) -> [f64; 2] {
    let [x0, y0] = ring[0];
    let (mut a, mut cx, mut cy) = (0.0, 0.0, 0.0);
    for w in ring.windows(2) {
        let (ax, ay) = (w[0][0] - x0, w[0][1] - y0);
        let (bx, by) = (w[1][0] - x0, w[1][1] - y0);
        let c = ax * by - bx * ay;
        a += c;
        cx += (ax + bx) * c;
        cy += (ay + by) * c;
    }
    if a == 0.0 {
        return [x0, y0];
    }
    [x0 + cx / (3.0 * a), y0 + cy / (3.0 * a)]
}

/// The massing as prisms in the frame at the tile's center (as the ground mesh): walls (material 0) and roofs (1),
/// each vertex with its shape's fine cell (0..64 within the tile at `level`).
pub fn extrude(
    m: &Massing,
    terrain: &Terrain,
    metric: &Metric,
    face: u32,
    cell: [f64; 4],
    level: u32,
) -> Mesh {
    let (clat, clon) =
        s2::st_to_lat_lon(face, [(cell[0] + cell[2]) / 2.0, (cell[1] + cell[3]) / 2.0]);
    let frame = Frame::at(clat, clon, 0.0);
    let local = |st: DVec2, h: f64| {
        let (lat, lon) = s2::st_to_lat_lon(face, st.to_array());
        frame.local(geodesy::ecef(lat, lon, h))
    };
    let st_of = |p: Point64| metric.st(DVec2::new(p.x as f64, p.y as f64) / UNITS);
    let shift = 61 - 2 * (level + 3);
    let child_of = |path: &Path64| {
        let b = bbox(path);
        let mid = st_of(Point64::new((b[0] + b[2]) / 2, (b[1] + b[3]) / 2));
        ((s2::cell_id(face, mid.to_array(), level + 3) >> shift) & 63) as u8
    };
    let normal = |v: glam::DVec3| {
        let n = v.normalize_or_zero() * 127.0;
        [n.x.round() as i8, n.y.round() as i8, n.z.round() as i8, 0]
    };

    let (mut walls, mut roofs) = (Mesh::default(), Mesh::default());
    for (outer, holes) in shapes(&m.paths) {
        let o = &m.paths[outer];
        let ground: Vec<f64> = o.iter().map(|&p| terrain.height_at(st_of(p))).collect();
        let base = ground.iter().copied().fold(f64::MAX, f64::min) - 1.0;
        let roof = ground.iter().sum::<f64>() / ground.len() as f64 + m.height[outer];
        let child = child_of(o);
        let rings: Vec<&Path64> = std::iter::once(o)
            .chain(holes.iter().map(|&h| &m.paths[h]))
            .collect();

        // Walls: a quad per edge, facing out (outer rings counterclockwise, holes clockwise).
        for ring in &rings {
            for k in 0..ring.len() {
                let (p, q) = (st_of(ring[k]), st_of(ring[(k + 1) % ring.len()]));
                let corners = [
                    local(p, base),
                    local(q, base),
                    local(q, roof),
                    local(p, roof),
                ];
                let up = local(p, base + 1.0) - corners[0];
                let nm = normal((corners[1] - corners[0]).cross(up));
                let first = walls.positions.len() as u32;
                for c in corners {
                    walls.positions.push(c.as_vec3().to_array());
                    walls.normals.push(nm);
                    walls.material.push(0);
                    walls.child.push(child);
                }
                walls
                    .indices
                    .extend([first, first + 1, first + 2, first, first + 2, first + 3]);
            }
        }

        // The roof: the outline and its holes, flat at the roof's height, counterclockwise from above.
        let base_point = o[0];
        let mut flat: Vec<f64> = Vec::new();
        let mut hole_starts = Vec::new();
        let mut points: Vec<Point64> = Vec::new();
        for (k, ring) in rings.iter().enumerate() {
            if k > 0 {
                hole_starts.push(points.len());
            }
            for &p in ring.iter() {
                flat.extend([
                    (p.x - base_point.x) as f64 / UNITS,
                    (p.y - base_point.y) as f64 / UNITS,
                ]);
                points.push(p);
            }
        }
        let Ok(tris) = earcutr::earcut(&flat, &hole_starts, 2) else {
            roofs.failed += 1;
            continue;
        };
        let first = roofs.positions.len() as u32;
        let up = normal(local(st_of(base_point), roof + 1.0) - local(st_of(base_point), roof));
        for &p in &points {
            roofs
                .positions
                .push(local(st_of(p), roof).as_vec3().to_array());
            roofs.normals.push(up);
            roofs.material.push(1);
            roofs.child.push(child);
        }
        for t in tris.chunks(3) {
            let at = |k: usize| DVec2::new(flat[2 * t[k]], flat[2 * t[k] + 1]);
            let ccw = (at(1) - at(0)).perp_dot(at(2) - at(0)) >= 0.0;
            let [a, b, c] = if ccw {
                [t[0], t[1], t[2]]
            } else {
                [t[0], t[2], t[1]]
            };
            roofs.indices.extend([a, b, c].map(|k| first + k as u32));
        }
    }

    // One mesh: walls, then roofs, a range each.
    let mut mesh = walls;
    let offset = mesh.positions.len() as u32;
    let wall_indices = mesh.indices.len() as u32;
    mesh.positions.extend(roofs.positions);
    mesh.normals.extend(roofs.normals);
    mesh.material.extend(roofs.material);
    mesh.child.extend(roofs.child);
    mesh.indices
        .extend(roofs.indices.iter().map(|i| i + offset));
    mesh.failed = roofs.failed;
    let roof_indices = mesh.indices.len() as u32 - wall_indices;
    for (kind, first, count) in [(0, 0, wall_indices), (1, wall_indices, roof_indices)] {
        if count > 0 {
            mesh.ranges.push([kind, first, count]);
        }
    }
    mesh
}

/// Each outer ring (counterclockwise) with its holes (clockwise, each in the smallest outer holding its first point).
fn shapes(paths: &Paths64) -> Vec<(usize, Vec<usize>)> {
    let outers: Vec<usize> = (0..paths.len())
        .filter(|&s| area(&paths[s]) > 0.0)
        .collect();
    let index = Grid::new(paths, &outers);
    let mut holes: Vec<Vec<usize>> = vec![Vec::new(); paths.len()];
    for (s, path) in paths.iter().enumerate() {
        if area(path) < 0.0
            && let Some(o) = path.first().and_then(|&p| index.find(paths, p))
        {
            holes[o].push(s);
        }
    }
    outers
        .into_iter()
        .map(|o| (o, std::mem::take(&mut holes[o])))
        .collect()
}

/// The buildings merged into massing, in the cell's metres.
pub fn massing(b: &Buildings, face: u32, metric: &Metric, gap: f64, outline: f64) -> Massing {
    let rings = |k: usize| -> Paths64 {
        (b.ring_of[k]..b.ring_of[k + 1])
            .map(|r| {
                (b.ring_start[r as usize]..b.ring_start[r as usize + 1] - 1)
                    .map(|i| {
                        let [lon, lat] = b.lonlat[i as usize];
                        point(
                            metric.metres(DVec2::from_array(s2::face_st(face, lat, lon))),
                            MADE,
                        )
                    })
                    .collect()
            })
            .collect()
    };
    let mut out = Massing {
        paths: Paths64::new(),
        height: Vec::new(),
        tower: Vec::new(),
    };

    // Towers as they are; the rest closed into shapes.
    // Grown one building at a time and shrunk one merged shape (outer and holes) at a time: Clipper's offset unions
    // what it's given, which over a whole tile at once costs far more than the closing itself.
    let grow = |paths: &Paths64, d: f64| {
        inflate_paths_64(
            paths,
            d * UNITS,
            JoinType::Miter,
            EndType::Polygon,
            2.0,
            0.0,
        )
    };
    let mut grown = Paths64::new();
    let mut low_buildings = Vec::new();
    for k in 0..b.osm_id.len() {
        let paths = rings(k);
        if paths.is_empty() {
            continue; // simplified away: smaller than the tolerance
        }
        if b.height[k] >= TOWER {
            for p in paths {
                out.paths.push(p);
                out.height.push(b.height[k]);
                out.tower.push(Some(b.osm_id[k]));
            }
        } else {
            grown.extend(grow(&paths, gap / 2.0));
            low_buildings.push((k, paths[0].clone()));
        }
    }
    // Unioned cluster by cluster (grown footprints whose boxes overlap, transitively): one union over the whole tile
    // costs more than all the small ones.
    let merged: Paths64 = clusters(&grown)
        .iter()
        .flat_map(|c| {
            let paths: Paths64 = c.iter().map(|&i| grown[i].clone()).collect();
            union_subjects_64(&paths, FillRule::NonZero)
        })
        .collect();
    let merged_outers: Vec<usize> = (0..merged.len())
        .filter(|&s| area(&merged[s]) > 0.0)
        .collect();
    let merged_index = Grid::new(&merged, &merged_outers);
    let mut groups: Vec<Paths64> = vec![Paths64::new(); merged.len()];
    for (s, path) in merged.iter().enumerate() {
        let owner = if area(path) > 0.0 {
            Some(s)
        } else {
            path.first().and_then(|&p| merged_index.find(&merged, p))
        };
        if let Some(o) = owner {
            groups[o].push(path.clone());
        }
    }
    // Each shape's outline thinned (the closing follows every house's edge along a block's side).
    let shapes: Paths64 = groups
        .iter()
        .filter(|g| !g.is_empty())
        .flat_map(|g| grow(g, -gap / 2.0))
        .filter_map(|ring| simplify::simplify_ring(&ring, outline))
        .collect();

    // Each shape's height: the mean of its buildings', by area. A building is in the outer ring holding its first
    // point (found through a grid of the outers' boxes).
    let outers: Vec<usize> = (0..shapes.len())
        .filter(|&s| area(&shapes[s]) > 0.0)
        .collect();
    let index = Grid::new(&shapes, &outers);
    let mut sum = vec![(0.0, 0.0); shapes.len()];
    for (k, outer) in &low_buildings {
        let Some(p) = outer.first() else { continue };
        if let Some(s) = index.find(&shapes, *p) {
            let a = area(outer).abs();
            sum[s].0 += a * b.height[*k];
            sum[s].1 += a;
        }
    }
    // A hole takes the height of the outer around it (the smallest one holding its first point).
    for (s, path) in shapes.iter().enumerate() {
        let owner = if area(path) > 0.0 {
            Some(s)
        } else {
            path.first().and_then(|&p| index.find(&shapes, p))
        };
        let h = owner.map_or(0.0, |o| {
            if sum[o].1 > 0.0 {
                sum[o].0 / sum[o].1
            } else {
                0.0
            }
        });
        out.paths.push(path.clone());
        out.height.push(h);
        out.tower.push(None);
    }
    out
}

/// Paths in groups whose bounding boxes overlap, transitively (union-find over a grid of the boxes).
fn clusters(paths: &Paths64) -> Vec<Vec<usize>> {
    let all: Vec<usize> = (0..paths.len()).collect();
    let grid = Grid::new(paths, &all);
    let boxes: Vec<[i64; 4]> = paths.iter().map(bbox).collect();
    let mut parent: Vec<usize> = all.clone();
    fn root(parent: &mut [usize], mut i: usize) -> usize {
        while parent[i] != i {
            parent[i] = parent[parent[i]];
            i = parent[i];
        }
        i
    }
    for list in &grid.cells {
        for (x, &i) in list.iter().enumerate() {
            for &j in &list[x + 1..] {
                let (a, b) = (boxes[i], boxes[j]);
                if a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3] {
                    let (ri, rj) = (root(&mut parent, i), root(&mut parent, j));
                    parent[ri] = rj;
                }
            }
        }
    }
    let mut groups: std::collections::HashMap<usize, Vec<usize>> = std::collections::HashMap::new();
    for i in all {
        let r = root(&mut parent, i);
        groups.entry(r).or_default().push(i);
    }
    groups.into_values().collect()
}

/// Outer rings' bounding boxes in a uniform grid, to find the smallest outer holding a point.
struct Grid {
    lo: Point64,
    size: i64,
    n: usize,
    cells: Vec<Vec<usize>>,
}

impl Grid {
    fn new(paths: &Paths64, outers: &[usize]) -> Grid {
        let boxes: Vec<[i64; 4]> = outers.iter().map(|&s| bbox(&paths[s])).collect();
        let all = boxes
            .iter()
            .fold([i64::MAX, i64::MAX, i64::MIN, i64::MIN], |a, b| {
                [
                    a[0].min(b[0]),
                    a[1].min(b[1]),
                    a[2].max(b[2]),
                    a[3].max(b[3]),
                ]
            });
        let n = ((outers.len() as f64).sqrt().ceil() as usize).clamp(1, 512);
        let size = (((all[2] - all[0]).max(all[3] - all[1])) / n as i64).max(1);
        let mut g = Grid {
            lo: Point64::new(all[0], all[1]),
            size,
            n,
            cells: vec![Vec::new(); n * n],
        };
        for (&s, b) in outers.iter().zip(&boxes) {
            let (x0, y0) = g.at(b[0], b[1]);
            let (x1, y1) = g.at(b[2], b[3]);
            for y in y0..=y1 {
                for x in x0..=x1 {
                    g.cells[y * g.n + x].push(s);
                }
            }
        }
        g
    }

    fn at(&self, x: i64, y: i64) -> (usize, usize) {
        let c = |v: i64, lo: i64| (((v - lo) / self.size).max(0) as usize).min(self.n - 1);
        (c(x, self.lo.x), c(y, self.lo.y))
    }

    /// The smallest outer ring holding `p` (on its edge counts), if any.
    fn find(&self, paths: &Paths64, p: Point64) -> Option<usize> {
        let (x, y) = self.at(p.x, p.y);
        self.cells[y * self.n + x]
            .iter()
            .copied()
            .filter(|&s| point_in_polygon(p, &paths[s]) != PointInPolygonResult::IsOutside)
            .min_by(|&a, &b| area(&paths[a]).total_cmp(&area(&paths[b])))
    }
}

fn bbox(path: &Path64) -> [i64; 4] {
    path.iter()
        .fold([i64::MAX, i64::MAX, i64::MIN, i64::MIN], |b, p| {
            [b[0].min(p.x), b[1].min(p.y), b[2].max(p.x), b[3].max(p.y)]
        })
}

/// Signed area, m² (counterclockwise positive).
fn area(path: &Path64) -> f64 {
    let n = path.len();
    let twice: f64 = (0..n)
        .map(|i| {
            let (p, q) = (path[i], path[(i + 1) % n]);
            p.x as f64 * q.y as f64 - q.x as f64 * p.y as f64
        })
        .sum();
    twice / 2.0 / (UNITS * UNITS)
}
