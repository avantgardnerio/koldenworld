import { describe, expect, it } from "vitest";
import { buildBuildings, enuFrame, enuProjection, enuUnprojection, queryWalls, wallGrid, type BuildingInput } from "../src/index.ts";

const toLonLat = enuUnprojection(enuFrame({ lat: 0, lon: 0, h: 0 }));
const origin = enuProjection(enuFrame({ lat: 0, lon: 0, h: 0 }));
const rect = (x0: number, y0: number, x1: number, y1: number): [number, number][] =>
  [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]].map(([x, y]) => toLonLat(x!, y!));
const b = (osmId: number, ring: [number, number][], minHeight = 0): BuildingInput =>
  ({ osmType: "way", osmId, kind: "house", isPart: minHeight > 0, height: 10, minHeight, heightSource: "height", polygons: [[ring]] });

describe("wall grid", () => {
  // Two 10 m buildings 100 m apart, and an overhang 5 m up (not a wall at street level).
  const g = wallGrid(buildBuildings([b(1, rect(0, 0, 10, 10)), b(2, rect(100, 0, 110, 10)), b(3, rect(50, 50, 60, 60), 5)], origin));
  const near = (x0: number, y0: number, x1: number, y1: number) => {
    const out: number[][] = [];
    queryWalls(g, x0, y0, x1, y1, (ax, ay, bx, by) => out.push([ax, ay, bx, by]));
    return out;
  };

  it("holds every ground-level edge, once", () => {
    expect(g.segments.length / 4).toBe(8);
  });

  it("finds the walls near a box, each once, and none far away", () => {
    expect(near(-2, -2, 12, 12).length).toBe(4);
    expect(near(98, 4, 102, 6).length).toBeGreaterThanOrEqual(1);
    expect(near(40, 40, 70, 70).length).toBe(0);  // the overhang
    expect(near(500, 500, 510, 510).length).toBe(0);
  });
});
