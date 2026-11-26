//! A fine cell's points of interest table, pois.arrow, as the TS wrote it (buildPois, poisToArrow in
//! packages/world/src/pois.ts): the named (or branded) points of interest in the cell's buildings, each assigned to the
//! building it's in (the smallest ground-floor outline holding its point, or the nearest within ASSIGN_DISTANCE),
//! in input order. One in no building isn't kept.
//!
//!   osm_id    float64
//!   category  dictionary<uint8, utf8>    POI_KEYS: the key that made it one
//!   kind      dictionary<uint16, utf8>   its value: "cafe", "bakery", ...
//!   name      dictionary<uint16, utf8>   its name (or brand)
//!   x, y      float32                    m, in the cell's frame
//!   building  int32                      its row in the cell's buildings
//!   charity   float32                    how much it draws people with nowhere to live (pois::charity_weight)
//!
//! The schema metadata (values JSON-encoded) holds the cell's token.

use crate::building_table;
use crate::extract::POI_KEYS;
use crate::geodesy::Frame;
use crate::pois::PoiInputs;
use arrow_array::types::{UInt8Type, UInt16Type};
use arrow_array::{
    ArrayRef, DictionaryArray, Float32Array, Float64Array, Int32Array, RecordBatch, StringArray,
    UInt8Array, UInt16Array,
};
use arrow_ipc::writer::FileWriter;
use arrow_schema::{Field, Schema};
use std::collections::HashMap;
use std::sync::Arc;

/// Not in a building, but this close to one (m): it's that building's.
const ASSIGN_DISTANCE: f64 = 25.0;
/// A building starting higher than this (m) is up in the air: not where the door is.
const GROUND_FLOOR: f32 = 0.5;

/// The table as columns.
#[derive(Default)]
pub struct Table {
    pub osm_id: Vec<f64>,
    pub category: Vec<u8>,
    pub kind: Vec<u16>,
    pub name: Vec<u16>,
    pub x: Vec<f32>,
    pub y: Vec<f32>,
    pub building: Vec<i32>,
    pub charity: Vec<f32>,
    pub kinds: Vec<String>,
    pub names: Vec<String>,
}

/// The points of interest in the cell's buildings (`b`, its table as built, before draping), in `frame`.
pub fn build(p: &PoiInputs, b: &building_table::Table, frame: &Frame) -> Table {
    let bounds = building_bounds(b);
    let mut t = Table::default();
    let (mut kinds, mut names): (HashMap<String, u16>, HashMap<String, u16>) = Default::default();
    let index = |map: &mut HashMap<String, u16>, list: &mut Vec<String>, s: &str| {
        *map.entry(s.to_string()).or_insert_with(|| {
            list.push(s.to_string());
            (list.len() - 1) as u16
        })
    };
    for i in 0..p.osm_id.len() {
        // The name, or else the brand: an empty name counts as one (and isn't kept), as `name ?? brand` in the TS.
        let Some(text) = p.text(p.name[i]).or(p.text(p.brand[i])) else {
            continue;
        };
        if text.is_empty() {
            continue;
        }
        let [x, y] = frame.project(p.lonlat[i][0], p.lonlat[i][1]);
        let building = assign(b, &bounds, x, y);
        if building < 0 {
            continue;
        }
        t.osm_id.push(p.osm_id[i] as f64);
        t.category.push(p.category[i]);
        t.kind.push(index(
            &mut kinds,
            &mut t.kinds,
            &p.strings[p.kind[i] as usize],
        ));
        t.name.push(index(&mut names, &mut t.names, text));
        t.x.push(x as f32);
        t.y.push(y as f32);
        t.building.push(building);
        t.charity.push(p.charity[i]);
    }
    t
}

/// The building row a point is in (the smallest ground-floor outline holding it, by its bounds' area), else the
/// nearest within ASSIGN_DISTANCE (before any holding one is found); −1 for none.
fn assign(b: &building_table::Table, bounds: &[[f32; 4]], x: f64, y: f64) -> i32 {
    let (mut best, mut best_area, mut near, mut near_d) = (-1, f64::INFINITY, -1, ASSIGN_DISTANCE);
    for (i, &[x0, y0, x1, y1]) in bounds.iter().enumerate() {
        if b.min_height[i] > GROUND_FLOOR {
            continue;
        }
        let (x0, y0, x1, y1) = (x0 as f64, y0 as f64, x1 as f64, y1 as f64);
        if x < x0 - near_d || x > x1 + near_d || y < y0 - near_d || y > y1 + near_d {
            continue;
        }
        let outer = outer_ring(b, i);
        if in_ring(outer, x, y) {
            let area = (x1 - x0) * (y1 - y0);
            if area < best_area {
                (best, best_area) = (i as i32, area);
            }
        } else if best < 0 {
            let d = ring_distance(outer, x, y);
            if d < near_d {
                (near, near_d) = (i as i32, d);
            }
        }
    }
    if best >= 0 { best } else { near }
}

/// Row i's outer ring (open).
fn outer_ring(b: &building_table::Table, i: usize) -> &[[f32; 2]] {
    let r = b.ring_start[i] as usize;
    &b.points[b.point_start[r] as usize..b.point_start[r + 1] as usize]
}

/// Each row's outer ring's box (x0, y0, x1, y1).
fn building_bounds(b: &building_table::Table) -> Vec<[f32; 4]> {
    (0..b.osm_id.len())
        .map(|i| {
            let mut r = [
                f32::INFINITY,
                f32::INFINITY,
                f32::NEG_INFINITY,
                f32::NEG_INFINITY,
            ];
            for &[x, y] in outer_ring(b, i) {
                r = [r[0].min(x), r[1].min(y), r[2].max(x), r[3].max(y)];
            }
            r
        })
        .collect()
}

/// Whether a point is inside an open ring (even-odd crossings of a ray east).
fn in_ring(ring: &[[f32; 2]], x: f64, y: f64) -> bool {
    let mut inside = false;
    let mut j = ring.len() - 1;
    for i in 0..ring.len() {
        let ([xi, yi], [xj, yj]) = (ring[i].map(f64::from), ring[j].map(f64::from));
        if (yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// Distance from a point to an open ring's edges.
fn ring_distance(ring: &[[f32; 2]], x: f64, y: f64) -> f64 {
    let mut best = f64::INFINITY;
    let mut j = ring.len() - 1;
    for i in 0..ring.len() {
        let ([px, py], [qx, qy]) = (ring[j].map(f64::from), ring[i].map(f64::from));
        let (dx, dy) = (qx - px, qy - py);
        let len2 = dx * dx + dy * dy;
        let t = if len2 > 0.0 {
            (((x - px) * dx + (y - py) * dy) / len2).clamp(0.0, 1.0)
        } else {
            0.0
        };
        best = best.min((x - (px + t * dx)).hypot(y - (py + t * dy)));
        j = i;
    }
    best
}

/// pois.arrow, as bytes.
pub fn encode(t: &Table, token: &str) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let strings = |s: &[String]| Arc::new(StringArray::from_iter_values(s));
    let columns: Vec<(&str, ArrayRef)> = vec![
        ("osm_id", Arc::new(Float64Array::from(t.osm_id.clone()))),
        (
            "category",
            Arc::new(DictionaryArray::<UInt8Type>::try_new(
                UInt8Array::from(t.category.clone()),
                Arc::new(StringArray::from(POI_KEYS.to_vec())),
            )?),
        ),
        (
            "kind",
            Arc::new(DictionaryArray::<UInt16Type>::try_new(
                UInt16Array::from(t.kind.clone()),
                strings(&t.kinds),
            )?),
        ),
        (
            "name",
            Arc::new(DictionaryArray::<UInt16Type>::try_new(
                UInt16Array::from(t.name.clone()),
                strings(&t.names),
            )?),
        ),
        ("x", Arc::new(Float32Array::from(t.x.clone()))),
        ("y", Arc::new(Float32Array::from(t.y.clone()))),
        ("building", Arc::new(Int32Array::from(t.building.clone()))),
        ("charity", Arc::new(Float32Array::from(t.charity.clone()))),
    ];
    let schema = Arc::new(Schema::new_with_metadata(
        columns
            .iter()
            .map(|(name, a)| Field::new(*name, a.data_type().clone(), false))
            .collect::<Vec<_>>(),
        HashMap::from([("cell".to_string(), format!("\"{token}\""))]),
    ));
    let batch = RecordBatch::try_new(
        schema.clone(),
        columns.into_iter().map(|(_, a)| a).collect(),
    )?;
    let mut out = Vec::new();
    let mut writer = FileWriter::try_new(&mut out, &schema)?;
    writer.write(&batch)?;
    writer.finish()?;
    drop(writer);
    Ok(out)
}
