import { describe, expect, it } from "vitest";
import { assembleRings, buildingHeights, buildingKind, extractBuildings, parseHeight, type OsmElement } from "../src/index.ts";

describe("parseHeight", () => {
  it.each([
    ["12", 12], ["12.5", 12.5], ["12 m", 12], ["12m", 12], ["7,5", 7.5],
    ["40'", 12.192], ["40 ft", 12.192], ["12'6\"", 3.81],
  ])("%s → %d m", (v, m) => expect(parseHeight(v)).toBeCloseTo(m, 3));

  it.each(["", "tall", "-3", "0", "12 storeys"])("rejects %j", (v) => expect(parseHeight(v)).toBeUndefined());
});

describe("buildingKind", () => {
  it("prefers building over building:part and ignores 'no'", () => {
    expect(buildingKind({ building: "house" })).toEqual({ kind: "house", isPart: false });
    expect(buildingKind({ "building:part": "yes" })).toEqual({ kind: "yes", isPart: true });
    expect(buildingKind({ building: "no" })).toBeUndefined();
    expect(buildingKind({ highway: "residential" })).toBeUndefined();
  });
});

describe("buildingHeights", () => {
  it("uses height, then levels, then a default by kind", () => {
    expect(buildingHeights({ height: "20", "building:levels": "3" }, "office")).toMatchObject({ height: 20, heightSource: "height", levels: 3 });
    expect(buildingHeights({ "building:levels": "4" }, "apartments")).toMatchObject({ height: 12, heightSource: "levels" });
    expect(buildingHeights({}, "garage")).toMatchObject({ height: 3, heightSource: "default" });
    expect(buildingHeights({}, "spaceship")).toMatchObject({ height: 6, heightSource: "default" });
  });

  it("lifts the bottom with min_height or min_level", () => {
    expect(buildingHeights({ height: "50", min_height: "30" }, "yes")).toMatchObject({ height: 50, minHeight: 30 });
    expect(buildingHeights({ "building:levels": "10", "building:min_level": "5" }, "yes")).toMatchObject({ height: 45, minHeight: 15 });
    expect(buildingHeights({ height: "10", min_height: "12" }, "yes")).toMatchObject({ height: 10, minHeight: 0 });
  });
});

describe("assembleRings", () => {
  it("joins split ways, reversing as needed, and drops open chains", () => {
    const rings = assembleRings([[1, 2, 3], [5, 4, 3], [5, 6, 1], [10, 11]]);
    expect(rings).toHaveLength(1);
    expect(new Set(rings[0])).toEqual(new Set([1, 2, 3, 4, 5, 6]));
    expect(rings[0]![0]).toBe(rings[0]!.at(-1));
  });
});

describe("extractBuildings", () => {
  const node = (id: number, lon: number, lat: number): OsmElement => ({ type: "node", id, lon, lat });
  const elements: OsmElement[] = [
    // a 10×10 square with a 2×2 hole, plus a separate square
    node(1, 0, 0), node(2, 10, 0), node(3, 10, 10), node(4, 0, 10),
    node(5, 4, 4), node(6, 6, 4), node(7, 6, 6), node(8, 4, 6),
    node(9, 20, 0), node(10, 21, 0), node(11, 21, 1),
    { type: "way", id: 100, nodes: [1, 2, 3] },
    { type: "way", id: 101, nodes: [3, 4, 1] },
    { type: "way", id: 102, nodes: [5, 6, 7, 8, 5] },
    { type: "relation", id: 500, tags: { type: "multipolygon", building: "school", "building:levels": "2" }, members: [
      { type: "way", ref: 100, role: "outer" }, { type: "way", ref: 101, role: "outer" }, { type: "way", ref: 102, role: "inner" },
    ] },
    { type: "way", id: 200, nodes: [9, 10, 11, 9], tags: { building: "shed", name: "Shed" } },
    { type: "way", id: 201, nodes: [9, 10, 11], tags: { building: "yes" } },        // not closed
    { type: "way", id: 202, nodes: [9, 10, 99, 9], tags: { building: "yes" } },     // missing node
    { type: "way", id: 203, nodes: [9, 10, 11, 9], tags: { "building:part": "yes", height: "4" } },
  ];
  const { buildings, stats } = extractBuildings(elements);

  it("extracts ways and multipolygons, with holes attached to their outer ring", () => {
    const school = buildings.find((b) => b.osmType === "relation")!;
    expect(school).toMatchObject({ osmId: 500, kind: "school", height: 6, heightSource: "levels" });
    expect(school.polygons).toHaveLength(1);
    expect(school.polygons[0]).toHaveLength(2);
    expect(school.polygons[0]![1]![0]).toEqual([4, 4]);
    expect(buildings.find((b) => b.osmId === 200)).toMatchObject({ kind: "shed", name: "Shed", height: 2.5, isPart: false });
    expect(buildings.find((b) => b.osmId === 203)).toMatchObject({ isPart: true, height: 4, heightSource: "height" });
  });

  it("counts what it skipped", () => {
    expect(stats).toEqual({ buildings: 2, parts: 1, byHeightSource: { height: 1, levels: 1, default: 1 }, skipped: 2 });
  });
});
