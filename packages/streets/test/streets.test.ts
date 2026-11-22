import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { area, buildGraph, layers, type WayInput } from "../src/index.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as
  { name: string; lat: number; lon: number; ways: WayInput[] }[];

// Grass then sidewalk, out from the curb.
const GRASS = 1.5, WALK = 1.8;

describe("the Shoshone Street Y (a street forking at 31°, one branch twisting where it's widened)", () => {
  const [scene] = fixture("shoshone-y");
  const g = buildGraph(scene!.ways, scene!.lat, scene!.lon);
  const { pavement, bands } = layers(g, [GRASS, WALK]);
  const [grass, walk] = bands.map((b) => b.result);

  it("unions the streets into one pavement loop, the twist absorbed", () => {
    expect(pavement.loops).toHaveLength(1);
    expect(area(pavement.loops[0]!)).toBeCloseTo(620.83, 1);
  });

  it("pushes the pavement outline out vertex for vertex, so every layer has the same vertices", () => {
    expect(bands.map((b) => b.loops.map((l) => l.length))).toEqual([[pavement.loops[0]!.length], [pavement.loops[0]!.length]]);
  });

  it("makes grass and sidewalk bands each one ring (an outer loop and the hole they surround), folds cleaned up", () => {
    for (const band of [grass!, walk!]) {
      expect(band.loops).toHaveLength(2);
      expect(band.loops.map(area).filter((a) => a > 0)).toHaveLength(1);
    }
  });

  it("needs no tolerance anywhere in the bands: no ties, no disagreements", () => {
    for (const band of [grass!, walk!]) expect([band.events.ties, band.events.disagree]).toEqual([0, 0]);
  });

  // The twisted branch used to run an edge exactly through the 31° corner, which the union turned
  // into a second point a few last digits away; sides now start at their corners instead.
  it("needs no tolerance in the pavement union either", () => {
    expect([pavement.events.ties, pavement.events.disagree]).toEqual([0, 0]);
  });
});

describe("Denver's six worst patches for plain street polygons (from a scan of 16,151 streets)", () => {
  for (const scene of fixture("denver-worst")) {
    it(`${scene.name}: pavement, grass and sidewalk with no ties and no disagreements`, () => {
      const { pavement, bands } = layers(buildGraph(scene.ways, scene.lat, scene.lon), [GRASS, WALK]);
      for (const r of [pavement, ...bands.map((b) => b.result)]) {
        expect(r.loops.length).toBeGreaterThan(0);
        expect([r.tied.length, r.events.disagree]).toEqual([0, 0]);
      }
    });
  }
});
