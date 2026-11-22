import { describe, expect, it } from "vitest";
import {
  buildRoadGraph, edgeExtents, edgeHalfWidth, enuFrame, enuProjection, enuUnprojection, nodeRadii, SIDEWALK,
  type RoadWayInput,
} from "../src/index.ts";

const M = 111.195; // m per unit
const toLonLat = enuUnprojection(enuFrame({ lat: 0, lon: 0, h: 0 }));
const road = (osmWayId: number, nodeIds: number[], coords: [number, number][], extra: Partial<RoadWayInput> = {}): RoadWayInput => ({
  osmWayId, nodeIds, points: coords.map(([x, y]) => toLonLat(x * M, y * M)),
  class: "residential", name: null, lanesFwd: 1, lanesBack: 1, speedLimitMps: 11, ...extra,
});
const graphOf = (...ways: RoadWayInput[]) => buildRoadGraph(ways, enuProjection(enuFrame({ lat: 0, lon: 0, h: 0 })));

describe("road widths", () => {
  it("are lanes × lane width plus shoulders", () => {
    const g = graphOf(
      road(1, [1, 2], [[0, 0], [1, 0]]),                                            // residential 1+1
      road(2, [3, 4], [[0, 1], [1, 1]], { class: "primary", lanesFwd: 2, lanesBack: 2 }),
      road(3, [5, 6], [[0, 2], [1, 2]], { class: "service", lanesBack: 0 }),
    );
    expect([0, 1, 2].map((e) => edgeHalfWidth(g, e))).toEqual([3 + 1, 2 * 3.4 + 1, 1.4 + 0.2].map((v) => expect.closeTo(v, 6)));
  });

  it("gives each node a disc as wide as its widest road", () => {
    const g = graphOf(
      road(1, [1, 2, 3], [[-1, 0], [0, 0], [1, 0]], { class: "primary", lanesFwd: 2, lanesBack: 2 }),
      road(2, [4, 2], [[0, 1], [0, 0]]),
    );
    const r = nodeRadii(g);
    const hub = Array.from(g.nodes.osmId).indexOf(2);
    expect(r[hub]).toBeCloseTo(7.8, 5);
    expect(r[Array.from(g.nodes.osmId).indexOf(4)]).toBeCloseTo(4, 5);
  });
});

describe("sidewalks", () => {
  // A 100 m east-west street with a north-south street crossing at x = 50 m.
  const M1 = 1 / M;
  const g = graphOf(
    road(1, [1, 2, 3], [[0, 0], [50 * M1, 0], [100 * M1, 0]], { sidewalks: 3 }),
    road(2, [4, 2, 5], [[50 * M1, -50 * M1], [50 * M1, 0], [50 * M1, 50 * M1]], { sidewalks: 2 }),
  );

  it("widen what draping covers on their side only", () => {
    const hw = edgeHalfWidth(g, 0);
    expect(edgeExtents(g, 0)).toEqual([hw + SIDEWALK.width, hw + SIDEWALK.width]);
    const e = [...g.edges.osmWayId].indexOf(2);
    expect(edgeExtents(g, e)).toEqual([edgeHalfWidth(g, e), edgeHalfWidth(g, e) + SIDEWALK.width]);
  });
});
