import { describe, expect, it } from "vitest";
import { buildRoadGraph, ROAD_CLASSES, roadLineMesh, type RoadWayInput } from "../src/index.ts";

const D = 0.001;
const road = (osmWayId: number, nodeIds: number[], coords: [number, number][], extra: Partial<RoadWayInput> = {}): RoadWayInput => ({
  osmWayId, nodeIds, points: coords.map(([x, y]) => [x * D, y * D]),
  class: "residential", name: null, lanesFwd: 1, lanesBack: 1, speedLimitMps: 11, ...extra,
});

// A primary road crossed by a residential street with a bend.
const graph = buildRoadGraph([
  road(1, [1, 2, 3], [[-1, 0], [0, 0], [1, 0]], { class: "primary" }),
  road(2, [4, 5, 2, 6], [[0.5, 1], [0, 1], [0, 0], [0, -1]]),
], { lat: 0, lon: 0 });

describe("roadLineMesh", () => {
  const mesh = roadLineMesh(graph);

  it("uses the graph's point buffer without copying", () => {
    expect(mesh.positions).toBe(graph.points);
  });

  it("emits one segment per consecutive point pair, never across edges", () => {
    // primary: 2 edges × 1 segment; residential: edge 4-5-2 (2 segments) + edge 2-6 (1)
    expect(mesh.indices.length).toBe(2 * 5);
    for (let s = 0; s < mesh.indices.length; s += 2) {
      expect(mesh.indices[s + 1]).toBe(mesh.indices[s]! + 1);
    }
  });

  it("draws less important classes first", () => {
    const classes = Array.from({ length: mesh.indices.length / 2 }, (_, s) => mesh.pointClass[mesh.indices[2 * s]!]!);
    expect(classes.map((c) => ROAD_CLASSES[c])).toEqual([
      "residential", "residential", "residential", "primary", "primary",
    ]);
  });

  it("computes bounds in meters", () => {
    expect(mesh.bounds.minX).toBeCloseTo(-111.2, 0);
    expect(mesh.bounds.maxX).toBeCloseTo(111.2, 0);
    expect(mesh.bounds.minY).toBeCloseTo(-111.2, 0);
    expect(mesh.bounds.maxY).toBeCloseTo(111.2, 0);
  });
});
