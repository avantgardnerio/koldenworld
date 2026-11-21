// RoadGraph → line-segment mesh: the simplest drawable form of the road graph.
// A pure function of the graph, so it is tested like any other operator.
//
// Positions are the graph's own point buffer (no copy); each edge's polyline
// contributes one segment (two indices) per consecutive point pair. Segments
// are ordered from least to most important class, so with painter's order the
// major roads draw on top.

import { ROAD_CLASSES, type RoadGraph } from "./road-graph.ts";

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface RoadLineMesh {
  positions: Float32Array;  // x, y, z interleaved, m (z from graph.pointZ)
  dims: 3;
  pointClass: Uint8Array;   // road class per point (index into ROAD_CLASSES)
  indices: Uint32Array;     // segment endpoints, 2 per segment
  bounds: Bounds;
}

export function roadLineMesh(g: RoadGraph): RoadLineMesh {
  const { edges, points } = g;
  const pointCount = points.length / 2;

  const pointClass = new Uint8Array(pointCount);
  let segments = 0;
  for (let e = 0; e < edges.count; e++) {
    const a = edges.pointStart[e]!;
    const b = edges.pointStart[e + 1]!;
    pointClass.fill(edges.class[e]!, a, b);
    segments += b - a - 1;
  }

  // Counting sort of edges by class, least important (highest index) first.
  const classCount = ROAD_CLASSES.length;
  const start = new Uint32Array(classCount + 1);
  for (let e = 0; e < edges.count; e++) {
    start[classCount - edges.class[e]!]! += edges.pointStart[e + 1]! - edges.pointStart[e]! - 1;
  }
  for (let c = 0; c < classCount; c++) start[c + 1]! += start[c]!;

  const indices = new Uint32Array(segments * 2);
  for (let e = 0; e < edges.count; e++) {
    const slot = classCount - 1 - edges.class[e]!;
    let s = start[slot]!;
    for (let p = edges.pointStart[e]!; p < edges.pointStart[e + 1]! - 1; p++, s++) {
      indices[2 * s] = p;
      indices[2 * s + 1] = p + 1;
    }
    start[slot] = s;
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < points.length; i += 2) {
    const x = points[i]!, y = points[i + 1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  const positions = new Float32Array(3 * pointCount);
  for (let p = 0; p < pointCount; p++) {
    positions[3 * p] = points[2 * p]!;
    positions[3 * p + 1] = points[2 * p + 1]!;
    positions[3 * p + 2] = g.pointZ[p]!;
  }
  return { positions, dims: 3, pointClass, indices, bounds: { minX, minY, maxX, maxY } };
}
