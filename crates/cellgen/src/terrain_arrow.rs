//! terrain.arrow: the ground's heights on the cell's terrain lattice, for what stands on the ground (the viewer's
//! terrainHeightAt: the car, the camera, people, taxiing planes), as the TS terrainToArrow wrote it:
//!
//!   h  float32, (n + 1)² rows (t outer, s inner), m above the WGS84 ellipsoid
//!
//! The schema metadata (values JSON-encoded) holds the cell's token and terrainN (n). The heights are the drawn
//! ground's own lattice (cell::rim_heights), so what stands on the ground meets what's drawn.

use arrow_array::{Float32Array, RecordBatch};
use arrow_ipc::writer::FileWriter;
use arrow_schema::{DataType, Field, Schema};
use std::collections::HashMap;
use std::sync::Arc;

/// terrain.arrow, as bytes, from the (n + 1)² lattice heights.
pub fn encode(
    heights: &[f64],
    n: usize,
    token: &str,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    if heights.len() != (n + 1) * (n + 1) {
        return Err(format!("terrain: {} heights for n = {n}", heights.len()).into());
    }
    let metadata = HashMap::from([
        ("cell".to_string(), format!("\"{token}\"")),
        ("terrainN".to_string(), n.to_string()),
    ]);
    let schema = Arc::new(Schema::new_with_metadata(
        vec![Field::new("h", DataType::Float32, false)],
        metadata,
    ));
    let h = Float32Array::from_iter_values(heights.iter().map(|&h| h as f32));
    let batch = RecordBatch::try_new(schema.clone(), vec![Arc::new(h)])?;
    let mut out = Vec::new();
    let mut writer = FileWriter::try_new(&mut out, &schema)?;
    writer.write(&batch)?;
    writer.finish()?;
    drop(writer);
    Ok(out)
}
