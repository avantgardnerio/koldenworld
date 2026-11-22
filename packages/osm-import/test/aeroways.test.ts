import { describe, expect, it } from "vitest";
import { aerowayAreaKind, extractAeroways, isAerowayLine, type OsmElement } from "../src/index.ts";

const node = (id: number, lon: number, lat: number): OsmElement => ({ type: "node", id, lon, lat });
const way = (id: number, nodes: number[], tags: Record<string, string>): OsmElement => ({ type: "way", id, nodes, tags });

describe("aeroways", () => {
  it("knows areas from lines", () => {
    expect(aerowayAreaKind({ aeroway: "apron" })).toBe("apron");
    expect(aerowayAreaKind({ aeroway: "runway", area: "yes" })).toBe("runway");
    expect(aerowayAreaKind({ aeroway: "runway" })).toBeUndefined();
    expect(isAerowayLine({ aeroway: "runway" })).toBe(true);
    expect(isAerowayLine({ aeroway: "taxilane" })).toBe(true);
    expect(isAerowayLine({ aeroway: "runway", area: "yes" })).toBe(false);
    expect(isAerowayLine({ aeroway: "gate" })).toBe(false);
  });

  it("extracts runways and taxiways with widths, and closed aprons", () => {
    const els: OsmElement[] = [
      node(1, -104.70, 39.85), node(2, -104.70, 39.89), node(3, -104.69, 39.85), node(4, -104.69, 39.86), node(5, -104.68, 39.86),
      way(10, [1, 2], { aeroway: "runway", ref: "16R/34L", width: "61" }),
      way(11, [3, 4], { aeroway: "taxiway", ref: "B" }),
      way(12, [3, 4], { aeroway: "taxilane" }),
      way(13, [3, 4, 5, 3], { aeroway: "apron" }),
      way(14, [3, 4, 5], { aeroway: "apron" }),  // not closed
      way(15, [1, 99], { aeroway: "runway" }),     // a missing node
    ];
    const { areas, lines, stats } = extractAeroways(els);
    expect(lines.map((l) => [l.osmWayId, l.kind, l.ref, l.width])).toEqual([
      [10, "runway", "16R/34L", 61], [11, "taxiway", "B", 23], [12, "taxiway", null, 15],
    ]);
    expect(areas.map((a) => [a.osmId, a.kind, a.polygons[0]![0]!.length])).toEqual([[13, "apron", 4]]);
    expect(stats.skipped).toBe(2);
  });
});
