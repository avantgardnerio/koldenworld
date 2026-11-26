//! A fine cell's buildings table, buildings.arrow, as the TS wrote it (buildBuildings, drapeBuildings,
//! buildingsToArrow in packages/world/src): the buildings the cell owns (by owner point), a row per polygon (a
//! multipolygon building is several rows sharing an OSM id), projected to the cell's frame, rings open (no repeated
//! closing point), the outer ring counterclockwise and holes clockwise; each row draped on the drawn ground: its
//! points placed at the lowest ground under its outer ring, and that height in the frame as its base.
//!
//!   osm_id         float64
//!   osm_type       dictionary<uint8, utf8>    OSM_TYPES
//!   kind           dictionary<uint16, utf8>   building / building:part value, in order of first appearance
//!   is_part        uint8                      0 / 1
//!   height         float32                    m, top of walls
//!   min_height     float32                    m, bottom of walls
//!   base           float32                    m, ground under the building in the frame (lowest point)
//!   height_source  dictionary<uint8, utf8>    HEIGHT_SOURCES
//!   levels         float32                    building:levels; NaN where not tagged
//!   min_level      float32                    building:min_level; 0 where not tagged
//!   roof_shape     dictionary<uint8, utf8>    ROOF_SHAPES
//!   rings          list<list<fixed_size_list<float32, 2>>>
//!
//! The schema metadata (values JSON-encoded) holds the cell's token and BUILDINGS_VERSION.

use crate::building_inputs::{BuildingInputs, HEIGHT_SOURCES};
use crate::geodesy::{self, Frame};
use arrow_array::types::{UInt8Type, UInt16Type};
use arrow_array::{
    ArrayRef, DictionaryArray, FixedSizeListArray, Float32Array, Float64Array, ListArray,
    RecordBatch, StringArray, UInt8Array, UInt16Array,
};
use arrow_buffer::{OffsetBuffer, ScalarBuffer};
use arrow_ipc::writer::FileWriter;
use arrow_schema::{DataType, Field, Schema};
use std::collections::HashMap;
use std::sync::Arc;

/// The TS BUILDINGS_VERSION.
pub const BUILDINGS_VERSION: u32 = 3;
/// OSM element types, as the TS OSM_TYPES; a row's osm_type is an index into this.
const OSM_TYPES: [&str; 2] = ["way", "relation"];
/// OSM roof:shape values told apart ("" for none or another), as the TS ROOF_SHAPES.
const ROOF_SHAPES: [&str; 12] = [
    "",
    "flat",
    "gabled",
    "hipped",
    "pyramidal",
    "skillion",
    "half-hipped",
    "gambrel",
    "mansard",
    "round",
    "dome",
    "onion",
];

/// The table as columns: row r's rings ring_start[r]..ring_start[r + 1], ring k's points
/// point_start[k]..point_start[k + 1].
#[derive(Default)]
pub struct Table {
    pub osm_id: Vec<f64>,
    pub osm_type: Vec<u8>,
    pub kind: Vec<u16>,
    pub is_part: Vec<u8>,
    pub height: Vec<f32>,
    pub min_height: Vec<f32>,
    pub base: Vec<f32>,
    pub height_source: Vec<u8>,
    pub levels: Vec<f32>,
    pub min_level: Vec<f32>,
    pub roof_shape: Vec<u8>,
    pub ring_start: Vec<i32>,
    pub point_start: Vec<i32>,
    pub points: Vec<[f32; 2]>,
    pub kinds: Vec<String>,
}

/// The table of the buildings whose owner point `owns` (lon, lat), projected to `frame`, not yet draped (base 0, as
/// the TS buildBuildings: what points of interest are assigned on).
pub fn build(b: &BuildingInputs, owns: impl Fn(f64, f64) -> bool, frame: &Frame) -> Table {
    let s = &b.shape;
    let mut t = Table {
        ring_start: vec![0],
        point_start: vec![0],
        ..Default::default()
    };
    let mut kind_index: HashMap<&str, u16> = HashMap::new();
    for i in 0..b.osm_id.len() {
        let polygons = s.poly_start[i] as usize..s.poly_start[i + 1] as usize;
        let ring = |r: usize| &s.lonlat[s.point_start[r] as usize..s.point_start[r + 1] as usize];
        let [lon, lat] = crate::buildings::owner_point(ring(s.ring_start[polygons.start] as usize));
        if !owns(lon, lat) {
            continue;
        }
        // Kinds are numbered as buildings are met, whether or not a row comes of them.
        let text = b.strings[b.kind[i] as usize].as_str();
        let next = kind_index.len() as u16;
        let kind = *kind_index.entry(text).or_insert_with(|| {
            t.kinds.push(text.to_string());
            next
        });
        for p in polygons {
            let mut rings: Vec<Vec<[f32; 2]>> = Vec::new();
            for (k, r) in (s.ring_start[p] as usize..s.ring_start[p + 1] as usize).enumerate() {
                let mut xy: Vec<[f64; 2]> = Vec::new();
                for &[lon, lat] in ring(r) {
                    let q = frame.project(lon, lat);
                    if xy.last() != Some(&q) {
                        xy.push(q);
                    }
                }
                // Open the ring: drop the closing point if it repeats the first.
                if xy.len() >= 2 && xy.first() == xy.last() {
                    xy.pop();
                }
                if xy.len() < 3 {
                    if k == 0 {
                        break; // a degenerate outer ring drops the whole polygon
                    }
                    continue;
                }
                if (signed_area2(&xy) > 0.0) != (k == 0) {
                    xy.reverse();
                }
                rings.push(xy.iter().map(|&[x, y]| [x as f32, y as f32]).collect());
            }
            if rings.is_empty() {
                continue;
            }
            for xy in &rings {
                t.points.extend_from_slice(xy);
                t.point_start.push(t.points.len() as i32);
            }
            t.ring_start.push((t.point_start.len() - 1) as i32);
            t.osm_id.push(b.osm_id[i] as f64);
            t.osm_type
                .push(u8::from(b.osm_type[i] == crate::osm::RELATION));
            t.kind.push(kind);
            t.is_part.push(u8::from(b.is_part[i]));
            t.height.push(b.height[i]);
            t.min_height.push(b.min_height[i]);
            t.base.push(0.0);
            t.height_source.push(b.height_source[i]);
            t.levels.push(b.levels[i]);
            t.min_level.push(if b.min_level[i].is_nan() {
                0.0
            } else {
                b.min_level[i] as f32
            });
            t.roof_shape.push(
                b.text(b.roof_shape[i])
                    .and_then(|r| ROOF_SHAPES.iter().position(|s| *s == r))
                    .unwrap_or(0) as u8,
            );
        }
    }
    t
}

/// The table draped on `ground` (lat, lon → m above the ellipsoid; the drawn ground's, cell::Ground), as the TS
/// drapeBuildings: each row's points at the lowest ground under its outer ring, placed at their true height, and its
/// base that height in the frame (at the outer ring's first point).
pub fn drape(mut t: Table, frame: &Frame, mut ground: impl FnMut(f64, f64) -> f64) -> Table {
    let mut points = Vec::with_capacity(t.points.len());
    let mut base = Vec::with_capacity(t.base.len());
    for r in 0..t.osm_id.len() {
        let rings = t.ring_start[r] as usize..t.ring_start[r + 1] as usize;
        let outer = t.point_start[rings.start] as usize..t.point_start[rings.start + 1] as usize;
        let low = t.points[outer.clone()]
            .iter()
            .map(|&[x, y]| {
                let [lon, lat] = frame.lon_lat(x as f64, y as f64);
                ground(lat, lon)
            })
            .fold(f64::INFINITY, f64::min);
        let place = |[x, y]: [f32; 2]| {
            let [lon, lat] = frame.lon_lat(x as f64, y as f64);
            frame.local(geodesy::ecef(lat, lon, low))
        };
        base.push(place(t.points[outer.start]).z as f32);
        let all = outer.start..t.point_start[rings.end] as usize;
        points.extend(t.points[all].iter().map(|&p| {
            let q = place(p);
            [q.x as f32, q.y as f32]
        }));
    }
    (t.points, t.base) = (points, base);
    t
}

/// buildings.arrow, as bytes.
pub fn encode(t: &Table, token: &str) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let dictionary8 =
        |keys: &[u8], values: &[&str]| -> Result<ArrayRef, arrow_schema::ArrowError> {
            Ok(Arc::new(DictionaryArray::<UInt8Type>::try_new(
                UInt8Array::from(keys.to_vec()),
                Arc::new(StringArray::from(values.to_vec())),
            )?))
        };
    let point = Arc::new(Field::new("xy", DataType::Float32, false));
    let points = FixedSizeListArray::new(
        point.clone(),
        2,
        Arc::new(Float32Array::from_iter_values(
            t.points.iter().flatten().copied(),
        )),
        None,
    );
    let ring = Arc::new(Field::new(
        "point",
        DataType::FixedSizeList(point, 2),
        false,
    ));
    let rings = ListArray::new(
        ring.clone(),
        OffsetBuffer::new(ScalarBuffer::from(t.point_start.clone())),
        Arc::new(points),
        None,
    );
    let row = Arc::new(Field::new("ring", DataType::List(ring), false));
    let rows = ListArray::new(
        row,
        OffsetBuffer::new(ScalarBuffer::from(t.ring_start.clone())),
        Arc::new(rings),
        None,
    );
    let kinds: Vec<&str> = t.kinds.iter().map(String::as_str).collect();
    let columns: Vec<(&str, ArrayRef)> = vec![
        ("osm_id", Arc::new(Float64Array::from(t.osm_id.clone()))),
        ("osm_type", dictionary8(&t.osm_type, &OSM_TYPES)?),
        (
            "kind",
            Arc::new(DictionaryArray::<UInt16Type>::try_new(
                UInt16Array::from(t.kind.clone()),
                Arc::new(StringArray::from(kinds)),
            )?),
        ),
        ("is_part", Arc::new(UInt8Array::from(t.is_part.clone()))),
        ("height", Arc::new(Float32Array::from(t.height.clone()))),
        (
            "min_height",
            Arc::new(Float32Array::from(t.min_height.clone())),
        ),
        ("base", Arc::new(Float32Array::from(t.base.clone()))),
        (
            "height_source",
            dictionary8(&t.height_source, &HEIGHT_SOURCES)?,
        ),
        ("levels", Arc::new(Float32Array::from(t.levels.clone()))),
        (
            "min_level",
            Arc::new(Float32Array::from(t.min_level.clone())),
        ),
        ("roof_shape", dictionary8(&t.roof_shape, &ROOF_SHAPES)?),
        ("rings", Arc::new(rows)),
    ];
    let metadata = HashMap::from([
        ("cell".to_string(), format!("\"{token}\"")),
        (
            "buildingsVersion".to_string(),
            BUILDINGS_VERSION.to_string(),
        ),
    ]);
    let schema = Arc::new(Schema::new_with_metadata(
        columns
            .iter()
            .map(|(name, a)| Field::new(*name, a.data_type().clone(), false))
            .collect::<Vec<_>>(),
        metadata,
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

/// Twice a ring's signed area (open ring, every edge including the closing one): positive when counterclockwise, as
/// the TS signedArea2.
fn signed_area2(xy: &[[f64; 2]]) -> f64 {
    let mut s = 0.0;
    let mut j = xy.len() - 1;
    for i in 0..xy.len() {
        s += xy[j][0] * xy[i][1] - xy[i][0] * xy[j][1];
        j = i;
    }
    s
}
