//! Airport surfaces: runways, taxiways and aprons, as ground kinds (decision 32). Center lines are expanded like
//! roads, half their width either side (runways with flat ends, as painted thresholds; taxiways round, so their bends
//! join smoothly), and areas are as they are; from the cell files, in lon/lat.

use crate::boxes;
use crate::clip::{UNITS, point};
use crate::extract::{self, Extracted};
use crate::geom::Metric;
use crate::osm::Osm;
use crate::polygon::MADE;
use crate::s2;
use clipper2_rust::{EndType, FillRule, JoinType, Paths64, inflate_paths_64, union_subjects_64};
use glam::DVec2;

/// Airport surfaces as columns: lines with a kind and a width, and area rings (outer rings counterclockwise, holes
/// clockwise) with a kind, each a run of points (CSR).
#[derive(Default)]
pub struct Aeroways {
    pub line_kind: Vec<u8>,    // per line, an index into KINDS
    pub width: Vec<f64>,       // per line, m
    pub line_start: Vec<u32>,  // lines + 1 offsets into lonlat
    pub ring_kind: Vec<u8>,    // per ring, an index into KINDS
    pub ring_start: Vec<u32>,  // rings + 1 offsets into lonlat
    pub lonlat: Vec<[f64; 2]>, // the lines' points, then the rings'
}

impl Aeroways {
    /// The airports of OSM loaded for a box (local::load_box) and extracted: lines and areas intersecting it.
    pub fn from_extracted(osm: &Osm, x: &Extracted, bbox: [f64; 4]) -> Aeroways {
        let mut a = Aeroways {
            line_start: vec![0],
            ..Default::default()
        };
        let l = &x.aeroway_lines;
        let points = |i: usize| &l.lonlat[l.point_start[i] as usize..l.point_start[i + 1] as usize];
        let mut lines: Vec<usize> = (0..l.way.len())
            .filter(|&i| boxes::line_meets_box(points(i), bbox))
            .collect();
        lines.sort_by_key(|&i| osm.way_id[l.way[i] as usize]);
        for i in lines {
            a.lonlat.extend_from_slice(points(i));
            a.line_kind.push(l.kind[i] as u8);
            a.width.push(l.width[i] as f64);
            a.line_start.push(a.lonlat.len() as u32);
        }
        let areas = &x.aeroway_areas;
        a.ring_start.push(a.lonlat.len() as u32);
        for f in extract::by_type_and_id(osm, &areas.relation, &areas.element) {
            let rings = areas.shape.rings(f);
            if !boxes::polygon_meets_box(rings.clone().map(|(_, r)| r), bbox) {
                continue;
            }
            for (outer, ring) in rings {
                boxes::push_ring(ring, outer, &mut a.lonlat);
                a.ring_kind.push(areas.kind[f]);
                a.ring_start.push(a.lonlat.len() as u32);
            }
        }
        a
    }

    /// No airports at all.
    pub fn empty() -> Aeroways {
        Aeroways {
            line_start: vec![0],
            ring_start: vec![0],
            ..Default::default()
        }
    }

    /// The airports with only the points marked in `keep` (one per point).
    pub fn keep_points(&self, keep: &[bool]) -> Aeroways {
        let mut out = Aeroways {
            line_kind: self.line_kind.clone(),
            width: self.width.clone(),
            line_start: vec![0],
            ring_kind: self.ring_kind.clone(),
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

    /// Each kind (in KINDS order) as Clipper paths around the cell, unioned: lines expanded half their width either
    /// side (round joins and ends within `arc_tolerance` m, flat ends for runways), and the areas.
    pub fn paths(&self, face: u32, metric: &Metric, arc_tolerance: f64) -> [Paths64; 3] {
        let at = |k: usize| {
            let [lon, lat] = self.lonlat[k];
            point(
                metric.metres(DVec2::from_array(s2::face_st(face, lat, lon))),
                MADE,
            )
        };
        let mut all: [Paths64; 3] = Default::default();
        for (i, &w) in self.width.iter().enumerate() {
            let line = (self.line_start[i] as usize..self.line_start[i + 1] as usize)
                .map(at)
                .collect();
            let runway = self.line_kind[i] == 0;
            all[self.line_kind[i] as usize].extend(inflate_paths_64(
                &vec![line],
                w / 2.0 * UNITS,
                if runway {
                    JoinType::Miter
                } else {
                    JoinType::Round
                },
                if runway {
                    EndType::Butt
                } else {
                    EndType::Round
                },
                4.0,
                arc_tolerance * UNITS,
            ));
        }
        for r in 0..self.ring_kind.len() {
            all[self.ring_kind[r] as usize].push(
                (self.ring_start[r] as usize..self.ring_start[r + 1] as usize)
                    .map(at)
                    .collect(),
            );
        }
        all.map(|paths| union_subjects_64(&paths, FillRule::NonZero))
    }
}
