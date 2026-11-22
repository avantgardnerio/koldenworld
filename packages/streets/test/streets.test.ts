import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildGraph, layers, ringArea, ringCount, type WayInput } from "../src/index.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as
  { name: string; lat: number; lon: number; ways: WayInput[] }[];

// Grass then sidewalk, out from the curb.
const GRASS = 1.5, WALK = 1.8;

describe("the Shoshone Street Y (a street forking at 31°, one branch twisting where it's widened)", () => {
  const [scene] = fixture("shoshone-y");
  const g = buildGraph(scene!.ways, scene!.lat, scene!.lon);
  const { V, pavement, bands } = layers(g, [GRASS, WALK]);
  const areas = (loops: typeof pavement.loops) => Array.from({ length: ringCount(loops) }, (_, k) => ringArea(V, loops, k));

  it("unions the streets into one pavement loop, the twist absorbed", () => {
    expect(ringCount(pavement.loops)).toBe(1);
    expect(areas(pavement.loops)[0]).toBeCloseTo(620.83, 1);
  });

  it("pushes the pavement outline out vertex for vertex, so every layer has the same vertices", () => {
    const n = pavement.loops.start[1]!;
    for (const b of bands) expect([ringCount(b.loops), b.loops.start[1]]).toEqual([1, n]);
  });

  it("makes grass and sidewalk bands each one ring (an outer loop and the hole they surround), folds cleaned up", () => {
    for (const b of bands) {
      expect(ringCount(b.result.loops)).toBe(2);
      expect(areas(b.result.loops).filter((a) => a > 0)).toHaveLength(1);
    }
  });

  it("needs no tolerance anywhere: no ties, no disagreements", () => {
    for (const r of [pavement, ...bands.map((b) => b.result)]) expect([r.events.ties, r.events.disagree]).toEqual([0, 0]);
  });
});

describe("Denver's six worst patches for plain street polygons (from a scan of 16,151 streets)", () => {
  for (const scene of fixture("denver-worst")) {
    it(`${scene.name}: pavement, grass and sidewalk with no ties and no disagreements`, () => {
      const { pavement, bands } = layers(buildGraph(scene.ways, scene.lat, scene.lon), [GRASS, WALK]);
      for (const r of [pavement, ...bands.map((b) => b.result)]) {
        expect(ringCount(r.loops)).toBeGreaterThan(0);
        expect([r.events.ties, r.events.disagree]).toEqual([0, 0]);
      }
    });
  }
});
