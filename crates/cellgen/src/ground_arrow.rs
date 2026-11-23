//! The ground mesh as Apache Arrow IPC files, like the other cell tables (one record batch per file, no nulls, so every
//! column is one contiguous buffer the viewer reads as a typed-array view):
//!
//!   ground.arrow (a row per vertex)            ground_triangles.arrow (a row per triangle)
//!   position  fixed_size_list<float32, 3>       vertices  fixed_size_list<uint16, 3> (under 65,536 vertices)
//!   normal    fixed_size_list<int8, 4>                    fixed_size_list<uint32, 3> (otherwise)
//!   material  uint8
//!
//! Normals are × 127 with a zero fourth (as the GPU takes them: normalized bytes, four to a vertex). Positions and
//! normals are in the cell's ENU frame (x east, y north, z up, from its center on the ellipsoid, as the
//! TS cellFrame). Triangles are sorted by material; the schema metadata (values JSON-encoded) holds the cell's token,
//! the frame's origin, the materials' names, and each material's range of triangles (for a coarse tile's buildings,
//! each fine cell's range instead: [child, first triangle, triangles], child 0..64 within the tile).

use crate::mesh::Mesh;
use arrow_array::{
    ArrayRef, FixedSizeListArray, Float32Array, Int8Array, RecordBatch, UInt8Array, UInt16Array,
    UInt32Array,
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

    let list = |name: &str, item: &str, values: ArrayRef, size: i32| -> (Field, ArrayRef) {
        let item = Arc::new(Field::new(item, values.data_type().clone(), false));
        let array = FixedSizeListArray::new(item.clone(), size, values, None);
        (
            Field::new(name, DataType::FixedSizeList(item, size), false),
            Arc::new(array),
        )
    };
    let (position, positions) = list(
        "position",
        "xyz",
        Arc::new(Float32Array::from_iter_values(
            mesh.positions.iter().flatten().copied(),
        )),
        3,
    );
    let (normal, normals) = list(
        "normal",
        "xyz0",
        Arc::new(Int8Array::from_iter_values(
            mesh.normals.iter().flatten().copied(),
        )),
        4,
    );
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

    let indices: ArrayRef = if mesh.positions.len() <= 1 << 16 {
        Arc::new(UInt16Array::from_iter_values(
            mesh.indices.iter().map(|&i| i as u16),
        ))
    } else {
        Arc::new(UInt32Array::from(mesh.indices.clone()))
    };
    let (vertices, vertex_lists) = list("vertices", "v", indices, 3);
    let triangles = table(vec![vertices], vec![vertex_lists], metadata)?;
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
