import { describe, expect, it } from "vitest";
import {
  buildRoadGraph, enuFrame, enuProjection, enuUnprojection, HIP, PART, PERSON_HEIGHT, personMesh, placePeople, SHOULDER,
  type RoadWayInput,
} from "../src/index.ts";

describe("placing people", () => {
  const frame = enuFrame({ lat: 0, lon: 0, h: 0 }), ll = enuUnprojection(frame);
  const road = (id: number, nodes: number[], y: number, cls: RoadWayInput["class"], sidewalks: number): RoadWayInput => ({
    osmWayId: id, nodeIds: nodes, points: [ll(0, y), ll(1000, y)], class: cls, name: null,
    lanesFwd: 1, lanesBack: 1, speedLimitMps: 12, sidewalks,
  });
  const g = buildRoadGraph([
    road(1, [1, 2], 0, "primary", 3),        // both sides
    road(2, [3, 4], 100, "residential", 2),  // right only
    road(3, [5, 6], 200, "primary", 0),      // none
  ], enuProjection(frame));

  it("puts people only on sidewalks, more on busier streets, both ways, the same for a seed", () => {
    const p = placePeople(g, 7);
    const on = (e: number, side: number) => [...p.edge].filter((x, i) => x === e && p.side[i] === side).length;
    const [primary, residential, bare] = [0, 1, 2].map((y) => [...Array(g.edges.count).keys()].find((e) => Math.round(g.points[2 * g.edges.pointStart[e]! + 1]!) === 100 * y)!);
    expect(on(primary!, 1)).toBeGreaterThan(15);
    expect(on(primary!, -1)).toBeGreaterThan(15);
    expect(on(residential!, 1)).toBeGreaterThan(5);
    expect(on(residential!, 1)).toBeLessThan(on(primary!, 1));
    expect(on(residential!, -1)).toBe(0);
    expect([...p.edge]).not.toContain(bare);
    expect(new Set(p.dir)).toEqual(new Set([1, -1]));
    for (let i = 0; i < p.count; i++) expect(p.s[i]).toBeLessThan(g.edges.length[p.edge[i]!]!);
    expect(placePeople(g, 7)).toEqual(p);
  });
});

describe("person model", () => {
  it("is low poly, with unit normals, facing +y, feet on z = 0, PERSON_HEIGHT tall, symmetric", () => {
    const m = personMesh();
    expect(m.indices.length % 3).toBe(0);
    expect(m.indices.length / 3).toBeLessThan(300);
    const xs: number[] = [], ys: number[] = [], zs: number[] = [];
    for (let i = 0; i < m.positions.length; i += 3) {
      xs.push(m.positions[i]!); ys.push(m.positions[i + 1]!); zs.push(m.positions[i + 2]!);
      expect(Math.hypot(m.normals[i]!, m.normals[i + 1]!, m.normals[i + 2]!)).toBeCloseTo(1, 4);
    }
    expect(Math.min(...zs)).toBeCloseTo(0, 6);
    expect(Math.max(...zs)).toBeCloseTo(PERSON_HEIGHT, 6);
    expect(Math.max(...xs) + Math.min(...xs)).toBeCloseTo(0, 6);
    // The shoes stick out forward.
    expect(Math.max(...ys)).toBeGreaterThan(-Math.min(...ys));
  });

  it("knows each vertex's part: legs below the hips, arms about the shoulders, on their own sides", () => {
    const m = personMesh();
    expect(m.parts.length).toBe(m.positions.length / 3);
    const seen = new Set<number>();
    for (let v = 0; v < m.parts.length; v++) {
      const [x, z] = [m.positions[3 * v]!, m.positions[3 * v + 2]!], p = m.parts[v]!;
      seen.add(p);
      if (p === PART.leftLeg || p === PART.rightLeg) expect(z).toBeLessThanOrEqual(HIP + 1e-6);
      if (p === PART.leftArm || p === PART.rightArm) expect(z).toBeLessThanOrEqual(SHOULDER + 0.1);
      if (p === PART.leftLeg || p === PART.leftArm) expect(x).toBeLessThan(0);
      if (p === PART.rightLeg || p === PART.rightArm) expect(x).toBeGreaterThan(0);
    }
    expect([...seen].sort()).toEqual(Object.values(PART).sort());
  });
});
