import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildRoadGraph, enuFrame, enuProjection, enuUnprojection, placeVehicles, readGlb, VEHICLE_MODELS, VEHICLE_SCALE,
  type RoadWayInput,
} from "../src/index.ts";

const asset = (name: string) => new Uint8Array(readFileSync(new URL(`../../viewer/assets/vehicles/${name}`, import.meta.url)));

describe("readGlb", () => {
  it("reads every vehicle into one mesh, facing +y, wheels on z = 0, real size", () => {
    for (const name of VEHICLE_MODELS) {
      const m = readGlb(asset(`${name}.glb`), VEHICLE_SCALE);
      expect(m.indices.length % 3, name).toBe(0);
      expect(m.image).toBe("Textures/colormap.png");
      const xs = [], ys = [], zs = [];
      for (let i = 0; i < m.positions.length; i += 3) { xs.push(m.positions[i]!); ys.push(m.positions[i + 1]!); zs.push(m.positions[i + 2]!); }
      const len = Math.max(...ys) - Math.min(...ys), width = Math.max(...xs) - Math.min(...xs);
      expect(len, name).toBeGreaterThan(width);         // long along y
      expect(Math.min(...zs), name).toBeCloseTo(0, 1);  // tires on the ground
      expect(len, name).toBeGreaterThan(3.5);
      expect(len, name).toBeLessThan(8);
    }
  });

  it("keeps the right front wheel on the right (+x) and in front (+y)", () => {
    // The sedan's wheel-front-right node sits at glTF (-0.3, 0.3, 0.66).
    const m = readGlb(asset("sedan.glb"));
    let found = false;
    for (let i = 0; i < m.positions.length; i += 3) {
      if (Math.abs(m.positions[i]! - 0.3) < 0.06 && Math.abs(m.positions[i + 1]! - 0.66) < 0.06) found = true;
    }
    expect(found).toBe(true);
  });
});

describe("placeVehicles", () => {
  const frame = enuFrame({ lat: 0, lon: 0, h: 0 });
  const ll = enuUnprojection(frame);
  const road = (id: number, nodes: number[], pts: [number, number][], extra: Partial<RoadWayInput> = {}): RoadWayInput => ({
    osmWayId: id, nodeIds: nodes, points: pts.map(([x, y]) => ll(x, y)), class: "primary", name: null,
    lanesFwd: 1, lanesBack: 1, speedLimitMps: 15, ...extra,
  });
  const g = buildRoadGraph([road(1, [1, 2], [[0, 0], [2000, 0]]), road(2, [3, 4], [[0, 100], [0, 1100]], { lanesBack: 0, lanesFwd: 2 })],
    enuProjection(frame));

  it("is deterministic per seed, and different across seeds", () => {
    expect(placeVehicles(g, 7)).toEqual(placeVehicles(g, 7));
    expect(placeVehicles(g, 7).count).not.toBe(0);
    expect([...placeVehicles(g, 8).position]).not.toEqual([...placeVehicles(g, 7).position]);
  });

  it("puts cars in their lanes, facing their direction (right-hand traffic)", () => {
    const v = placeVehicles(g, 1);
    for (let i = 0; i < v.count; i++) {
      const [x, y] = [v.position[3 * i]!, v.position[3 * i + 1]!], [fx, fy] = [v.forward[3 * i]!, v.forward[3 * i + 1]!];
      if (Math.abs(y) < 10) {
        // East-west two-way road along y = 0: eastbound south of the center line, westbound north.
        expect(Math.abs(Math.abs(y) - 1.7)).toBeLessThan(0.05);
        expect(Math.sign(fx)).toBe(y < 0 ? 1 : -1);
      } else {
        // One-way northbound, two 3.4 m lanes centered on the centerline (x = 0).
        expect(fy).toBeGreaterThan(0.99);
        expect([-1.7, 1.7].some((o) => Math.abs(x - o) < 0.05)).toBe(true);
      }
    }
  });
});
