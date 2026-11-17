import { describe, expect, it } from "vitest";
import {
  extractRoadWays, parseMaxspeed, roadAttributes, splitRoadWays, type OsmElement, type Tags,
} from "../src/index.ts";

const node = (id: number, lon: number, lat: number): OsmElement => ({ type: "node", id, lon, lat });
const way = (id: number, nodes: number[], tags: Tags): OsmElement => ({ type: "way", id, nodes, tags });
const segmentsOf = (elements: OsmElement[]) => splitRoadWays(extractRoadWays(elements).ways);

// A plus-shaped intersection at node 5:
//
//        2
//        |
//   4 -- 5 -- 6
//        |
//        8
const plus: OsmElement[] = [
  node(2, 0, 1), node(4, -1, 0), node(5, 0, 0), node(6, 1, 0), node(8, 0, -1),
  way(100, [4, 5, 6], { highway: "residential", name: "East St" }),
  way(200, [2, 5, 8], { highway: "residential", name: "North St" }),
];

describe("extractRoadWays", () => {
  it("keeps drivable ways whole, with node ids and points", () => {
    const { ways, stats } = extractRoadWays(plus);
    expect(stats).toEqual({ roadWays: 2, skippedWays: 0 });
    expect(ways[0]).toMatchObject({ osmWayId: 100, nodeIds: [4, 5, 6], name: "East St" });
    expect(ways[0]!.points).toEqual([[-1, 0], [0, 0], [1, 0]]);
  });

  it("ignores non-road ways", () => {
    const { ways } = extractRoadWays([
      ...plus.filter((e) => e.type === "node"),
      way(100, [4, 5, 6], { highway: "residential" }),
      way(300, [2, 5, 8], { highway: "footway" }),
      way(400, [4, 5, 6], { highway: "pedestrian", area: "yes" }),
    ]);
    expect(ways.map((w) => w.osmWayId)).toEqual([100]);
  });

  it("orders one-way ways in the direction of travel", () => {
    const { ways } = extractRoadWays([
      node(1, 0, 0), node(2, 1, 0),
      way(1, [1, 2], { highway: "secondary", oneway: "-1" }),
    ]);
    expect(ways[0]).toMatchObject({ nodeIds: [2, 1], oneway: true, lanesBack: 0 });
    expect(ways[0]!.points).toEqual([[1, 0], [0, 0]]);
  });

  it("skips ways with missing nodes", () => {
    const { ways, stats } = extractRoadWays([
      node(1, 0, 0),
      way(1, [1, 2], { highway: "residential" }),
    ]);
    expect(ways).toHaveLength(0);
    expect(stats.skippedWays).toBe(1);
  });

  it("drops repeated consecutive nodes", () => {
    const { ways } = extractRoadWays([
      node(1, 0, 0), node(2, 1, 0),
      way(1, [1, 1, 2], { highway: "residential" }),
    ]);
    expect(ways[0]!.nodeIds).toEqual([1, 2]);
  });
});

describe("splitRoadWays", () => {
  it("splits ways at shared nodes", () => {
    const segments = segmentsOf(plus);
    expect(segments.map((s) => [s.osmWayId, s.fromNode, s.toNode])).toEqual([
      [100, 4, 5], [100, 5, 6], [200, 2, 5], [200, 5, 8],
    ]);
    expect(segments[0]!.points).toEqual([[-1, 0], [0, 0]]);
  });

  it("does not split at nodes used by only one way", () => {
    const segments = segmentsOf([
      node(1, 0, 0), node(2, 1, 0), node(3, 2, 0),
      way(1, [1, 2, 3], { highway: "primary" }),
    ]);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.points).toHaveLength(3);
  });

  it("does not let footpaths create intersections", () => {
    const segments = segmentsOf([
      ...plus.filter((e) => e.type === "node"),
      way(100, [4, 5, 6], { highway: "residential" }),
      way(300, [2, 5, 8], { highway: "footway" }),
    ]);
    expect(segments).toHaveLength(1);
  });

  it("keeps one-way segments in the direction of travel", () => {
    const segments = segmentsOf([
      node(1, 0, 0), node(2, 1, 0),
      way(1, [1, 2], { highway: "secondary", oneway: "-1" }),
    ]);
    expect(segments[0]).toMatchObject({ fromNode: 2, toNode: 1 });
  });
});

describe("roadAttributes", () => {
  it("implies one-way for motorways and roundabouts", () => {
    expect(roadAttributes({ highway: "motorway" })).toMatchObject({ oneway: true, lanesFwd: 2, lanesBack: 0 });
    expect(roadAttributes({ highway: "residential", junction: "roundabout" }).oneway).toBe(true);
    expect(roadAttributes({ highway: "motorway", oneway: "no" }).oneway).toBe(false);
  });

  it("splits a two-way lane count", () => {
    expect(roadAttributes({ highway: "primary", lanes: "5" })).toMatchObject({ lanesFwd: 3, lanesBack: 2 });
    expect(roadAttributes({ highway: "residential", lanes: "1" })).toMatchObject({ lanesFwd: 1, lanesBack: 1 });
  });

  it("swaps lanes:forward/backward when reversing", () => {
    const a = roadAttributes({ highway: "primary", oneway: "-1", "lanes:backward": "3" });
    expect(a).toMatchObject({ lanesFwd: 3, lanesBack: 0, reversed: true });
  });

  it("falls back to a default speed by class", () => {
    const a = roadAttributes({ highway: "residential" });
    expect(a.speedLimitFromTag).toBe(false);
    expect(a.speedLimitMps).toBeCloseTo(25 * 0.44704);
  });
});

describe("parseMaxspeed", () => {
  it.each([
    ["25 mph", 25 * 0.44704],
    ["50", 50 / 3.6],
    ["50 km/h", 50 / 3.6],
    ["30;40", 30 / 3.6],
    ["none", undefined],
    ["signals", undefined],
    [undefined, undefined],
  ])("%s", (input, expected) => {
    const got = parseMaxspeed(input);
    if (expected === undefined) expect(got).toBeUndefined();
    else expect(got).toBeCloseTo(expected);
  });
});
