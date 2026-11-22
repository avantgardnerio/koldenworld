import { describe, expect, it } from "vitest";
import { AIRCRAFT_KINDS, aircraftKind, aircraftMesh, aircraftMeshes, parseAircraft, tailColor, TAIL_COLORS } from "../src/index.ts";

describe("aircraft models", () => {
  it("builds every kind: closed triangles with unit normals, facing +y, wheels on z = 0, at a plausible size", () => {
    const size: Record<string, [number, number]> = {
      narrowbody: [30, 45], widebody: [55, 75], quad: [60, 80], regional: [25, 40], bizjet: [15, 25],
      turboprop: [20, 30], light: [7, 10], helicopter: [10, 16],
    };
    for (const kind of AIRCRAFT_KINDS) {
      const m = aircraftMesh(kind, 0);
      expect(m.indices.length % 3, kind).toBe(0);
      expect(m.indices.length / 3, kind).toBeLessThan(800);  // low poly, like the cars
      const xs: number[] = [], ys: number[] = [], zs: number[] = [];
      for (let i = 0; i < m.positions.length; i += 3) {
        xs.push(m.positions[i]!); ys.push(m.positions[i + 1]!); zs.push(m.positions[i + 2]!);
        expect(Math.hypot(m.normals[i]!, m.normals[i + 1]!, m.normals[i + 2]!)).toBeCloseTo(1, 4);
      }
      const length = Math.max(...ys) - Math.min(...ys);
      expect(length, kind).toBeGreaterThan(size[kind]![0]);
      expect(length, kind).toBeLessThan(size[kind]![1]);
      expect(Math.min(...zs), kind).toBeCloseTo(0, 3);
      expect(Math.max(...xs) + Math.min(...xs), kind).toBeCloseTo(0, 3);  // symmetric
      // The nose is forward: the cockpit glass sits in front of the middle.
      expect(Math.max(...ys), kind).toBeGreaterThan(-Math.min(...ys) * 0.5);
    }
    expect(aircraftMeshes()).toHaveLength(AIRCRAFT_KINDS.length * TAIL_COLORS);
  });
});

describe("aircraft kinds", () => {
  it("maps ICAO types to kinds, falling back on the ADS-B category", () => {
    expect(aircraftKind("B38M", "A3")).toBe("narrowbody");
    expect(aircraftKind("A21N", "A3")).toBe("narrowbody");
    expect(aircraftKind("E75L", "A3")).toBe("narrowbody");
    expect(aircraftKind("B789", "A5")).toBe("widebody");
    expect(aircraftKind("B744", "A5")).toBe("quad");
    expect(aircraftKind("CRJ7", "A3")).toBe("regional");
    expect(aircraftKind("GL5T", "A2")).toBe("bizjet");
    expect(aircraftKind("C25B", "A2")).toBe("bizjet");
    expect(aircraftKind("DH8D", "A2")).toBe("turboprop");
    expect(aircraftKind("PC12", "A1")).toBe("turboprop");
    expect(aircraftKind("C172", "A1")).toBe("light");
    expect(aircraftKind("PA44", "A1")).toBe("light");
    expect(aircraftKind("EC45", "A7")).toBe("helicopter");
    expect(aircraftKind(undefined, "A7")).toBe("helicopter");
    expect(aircraftKind(undefined, "C1")).toBeUndefined();  // an airport truck
  });

  it("gives an airline's planes one tail color", () => {
    expect(tailColor("UAL1234", "a00001")).toBe(tailColor("UAL88", "a99999"));
    expect(tailColor(undefined, "a00001")).toBeLessThan(TAIL_COLORS);
  });
});

describe("parseAircraft", () => {
  const json = {
    ac: [
      { hex: "a23200", flight: "SWA1775 ", t: "B737", category: "A3", lat: 39.7, lon: -105.4, alt_baro: 23150, alt_geom: 23100, gs: 377.4, track: 90, baro_rate: 1664, seen_pos: 0.4 },
      { hex: "a00002", flight: "UAL1 ", t: "B739", category: "A3", lat: 39.85, lon: -104.67, alt_baro: "ground", gs: 12, track: 180 },
      { hex: "a00003", t: "C172", category: "A1", lat: 39.6, lon: -104.8, alt_baro: 8000, gs: 100, track: 0 },  // baro only
      { hex: "a00004", category: "C2", lat: 39.85, lon: -104.67, alt_baro: "ground" },  // a service vehicle
      { hex: "a00005", t: "A320", alt_baro: 5000 },  // no position
    ],
  };

  it("keeps positioned aircraft, in SI units above the ellipsoid", () => {
    const r = parseAircraft(json);
    expect(r.map((a) => a.id)).toEqual(["a23200", "a00002", "a00003"]);
    const [swa, ual, cessna] = r as [typeof r[0], typeof r[0], typeof r[0]];
    expect(swa.callsign).toBe("SWA1775");
    expect(swa.h).toBeCloseTo(23100 * 0.3048, 3);
    expect(swa.speed).toBeCloseTo(377.4 * 1852 / 3600, 3);
    expect(swa.track).toBeCloseTo(Math.PI / 2, 6);
    expect(swa.climb).toBeCloseTo(1664 * 0.3048 / 60, 4);
    expect(swa.age).toBe(0.4);
    expect(ual.ground).toBe(true);
    expect(ual.h).toBeUndefined();
    expect(ual.climb).toBe(0);
    // Barometric only: corrected by the geometric − barometric difference of the others (−50 ft).
    expect(cessna.h).toBeCloseTo((8000 - 50) * 0.3048, 3);
  });
});
