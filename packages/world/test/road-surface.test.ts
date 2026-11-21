import { describe, expect, it } from "vitest";
import {
  buildRoadGraph, edgeHalfWidth, enuFrame, enuProjection, enuUnprojection, MARKING, nodeRadii, roadSurfaceMesh, SurfaceMaterial,
  type RoadWayInput, type SurfaceMesh,
} from "../src/index.ts";

const M = 111.195; // m per unit
const toLonLat = enuUnprojection(enuFrame({ lat: 0, lon: 0, h: 0 }));
const road = (osmWayId: number, nodeIds: number[], coords: [number, number][], extra: Partial<RoadWayInput> = {}): RoadWayInput => ({
  osmWayId, nodeIds, points: coords.map(([x, y]) => toLonLat(x * M, y * M)),
  class: "residential", name: null, lanesFwd: 1, lanesBack: 1, speedLimitMps: 11, ...extra,
});
const graphOf = (...ways: RoadWayInput[]) => buildRoadGraph(ways, enuProjection(enuFrame({ lat: 0, lon: 0, h: 0 })));

/** Vertices of one material as [x, y] pairs. */
function verts(m: SurfaceMesh, mat: SurfaceMaterial): [number, number][] {
  const out: [number, number][] = [];
  for (let v = 0; v < m.material.length; v++) if (m.material[v] === mat) out.push([m.positions[2 * v]!, m.positions[2 * v + 1]!]);
  return out;
}

/** Total area of the triangles of one material. */
function area(m: SurfaceMesh, mat: SurfaceMaterial): number {
  let s = 0;
  for (let i = 0; i < m.indices.length; i += 3) {
    const [a, b, c] = [m.indices[i]!, m.indices[i + 1]!, m.indices[i + 2]!];
    if (m.material[a] !== mat) continue;
    const ax = m.positions[2 * a]!, ay = m.positions[2 * a + 1]!;
    s += Math.abs((m.positions[2 * b]! - ax) * (m.positions[2 * c + 1]! - ay) - (m.positions[2 * c]! - ax) * (m.positions[2 * b + 1]! - ay)) / 2;
  }
  return s;
}

describe("road widths", () => {
  it("are lanes × lane width plus shoulders", () => {
    const g = graphOf(
      road(1, [1, 2], [[0, 0], [1, 0]]),                                            // residential 1+1
      road(2, [3, 4], [[0, 1], [1, 1]], { class: "primary", lanesFwd: 2, lanesBack: 2 }),
      road(3, [5, 6], [[0, 2], [1, 2]], { class: "service", lanesBack: 0 }),
    );
    expect([0, 1, 2].map((e) => edgeHalfWidth(g, e))).toEqual([3 + 1, 2 * 3.4 + 1, 1.4 + 0.2].map((v) => expect.closeTo(v, 6)));
  });

  it("make a ribbon of the right size, with discs at the ends", () => {
    const g = graphOf(road(1, [1, 2], [[0, 0], [1, 0]]));
    const m = roadSurfaceMesh(g);
    const ys = verts(m, SurfaceMaterial.Asphalt).map(([, y]) => y);
    expect(Math.max(...ys)).toBeCloseTo(4, 4);
    expect(Math.min(...ys)).toBeCloseTo(-4, 4);
    // ribbon (M × 8) plus two 16-gon discs of radius 4 that overlap it
    const disc = 16 * 0.5 * 16 * Math.sin((2 * Math.PI) / 16);
    expect(area(m, SurfaceMaterial.Asphalt)).toBeCloseTo(M * 8 + 2 * disc, 0);
  });

  it("keeps the width through a bend (miter)", () => {
    const g = graphOf(road(1, [1, 2, 3], [[0, 0], [1, 0], [1, 1]]));
    const corner = verts(roadSurfaceMesh(g), SurfaceMaterial.Asphalt)
      .filter(([x, y]) => Math.hypot(x - M, y) < 10 && Math.hypot(x - M, y) > 4.5);
    // The outer and inner miter points are 4·√2 from the corner.
    expect(corner.length).toBe(2);
    for (const [x, y] of corner) expect(Math.hypot(x - M, y)).toBeCloseTo(4 * Math.SQRT2, 3);
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

describe("markings", () => {
  it("are left off residential streets", () => {
    const m = roadSurfaceMesh(graphOf(road(1, [1, 2], [[0, 0], [1, 0]])));
    expect(verts(m, SurfaceMaterial.Yellow).length + verts(m, SurfaceMaterial.White).length).toBe(0);
  });

  it("put a double yellow line on the center of a two-way road", () => {
    const g = graphOf(road(1, [1, 2], [[0, 0], [1, 0]], { class: "primary" }));
    const ys = [...new Set(verts(roadSurfaceMesh(g), SurfaceMaterial.Yellow).map(([, y]) => +y.toFixed(3)))].sort((a, b) => a - b);
    const w = MARKING.width, h = MARKING.doubleGap / 2;
    expect(ys).toEqual([-h - w, -h, h, h + w].map((v) => expect.closeTo(v, 3)));
  });

  it("put dashed white lines between same-direction lanes, offset for uneven lanes", () => {
    // 2 forward + 1 back: the center line sits half a lane left of the middle.
    const g = graphOf(road(1, [1, 2], [[0, 0], [1, 0]], { class: "secondary", lanesFwd: 2, lanesBack: 1 }));
    const m = roadSurfaceMesh(g);
    const yellowMid = verts(m, SurfaceMaterial.Yellow).reduce((s, [, y]) => s + y, 0) / verts(m, SurfaceMaterial.Yellow).length;
    expect(yellowMid).toBeCloseTo(3.4 / 2, 3);  // y up = left of eastbound travel
    const white = verts(m, SurfaceMaterial.White);
    const whiteMid = white.reduce((s, [, y]) => s + y, 0) / white.length;
    expect(whiteMid).toBeCloseTo(3.4 / 2 - 3.4, 3);  // one lane to the right of center
    // dash area ≈ dashes × 3 m × width over the trimmed length
    const run = M - 2 * (nodeRadii(g)[0]! + MARKING.intersectionClear);
    const dashes = Math.floor((run - MARKING.dash) / (MARKING.dash + MARKING.gap)) + 1;
    expect(area(m, SurfaceMaterial.White)).toBeCloseTo(dashes * MARKING.dash * MARKING.width, 4);
  });

  it("have no yellow on one-way roads", () => {
    const m = roadSurfaceMesh(graphOf(road(1, [1, 2], [[0, 0], [1, 0]], { class: "primary", lanesFwd: 3, lanesBack: 0 })));
    expect(verts(m, SurfaceMaterial.Yellow).length).toBe(0);
    expect(verts(m, SurfaceMaterial.White).length).toBeGreaterThan(0);
  });

  it("stop short of intersections but run through plain joints", () => {
    const g = graphOf(
      road(1, [1, 2, 3], [[-1, 0], [0, 0], [1, 0]], { class: "primary" }),
      road(2, [4, 2, 5], [[0, 1], [0, 0], [0, -1]], { class: "primary" }),
      road(3, [3, 6], [[1, 0], [2, 0]], { class: "primary" }),  // continues road 1: node 3 has degree 2
    );
    const yellow = verts(roadSurfaceMesh(g), SurfaceMaterial.Yellow);
    const clear = nodeRadii(g)[Array.from(g.nodes.osmId).indexOf(2)]! + MARKING.intersectionClear;
    expect(Math.min(...yellow.map(([x, y]) => Math.hypot(x, y)))).toBeGreaterThanOrEqual(clear - 1e-3);
    expect(yellow.some(([x, y]) => Math.abs(x - M) < 0.01 && Math.abs(y) < 0.5)).toBe(true);
  });
});

describe("roadSurfaceMesh", () => {
  it("is deterministic and emits asphalt before markings", () => {
    const g = graphOf(
      road(1, [1, 2, 3], [[-1, 0], [0, 0], [1, 0]], { class: "primary" }),
      road(2, [4, 2, 5], [[0, 1], [0, 0], [0, -1]]),
    );
    const a = roadSurfaceMesh(g), b = roadSurfaceMesh(g);
    expect(a.positions).toEqual(b.positions);
    expect(a.indices).toEqual(b.indices);
    let seenMarking = false;
    for (let i = 0; i < a.indices.length; i++) {
      const isMarking = a.material[a.indices[i]!] !== SurfaceMaterial.Asphalt;
      if (seenMarking) expect(isMarking).toBe(true);
      seenMarking ||= isMarking;
    }
    expect(seenMarking).toBe(true);
  });
});
