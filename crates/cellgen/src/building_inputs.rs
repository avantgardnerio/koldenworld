//! Buildings, the input for a fine cell's buildings table, as the TS loadBuildings (packages/db/src/export.ts) returns
//! them: buildings and building:parts intersecting the box (ST_Intersects), ordered by OSM type (as text: relation,
//! way) and id, rings as stored (not reoriented). An outline is left out when a part's point on its surface
//! (ST_PointOnSurface, the GEOS interior point) lies in it: the parts describe its shape in more detail.
//!
//! Parts are looked for wherever they are, so the OSM must cover every outline found in full: `reach` says how far,
//! and a load over it (local::load_box) finds them.

use crate::boxes;
use crate::extract::{self, Extracted, Polygons};
use crate::osm::{Osm, RELATION, WAY};
use std::collections::HashMap;

/// Buildings as columns; strings (kinds, roof shapes) once each in `strings`; building b's polygons in `shape`
/// (poly_start[b]..poly_start[b + 1], each its rings, outer first, closed).
#[derive(Default)]
pub struct BuildingInputs {
    pub osm_type: Vec<u8>, // osm::WAY or RELATION
    pub osm_id: Vec<i64>,
    pub kind: Vec<u32>, // index into strings: the building (or building:part) value
    pub is_part: Vec<bool>,
    pub height: Vec<f32>,             // m, top of the walls
    pub min_height: Vec<f32>,         // m, bottom of the walls
    pub height_source: Vec<u8>,       // 0 "height", 1 "levels", 2 "default"
    pub levels: Vec<f32>,             // building:levels; NaN where not tagged
    pub min_level: Vec<f64>, // building:min_level, as JS parseFloat reads it; NaN where none
    pub roof_shape: Vec<Option<u32>>, // index into strings
    pub strings: Vec<String>,
    pub shape: Polygons,
}

/// TS HEIGHT_SOURCES, as the import stores them.
pub const HEIGHT_SOURCES: [&str; 3] = ["height", "levels", "default"];

/// How far the outlines intersecting the box reach (the box grown to cover them): an OSM load over it has every part
/// that can replace them.
pub fn reach(x: &Extracted, bbox: [f64; 4]) -> [f64; 4] {
    let s = &x.buildings.shape;
    let mut out = bbox;
    for f in 0..x.buildings.is_part.len() {
        if x.buildings.is_part[f] || !meets_box(s, f, bbox) {
            continue;
        }
        for (_, ring) in s.rings(f) {
            for &[lon, lat] in ring {
                out = [
                    out[0].min(lon),
                    out[1].min(lat),
                    out[2].max(lon),
                    out[3].max(lat),
                ];
            }
        }
    }
    out
}

impl BuildingInputs {
    /// The buildings of OSM loaded (local::load_box) over `reach(x, bbox)` and extracted.
    pub fn from_extracted(osm: &Osm, x: &Extracted, bbox: [f64; 4]) -> BuildingInputs {
        let xb = &x.buildings;
        let s = &xb.shape;
        // Every part's point on its surface, with its polygons' bounds (for &&).
        let parts: Vec<([f64; 2], [f64; 4])> = (0..xb.is_part.len())
            .filter(|&f| xb.is_part[f])
            .filter_map(|f| Some((point_on_surface(s, f)?, bounds(s, f))))
            .collect();
        let mut b = BuildingInputs::empty();
        let mut index = HashMap::new();
        // by_type_and_id orders relations before ways, then by id: as Postgres orders the types as text.
        for f in extract::by_type_and_id(osm, &xb.relation, &xb.element) {
            if !meets_box(s, f, bbox) {
                continue;
            }
            if !xb.is_part[f] {
                let own = bounds(s, f);
                let replaced = parts.iter().any(|&(p, pb)| {
                    pb[0] <= own[2]
                        && pb[2] >= own[0]
                        && pb[1] <= own[3]
                        && pb[3] >= own[1]
                        && meets_box(s, f, [p[0], p[1], p[0], p[1]])
                });
                if replaced {
                    continue;
                }
            }
            let e = xb.element[f] as usize;
            let (osm_type, id, tags) = if xb.relation[f] {
                (RELATION, osm.relation_id[e], &osm.relation_tags)
            } else {
                (WAY, osm.way_id[e], &osm.way_tags)
            };
            let tag = |key: &str| {
                let k = osm.strings.find(key)?;
                tags.get(e, k)
                    .map(|v| osm.strings.text[v as usize].as_str())
            };
            for p in s.poly_start[f] as usize..s.poly_start[f + 1] as usize {
                for r in s.ring_start[p] as usize..s.ring_start[p + 1] as usize {
                    b.shape.lonlat.extend_from_slice(
                        &s.lonlat[s.point_start[r] as usize..s.point_start[r + 1] as usize],
                    );
                    b.shape.point_start.push(b.shape.lonlat.len() as u32);
                }
                b.shape
                    .ring_start
                    .push((b.shape.point_start.len() - 1) as u32);
            }
            b.push(
                &mut index,
                (osm_type, id),
                &osm.strings.text[xb.kind[f] as usize],
                xb.is_part[f],
                [xb.height[f], xb.min_height[f]],
                xb.height_source[f],
                xb.levels[f],
                tag("building:min_level"),
                tag("roof:shape"),
            );
        }
        b
    }

    fn empty() -> BuildingInputs {
        BuildingInputs {
            shape: Polygons {
                poly_start: vec![0],
                ring_start: vec![0],
                point_start: vec![0],
                lonlat: Vec::new(),
            },
            ..Default::default()
        }
    }

    /// One building, after its polygons have gone into `shape`.
    #[allow(clippy::too_many_arguments)]
    fn push(
        &mut self,
        index: &mut HashMap<String, u32>,
        (osm_type, osm_id): (u8, i64),
        kind: &str,
        is_part: bool,
        [height, min_height]: [f32; 2],
        height_source: u8,
        levels: f32,
        min_level: Option<&str>,
        roof_shape: Option<&str>,
    ) {
        let mut string = |s: &str| {
            *index.entry(s.to_string()).or_insert_with(|| {
                self.strings.push(s.to_string());
                (self.strings.len() - 1) as u32
            })
        };
        let (kind, roof_shape) = (string(kind), roof_shape.map(string));
        self.osm_type.push(osm_type);
        self.osm_id.push(osm_id);
        self.kind.push(kind);
        self.is_part.push(is_part);
        self.height.push(height);
        self.min_height.push(min_height);
        self.height_source.push(height_source);
        self.levels.push(levels);
        self.min_level
            .push(min_level.and_then(parse_float).unwrap_or(f64::NAN));
        self.roof_shape.push(roof_shape);
        self.shape
            .poly_start
            .push((self.shape.ring_start.len() - 1) as u32);
    }

    /// A string by index, for comparing two loads (whose strings are numbered differently).
    pub fn text(&self, s: Option<u32>) -> Option<&str> {
        s.map(|s| self.strings[s as usize].as_str())
    }
}

/// Whether feature f has a point in the box (ST_Intersects): any of its polygons.
fn meets_box(s: &Polygons, f: usize, bbox: [f64; 4]) -> bool {
    (s.poly_start[f] as usize..s.poly_start[f + 1] as usize).any(|p| {
        let rings = (s.ring_start[p] as usize..s.ring_start[p + 1] as usize)
            .map(|r| &s.lonlat[s.point_start[r] as usize..s.point_start[r + 1] as usize]);
        boxes::polygon_meets_box(rings, bbox)
    })
}

/// Feature f's bounds (west, south, east, north).
fn bounds(s: &Polygons, f: usize) -> [f64; 4] {
    let mut b = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
    for (_, ring) in s.rings(f) {
        for &[x, y] in ring {
            b = [b[0].min(x), b[1].min(y), b[2].max(x), b[3].max(y)];
        }
    }
    b
}

/// Feature f's point on its surface, as GEOS's InteriorPointArea (ST_PointOnSurface) finds it: in each polygon, on a
/// horizontal line between the two vertex heights nearest its bounds' middle, the middle of the widest stretch inside;
/// the polygon with the widest stretch wins (the first, on a tie). A polygon with no stretch gives its first point.
fn point_on_surface(s: &Polygons, f: usize) -> Option<[f64; 2]> {
    let mut best: Option<([f64; 2], f64)> = None;
    for p in s.poly_start[f] as usize..s.poly_start[f + 1] as usize {
        let rings: Vec<&[[f64; 2]]> = (s.ring_start[p] as usize..s.ring_start[p + 1] as usize)
            .map(|r| &s.lonlat[s.point_start[r] as usize..s.point_start[r + 1] as usize])
            .collect();
        let Some(&first) = rings.first().and_then(|r| r.first()) else {
            continue;
        };
        // The scan line: the middle of the nearest vertex heights at or below, and above, the bounds' middle.
        let (mut lo, mut hi) = (f64::MAX, f64::MIN);
        for &[_, y] in rings.iter().flat_map(|r| r.iter()) {
            (lo, hi) = (lo.min(y), hi.max(y));
        }
        let centre = avg(lo, hi);
        for &[_, y] in rings.iter().flat_map(|r| r.iter()) {
            if y <= centre {
                if y > lo {
                    lo = y;
                }
            } else if y < hi {
                hi = y;
            }
        }
        let scan = avg(hi, lo);
        let mut crossings = Vec::new();
        for ring in &rings {
            for w in ring.windows(2) {
                let ([x0, y0], [x1, y1]) = (w[0], w[1]);
                if (y0 > scan && y1 > scan) || (y0 < scan && y1 < scan) {
                    continue;
                }
                // Horizontal edges, and an end on the line with the other below it, don't count.
                if y0 == y1 || (y0 == scan && y1 < scan) || (y1 == scan && y0 < scan) {
                    continue;
                }
                crossings.push(if x0 == x1 {
                    x0
                } else {
                    x0 + (scan - y0) / ((y1 - y0) / (x1 - x0))
                });
            }
        }
        crossings.sort_by(f64::total_cmp);
        let (mut point, mut width) = (first, 0.0);
        for &[x0, x1] in crossings.as_chunks::<2>().0 {
            if x1 - x0 > width {
                (point, width) = ([avg(x0, x1), scan], x1 - x0);
            }
        }
        if best.is_none_or(|(_, w)| width > w) {
            best = Some((point, width));
        }
    }
    best.map(|(p, _)| p)
}

fn avg(a: f64, b: f64) -> f64 {
    (a + b) / 2.0
}

/// A number as JS parseFloat reads one: the longest decimal prefix after leading whitespace ("3 floors" is 3);
/// None where there's none, or it isn't finite (as the TS keeps only Number.isFinite values).
fn parse_float(v: &str) -> Option<f64> {
    let v = v.trim_start();
    let b = v.as_bytes();
    let mut end = 0;
    let mut i = 0;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    let digits = |i: &mut usize| {
        let start = *i;
        while *i < b.len() && b[*i].is_ascii_digit() {
            *i += 1;
        }
        *i > start
    };
    let mut any = digits(&mut i);
    if any {
        end = i;
    }
    if i < b.len() && b[i] == b'.' {
        i += 1;
        if digits(&mut i) || any {
            any = true;
            end = i;
        }
    }
    if any && i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        let mut j = i + 1;
        if j < b.len() && (b[j] == b'+' || b[j] == b'-') {
            j += 1;
        }
        if digits(&mut j) {
            end = j;
        }
    }
    if !any {
        return None;
    }
    v[..end].parse::<f64>().ok().filter(|n| n.is_finite())
}
