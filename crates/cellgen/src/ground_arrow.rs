//! The ground mesh as Apache Arrow IPC files, like the other cell tables (one record batch per file, no nulls, so every
//! column is one contiguous buffer the viewer reads as a typed-array view):
//!
//!   ground.arrow (a row per vertex)            ground_triangles.arrow (a row per triangle)
//!   position  fixed_size_list<float32, 3>       vertices  fixed_size_list<uint32, 3>
//!   normal    fixed_size_list<float32, 3>
//!   material  uint8
//!
//! Positions and normals are in the cell's ENU frame (x east, y north, z up, from its center on the ellipsoid, as the
//! TS cellFrame). Triangles are sorted by material; the schema metadata (values JSON-encoded) holds the cell's token,
//! the frame's origin, the materials' names, and each material's range of triangles.

use crate::mesh::Mesh;
use arrow_array::{
    ArrayRef, FixedSizeListArray, Float32Array, RecordBatch, UInt8Array, UInt32Array,
};
use arrow_ipc::writer::FileWriter;
use arrow_schema::{DataType, Field, Schema};
use std::collections::HashMap;
use std::sync::Arc;

/// ground.arrow and ground_triangles.arrow, as bytes. `kinds` names the materials; `origin` is the frame's (lat, lon)
/// on the ellipsoid.
pub fn encode(
    mesh: &Mesh,
    kinds: &[&str],
    token: &str,
    origin: (f64, f64),
) -> Result<(Vec<u8>, Vec<u8>), Box<dyn std::error::Error>> {
    let ranges: Vec<[u32; 3]> = mesh
        .ranges
        .iter()
        .map(|r| [r[0], r[1] / 3, r[2] / 3])
        .collect();
    let metadata = HashMap::from([
        ("cell".to_string(), format!("\"{token}\"")),
        (
            "frame".to_string(),
            format!("{{\"lat\":{},\"lon\":{},\"h\":0}}", origin.0, origin.1),
        ),
        (
            "materials".to_string(),
            format!(
                "[{}]",
                kinds
                    .iter()
                    .map(|k| format!("\"{k}\""))
                    .collect::<Vec<_>>()
                    .join(",")
            ),
        ),
        (
            "ranges".to_string(),
            format!(
                "[{}]",
                ranges
                    .iter()
                    .map(|r| format!("[{},{},{}]", r[0], r[1], r[2]))
                    .collect::<Vec<_>>()
                    .join(",")
            ),
        ),
    ]);

    let vec3 = |name: &str, v: &[[f32; 3]]| -> (Field, ArrayRef) {
        let item = Arc::new(Field::new("xyz", DataType::Float32, false));
        let values = Float32Array::from(v.iter().flatten().copied().collect::<Vec<f32>>());
        let array = FixedSizeListArray::new(item.clone(), 3, Arc::new(values), None);
        (
            Field::new(name, DataType::FixedSizeList(item, 3), false),
            Arc::new(array),
        )
    };
    let (position, positions) = vec3("position", &mesh.positions);
    let (normal, normals) = vec3("normal", &mesh.normals);
    let material: ArrayRef = Arc::new(UInt8Array::from(mesh.material.clone()));
    let ground = table(
        vec![
            position,
            normal,
            Field::new("material", DataType::UInt8, false),
        ],
        vec![positions, normals, material],
        metadata.clone(),
    )?;

    let item = Arc::new(Field::new("v", DataType::UInt32, false));
    let list = FixedSizeListArray::new(
        item.clone(),
        3,
        Arc::new(UInt32Array::from(mesh.indices.clone())),
        None,
    );
    let triangles = table(
        vec![Field::new(
            "vertices",
            DataType::FixedSizeList(item, 3),
            false,
        )],
        vec![Arc::new(list)],
        metadata,
    )?;
    Ok((ground, triangles))
}

fn table(
    fields: Vec<Field>,
    columns: Vec<ArrayRef>,
    metadata: HashMap<String, String>,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let schema = Arc::new(Schema::new_with_metadata(fields, metadata));
    let batch = RecordBatch::try_new(schema.clone(), columns)?;
    let mut writer = FileWriter::try_new(Vec::new(), &schema)?;
    writer.write(&batch)?;
    writer.finish()?;
    Ok(writer.into_inner()?)
}
