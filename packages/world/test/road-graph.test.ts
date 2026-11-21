import { describe, expect, it } from "vitest";
import {
  buildRoadGraph, componentSizes, roadGraphFromArrow, roadGraphToArrow, type RoadWayInput,
  enuFrame, enuProjection, enuUnprojection,
} from "../src/index.ts";

const origin = enuProjection(enuFrame({ lat: 0, lon: 0, h: 0 }));
const M = 111.2;  // m per unit
const toLonLat = enuUnprojection(enuFrame({ lat: 0, lon: 0, h: 0 }));

const road = (osmWayId: number, nodeIds: number[], coords: [number, number][], extra: Partial<RoadWayInput> = {}): RoadWayInput => ({
  osmWayId, nodeIds, points: coords.map(([x, y]) => toLonLat(x * M, y * M)),
  class: "residential", name: null, lanesFwd: 1, lanesBack: 1, speedLimitMps: 11, ...extra,
});

// A plus-shaped intersection at node 5:
//
//        2
//        |
//   4 -- 5 -- 6
//        |
//        8
const plus = [
  road(100, [4, 5, 6], [[-1, 0], [0, 0], [1, 0]], { name: "East St" }),
  road(200, [2, 5, 8], [[0, 1], [0, 0], [0, -1]], { name: "North St" }),
];

const edgeTriples = (g: ReturnType<typeof buildRoadGraph>) =>
  Array.from({ length: g.edges.count }, (_, i) => [
    g.edges.osmWayId[i], g.nodes.osmId[g.edges.from[i]!], g.nodes.osmId[g.edges.to[i]!],
  ]);

describe("buildRoadGraph", () => {
  it("cuts ways into edges at shared nodes", () => {
    const g = buildRoadGraph(plus, origin);
    expect(g.nodes.count).toBe(5);
    expect(edgeTriples(g)).toEqual([[100, 4, 5], [100, 5, 6], [200, 2, 5], [200, 5, 8]]);
  });

  it("does not create nodes where only one way passes", () => {
    const g = buildRoadGraph([road(1, [1, 2, 3], [[0, 0], [1, 0], [2, 0]])], origin);
    expect(g.nodes.count).toBe(2);
    expect(g.edges.count).toBe(1);
    expect(g.edges.pointStart).toEqual(new Int32Array([0, 3]));
  });

  it("projects to meters and measures edge length along the points", () => {
    const g = buildRoadGraph([road(1, [1, 2, 3], [[0, 0], [1, 0], [1, 1]])], origin);
    expect(g.nodes.x[0]).toBe(0);
    expect(g.nodes.x[1]).toBeCloseTo(111.2, 1);
    expect(g.edges.length[0]).toBeCloseTo(2 * 111.2, 0);
  });

  it("lists each node's incident edges", () => {
    const g = buildRoadGraph(plus, origin);
    const center = Array.from(g.nodes.osmId).indexOf(5);
    const incident = g.nodes.edgeList.slice(g.nodes.edgeStart[center], g.nodes.edgeStart[center + 1]);
    expect([...incident].sort()).toEqual([0, 1, 2, 3]);
  });

  it("deduplicates names, with 0 meaning unnamed", () => {
    const g = buildRoadGraph([...plus, road(300, [6, 9], [[1, 0], [2, 0]])], origin);
    expect(g.names).toEqual(["", "East St", "North St"]);
    expect([...g.edges.name]).toEqual([1, 1, 2, 2, 0]);
  });

  it("keeps one-way direction", () => {
    const g = buildRoadGraph([road(1, [2, 1], [[1, 0], [0, 0]], { lanesFwd: 2, lanesBack: 0 })], origin);
    expect(edgeTriples(g)).toEqual([[1, 2, 1]]);
    expect(g.edges.lanesBack[0]).toBe(0);
  });

  it("counts connected components", () => {
    const g = buildRoadGraph([...plus, road(300, [10, 11], [[5, 5], [6, 5]])], origin);
    expect(componentSizes(g)).toEqual([5, 2]);
  });
});

describe("road graph Arrow files", () => {
  // Odd sizes on purpose: 3 edges of uint8 columns force padding between buffers.
  const graph = buildRoadGraph([...plus.slice(0, 1), road(300, [6, 9], [[1, 0], [2, 0]], { name: "Ünïcode Ave" })], origin);

  it("round-trips the graph and metadata", () => {
    const { graph: back, metadata } = roadGraphFromArrow(roadGraphToArrow(graph, { cell: "89c25", version: 1 }));
    expect(metadata).toEqual({ cell: "89c25", version: 1 });
    expect(back).toEqual(graph);
  });

  it("reads numeric columns as views onto the file bytes", () => {
    const files = roadGraphToArrow(graph, {});
    const { graph: back } = roadGraphFromArrow(files);
    const views: [ArrayBufferView, Uint8Array][] = [
      [back.nodes.x, files.nodes], [back.nodes.edgeStart, files.nodes], [back.nodes.edgeList, files.nodes],
      [back.edges.from, files.edges], [back.edges.class, files.edges], [back.edges.pointStart, files.edges],
      [back.points, files.edges],
    ];
    for (const [view, file] of views) expect(view.buffer).toBe(file.buffer);
  });

  it("is byte-for-byte reproducible", () => {
    const a = roadGraphToArrow(buildRoadGraph(plus, origin), { v: 1 });
    const b = roadGraphToArrow(buildRoadGraph(plus, origin), { v: 1 });
    expect(a).toEqual(b);
  });

  it("rejects files with the wrong schema", () => {
    const files = roadGraphToArrow(graph, {});
    expect(() => roadGraphFromArrow({ nodes: files.nodes, edges: files.nodes })).toThrow(/missing column/);
  });
});
