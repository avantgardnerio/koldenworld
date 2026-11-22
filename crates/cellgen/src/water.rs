//! Water: waterway lines (rivers, streams, canals) expanded like roads, each half its width either side, and water
//! areas (riverbanks, lakes) as they are, loaded from Postgres (waterways, water_areas) in lon/lat.

use crate::clip::{UNITS, point};
use crate::geom::Metric;
use crate::polygon::MADE;
use crate::s2;
use crate::ways::wkb_line_string;
use clipper2_rust::{EndType, FillRule, JoinType, Paths64, inflate_paths_64, union_subjects_64};
use glam::DVec2;
use postgres::Client;

/// Water as columns: lines with a width, and area rings (outer rings counterclockwise, holes clockwise), each a run
/// of points (CSR).
#[derive(Default)]
pub struct Water {
    pub line_start: Vec<u32>,  // lines + 1 offsets into points
    pub width: Vec<f64>,       // per line, m
    pub ring_start: Vec<u32>,  // rings + 1 offsets into points
    pub lonlat: Vec<[f64; 2]>, // the lines' points, then the rings'
}

/// Every waterway and water area intersecting a lon/lat box.
pub fn load_water(
    db: &mut Client,
    west: f64,
    south: f64,
    east: f64,
    north: f64,
) -> Result<Water, Box<dyn std::error::Error>> {
    let mut water = Water {
        line_start: vec![0],
        ring_start: vec![],
        ..Default::default()
    };
    let lines = db.query(
        "SELECT width_m, ST_AsBinary(geom) FROM waterways
         WHERE ST_Intersects(geom, ST_MakeEnvelope($1, $2, $3, $4, 4326)) ORDER BY osm_way_id",
        &[&west, &south, &east, &north],
    )?;
    for row in &lines {
        let width: f32 = row.get(0);
        wkb_line_string(row.get(1), &mut water.lonlat)?;
        water.width.push(width as f64);
        water.line_start.push(water.lonlat.len() as u32);
    }
    // Each area's rings as line strings, outer rings counterclockwise and holes clockwise (so a nonzero fill of them
    // all has the holes).
    let rings = db.query(
        "SELECT ST_AsBinary(ST_ExteriorRing((r).geom)) FROM (
           SELECT ST_DumpRings((ST_Dump(ST_ForcePolygonCCW(geom))).geom) AS r FROM water_areas
           WHERE ST_Intersects(geom, ST_MakeEnvelope($1, $2, $3, $4, 4326)) ORDER BY osm_type, osm_id
         ) rings",
        &[&west, &south, &east, &north],
    )?;
    water.ring_start.push(water.lonlat.len() as u32);
    for row in &rings {
        wkb_line_string(row.get(0), &mut water.lonlat)?;
        water.ring_start.push(water.lonlat.len() as u32);
    }
    Ok(water)
}

impl Water {
    /// All the water as Clipper paths around the cell: lines buffered half their width either side (round ends, so
    /// segments join smoothly), and the areas, unioned.
    pub fn paths(&self, face: u32, metric: &Metric) -> Paths64 {
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
                0.0,
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
