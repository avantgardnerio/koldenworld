// A cell's ground from the Rust cell generator (crates/cellgen): every point of the cell one kind of ground
// (asphalt, markings, grass, sidewalk, lot, water), draped on the terrain, as GPU-ready buffers. A coarse tile's
// buildings (massing: walls and roofs) come in the same format, with a child column.
//
//   ground.arrow (a row per vertex)            ground_triangles.arrow (a row per triangle)
//   position  fixed_size_list<float32, 3>       vertices  fixed_size_list<uint16, 3> (under 65,536 vertices)
//   normal    fixed_size_list<int8, 4>                    fixed_size_list<uint32, 3> (otherwise)
//   material  uint8
//   child     uint8 (buildings only: which of the tile's 64 fine cells a vertex's shape is in)
//
// Normals are × 127 with a zero fourth, as the GPU takes them (normalized bytes).
// Positions and normals are in the cell's frame (cellFrame); triangles are counterclockwise from above and sorted by
// material, with each material's range of triangles in the schema metadata.

import { column, readTable, values } from "./arrow-util.ts";

export interface CellGround {
  positions: Float32Array;  // x, y, z, m
  normals: Int8Array;       // x, y, z, 0 per vertex; ×127 (as the building mesh)
  material: Uint8Array;     // index into materials
  shade: Uint8Array;        // no per-vertex variation: all 0
  child?: Uint8Array;       // buildings: which of the tile's 64 fine cells each vertex's shape is in
  indices: Uint16Array | Uint32Array;
  materials: string[];      // "asphalt", "yellow", "white", "grass", "sidewalk", "lot", "water"
  ranges: [material: number, first: number, count: number][];  // in triangles
}

export function groundFromArrow(ground: Uint8Array, triangles: Uint8Array): CellGround {
  const v = readTable(ground, "ground");
  const t = readTable(triangles, "ground_triangles");
  const n = v.table.numRows, m = t.table.numRows;
  const positions = values(column(v.table, "position", "ground").children[0]!, 3 * n, Float32Array, "ground.position");
  const vertices = column(t.table, "vertices", "ground_triangles").children[0]!;
  const child = v.table.getChild("child") ? values(column(v.table, "child", "ground"), n, Uint8Array, "ground.child") : undefined;
  const wide = vertices.values instanceof Uint32Array;
  return {
    positions,
    normals: values(column(v.table, "normal", "ground").children[0]!, 4 * n, Int8Array, "ground.normal"),
    material: values(column(v.table, "material", "ground"), n, Uint8Array, "ground.material"),
    shade: new Uint8Array(n),
    child,
    indices: wide
      ? values(vertices, 3 * m, Uint32Array, "ground_triangles.vertices")
      : values(vertices, 3 * m, Uint16Array, "ground_triangles.vertices"),
    materials: v.metadata.materials as string[],
    ranges: v.metadata.ranges as CellGround["ranges"],
  };
}
