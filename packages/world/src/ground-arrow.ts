// A cell's ground from the Rust cell generator (crates/cellgen): every point of the cell one kind of ground
// (asphalt, markings, grass, sidewalk, lot, water), draped on the terrain, as GPU-ready buffers.
//
//   ground.arrow (a row per vertex)            ground_triangles.arrow (a row per triangle)
//   position  fixed_size_list<float32, 3>       vertices  fixed_size_list<uint32, 3>
//   normal    fixed_size_list<float32, 3>
//   material  uint8
//
// Positions and normals are in the cell's frame (cellFrame); triangles are counterclockwise from above and sorted by
// material, with each material's range of triangles in the schema metadata.

import { column, readTable, values } from "./arrow-util.ts";

export interface CellGround {
  positions: Float32Array;  // x, y, z, m
  normals: Int8Array;       // x, y, z, 0 per vertex; ×127 (as the building mesh)
  material: Uint8Array;     // index into materials
  shade: Uint8Array;        // no per-vertex variation: all 0
  indices: Uint32Array;
  materials: string[];      // "asphalt", "yellow", "white", "grass", "sidewalk", "lot", "water"
  ranges: [material: number, first: number, count: number][];  // in triangles
}

export function groundFromArrow(ground: Uint8Array, triangles: Uint8Array): CellGround {
  const v = readTable(ground, "ground");
  const t = readTable(triangles, "ground_triangles");
  const n = v.table.numRows, m = t.table.numRows;
  const positions = values(column(v.table, "position", "ground").children[0]!, 3 * n, Float32Array, "ground.position");
  const normals = values(column(v.table, "normal", "ground").children[0]!, 3 * n, Float32Array, "ground.normal");
  const packed = new Int8Array(4 * n);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) packed[4 * i + k] = Math.round(normals[3 * i + k]! * 127);
  }
  return {
    positions,
    normals: packed,
    material: values(column(v.table, "material", "ground"), n, Uint8Array, "ground.material"),
    shade: new Uint8Array(n),
    indices: values(column(t.table, "vertices", "ground_triangles").children[0]!, 3 * m, Uint32Array, "ground_triangles.vertices"),
    materials: v.metadata.materials as string[],
    ranges: v.metadata.ranges as CellGround["ranges"],
  };
}
