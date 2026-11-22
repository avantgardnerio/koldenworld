import { describe, expect, it } from "vitest";
import { buildRoadGraph, edgeHalfWidth, enuFrame, enuProjection, enuUnprojection, SIGN_SETBACK, signText, streetSigns, type RoadWayInput } from "../src/index.ts";

const frame = enuFrame({ lat: 39.74, lon: -104.99, h: 0 }), ll = enuUnprojection(frame);
const road = (id: number, nodes: number[], pts: [number, number][], name: string | null): RoadWayInput => ({
  osmWayId: id, nodeIds: nodes, points: pts.map(([x, y]) => ll(x, y)), class: "residential", name,
  lanesFwd: 1, lanesBack: 1, speedLimitMps: 11,
});

describe("streetSigns", () => {
  it("puts one sign at a crossing, on its south-east corner, behind the curb, with a blade along each street", () => {
    const g = buildRoadGraph([
      road(1, [1, 2, 3], [[-100, 0], [0, 0], [100, 0]], "East 7th Avenue"),
      road(2, [4, 2, 5], [[0, -100], [0, 0], [0, 100]], "North Lincoln Street"),
    ], enuProjection(frame));
    const signs = streetSigns(g, () => true);
    expect(signs).toHaveLength(1);
    const [s] = signs, d = edgeHalfWidth(g, 0) + SIGN_SETBACK;
    expect(s!.x).toBeCloseTo(d, 3);
    expect(s!.y).toBeCloseTo(-d, 3);
    expect(s!.blades.map((b) => b.text).sort()).toEqual(["E 7th Ave", "N Lincoln St"]);
  });

  it("skips plain joints, unnamed streets, one street's own junctions, and intersections it doesn't own", () => {
    const cross = (a: string | null, b: string | null) => buildRoadGraph([
      road(1, [1, 2, 3], [[-100, 0], [0, 0], [100, 0]], a), road(2, [4, 2, 5], [[0, -100], [0, 0], [0, 100]], b),
    ], enuProjection(frame));
    expect(streetSigns(cross(null, null), () => true)).toHaveLength(0);
    expect(streetSigns(cross("Colfax", "Colfax"), () => true)).toHaveLength(0);
    expect(streetSigns(cross("Colfax", "Speer"), () => false)).toHaveLength(0);
  });

  it("abbreviates like US street signs", () => {
    expect(signText("North Speer Boulevard")).toBe("N Speer Blvd");
    expect(signText("West Colfax Avenue")).toBe("W Colfax Ave");
  });
});
