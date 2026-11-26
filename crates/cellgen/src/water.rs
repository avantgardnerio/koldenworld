//! Water: waterway lines (rivers, streams, canals) expanded like roads, each half its width either side, and water
//! areas (riverbanks, lakes) as they are, from the cell files, in lon/lat.

use crate::boxes;
use crate::clip::{UNITS, point};
use crate::extract::{self, Extracted};
use crate::geom::Metric;
use crate::osm::Osm;
use crate::polygon::MADE;
use crate::s2;
use clipper2_rust::{EndType, FillRule, JoinType, Paths64, inflate_paths_64, union_subjects_64};
use glam::DVec2;

/// Water as columns: lines with a width, and area rings (outer rings counterclockwise, holes clockwise), each a run
/// of points (CSR).
#[derive(Default)]
pub struct Water {
    pub line_start: Vec<u32>,  // lines + 1 offsets into points
    pub width: Vec<f64>,       // per line, m
    pub ring_start: Vec<u32>,  // rings + 1 offsets into points
    pub lonlat: Vec<[f64; 2]>, // the lines' points, then the rings'
}

impl Water {
    /// The water of OSM loaded for a box (local::load_box) and extracted: waterways and areas intersecting it.
    pub fn from_extracted(osm: &Osm, x: &Extracted, bbox: [f64; 4], min_width: f64) -> Water {
        let mut water = Water {
            line_start: vec![0],
            ..Default::default()
        };
        let l = &x.waterways;
        let points = |i: usize| &l.lonlat[l.point_start[i] as usize..l.point_start[i + 1] as usize];
        let mut lines: Vec<usize> = (0..l.way.len())
            .filter(|&i| l.width[i] >= min_width as f32 && boxes::line_meets_box(points(i), bbox))
            .collect();
        lines.sort_by_key(|&i| osm.way_id[l.way[i] as usize]);
        for i in lines {
            water.lonlat.extend_from_slice(points(i));
            water.width.push(l.width[i] as f64);
            water.line_start.push(water.lonlat.len() as u32);
        }
        let a = &x.water_areas;
        water.ring_start.push(water.lonlat.len() as u32);
        for f in extract::by_type_and_id(osm, &a.relation, &a.element) {
            let rings = a.shape.rings(f);
            if !boxes::polygon_meets_box(rings.clone().map(|(_, r)| r), bbox) {
                continue;
            }
            for (outer, ring) in rings {
                boxes::push_ring(ring, outer, &mut water.lonlat);
                water.ring_start.push(water.lonlat.len() as u32);
            }
        }
        water
    }

    /// The water with only the points marked in `keep` (one per point).
    pub fn keep_points(&self, keep: &[bool]) -> Water {
        let mut out = Water {
            line_start: vec![0],
            width: self.width.clone(),
            ring_start: vec![],
            lonlat: Vec::new(),
        };
        for r in self.line_start.windows(2) {
            out.lonlat.extend(
                (r[0]..r[1])
                    .filter(|&i| keep[i as usize])
                    .map(|i| self.lonlat[i as usize]),
            );
            out.line_start.push(out.lonlat.len() as u32);
        }
        out.ring_start.push(out.lonlat.len() as u32);
        for r in self.ring_start.windows(2) {
            out.lonlat.extend(
                (r[0]..r[1])
                    .filter(|&i| keep[i as usize])
                    .map(|i| self.lonlat[i as usize]),
            );
            out.ring_start.push(out.lonlat.len() as u32);
        }
        out
    }

    /// No water at all.
    pub fn empty() -> Water {
        Water {
            line_start: vec![0],
            ring_start: vec![0],
            ..Default::default()
        }
    }

    /// All the water as Clipper paths around the cell: lines buffered half their width either side (round ends, so
    /// segments join smoothly; arcs within `arc_tolerance` m), and the areas, unioned.
    pub fn paths(&self, face: u32, metric: &Metric, arc_tolerance: f64) -> Paths64 {
        let at = |k: usize| {
            let [lon, lat] = self.lonlat[k];
            point(
                metric.metres(DVec2::from_array(s2::face_st(face, lat, lon))),
                MADE,
            )
        };
        let mut all = Paths64::new();
        for (i, &w) in self.width.iter().enumerate() {
            let line = (self.line_start[i] as usize..self.line_start[i + 1] as usize)
                .map(at)
                .collect();
            all.extend(inflate_paths_64(
                &vec![line],
                w / 2.0 * UNITS,
                JoinType::Round,
                EndType::Round,
                4.0,
                arc_tolerance * UNITS,
            ));
        }
        for r in 0..self.ring_start.len().saturating_sub(1) {
            all.push(
                (self.ring_start[r] as usize..self.ring_start[r + 1] as usize)
                    .map(at)
                    .collect(),
            );
        }
        union_subjects_64(&all, FillRule::NonZero)
    }
}
