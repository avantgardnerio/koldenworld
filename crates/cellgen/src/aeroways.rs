//! Airport surfaces: runways, taxiways and aprons, as ground kinds (decision 32). Center lines are expanded like
//! roads, half their width either side (runways with flat ends, as painted thresholds; taxiways round, so their bends
//! join smoothly), and areas are as they are; loaded from Postgres (aeroway_lines, aeroway_areas) in lon/lat.

use crate::clip::{UNITS, point};
use crate::geom::Metric;
use crate::polygon::MADE;
use crate::s2;
use crate::ways::wkb_line_string;
use clipper2_rust::{EndType, FillRule, JoinType, Paths64, inflate_paths_64, union_subjects_64};
use glam::DVec2;
use tokio_postgres::Client;

/// The kinds, in the order of `paths`: where they overlap, the first wins.
pub const KINDS: [&str; 3] = ["runway", "taxiway", "apron"];

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

/// Every airport line and area intersecting a lon/lat box.
pub async fn load(
    db: &Client,
    [west, south, east, north]: [f64; 4],
) -> Result<Aeroways, Box<dyn std::error::Error + Send + Sync>> {
    let kind = |k: &str| KINDS.iter().position(|c| *c == k).map(|i| i as u8);
    let mut a = Aeroways {
        line_start: vec![0],
        ..Default::default()
    };
    let lines = db
        .query(
            "SELECT kind, width_m, ST_AsBinary(geom) FROM aeroway_lines
             WHERE ST_Intersects(geom, ST_MakeEnvelope($1, $2, $3, $4, 4326)) ORDER BY osm_way_id",
            &[&west, &south, &east, &north],
        )
        .await?;
    for row in &lines {
        let Some(k) = kind(row.get(0)) else { continue };
        wkb_line_string(row.get(2), &mut a.lonlat)?;
        a.line_kind.push(k);
        a.width.push(row.get::<_, f32>(1) as f64);
        a.line_start.push(a.lonlat.len() as u32);
    }
    // Each area's rings as line strings, outer rings counterclockwise and holes clockwise (so a nonzero fill of them
    // all has the holes).
    let rings = db
        .query(
            "SELECT kind, ST_AsBinary(ST_ExteriorRing((r).geom)) FROM (
               SELECT kind, ST_DumpRings((ST_Dump(ST_ForcePolygonCCW(geom))).geom) AS r FROM aeroway_areas
               WHERE ST_Intersects(geom, ST_MakeEnvelope($1, $2, $3, $4, 4326)) ORDER BY osm_type, osm_id
             ) rings",
            &[&west, &south, &east, &north],
        )
        .await?;
    a.ring_start.push(a.lonlat.len() as u32);
    for row in &rings {
        let Some(k) = kind(row.get(0)) else { continue };
        wkb_line_string(row.get(1), &mut a.lonlat)?;
        a.ring_kind.push(k);
        a.ring_start.push(a.lonlat.len() as u32);
    }
    Ok(a)
}

impl Aeroways {
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
