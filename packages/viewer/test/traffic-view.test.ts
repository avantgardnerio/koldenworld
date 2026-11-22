import { describe, expect, it } from "vitest";
import { buildRoadGraph, enuFrame, enuProjection, enuUnprojection, type RoadWayInput } from "@game/world";
import { emptyInstances, TrafficView } from "../src/traffic-view.ts";

// A small network: a two-way road east with a 45° bend at a junction (two lanes each way, then
// one), a road north from the junction, and dead ends at every far end (U-turns).
const frame = enuFrame({ lat: 0, lon: 0, h: 0 });
const ll = enuUnprojection(frame);
const road = (id: number, nodes: number[], pts: [number, number][], extra: Partial<RoadWayInput> = {}): RoadWayInput => ({
  osmWayId: id, nodeIds: nodes, points: pts.map(([x, y]) => ll(x, y)), class: "primary", name: null,
  lanesFwd: 1, lanesBack: 1, speedLimitMps: 15, ...extra,
});
const g = buildRoadGraph([
  road(1, [1, 2], [[0, 0], [200, 0]], { lanesFwd: 2, lanesBack: 2 }),
  road(2, [2, 3, 4], [[200, 0], [300, 100], [300, 400]]),
  road(3, [2, 5], [[200, 0], [200, 300]]),
], enuProjection(frame));
const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** One car's poses, frame by frame, from a start on (edge, dir, lane, s). */
function drive(edge: number, dir: number, lane: number, s: number, seconds: number): number[][] {
  const t = new TrafficView(edge * 7 + lane);
  const tc = t.add(g, {
    count: 1, model: Uint8Array.of(0), edge: Uint32Array.of(edge), dir: Int8Array.of(dir), lane: Uint8Array.of(lane),
    s: Float32Array.of(s),
  }, identity);
  tc.visible = true;
  const out = emptyInstances(), poses: number[][] = [];
  for (let k = 0; k < seconds * 30; k++) {
    t.update(1 / 30, () => 0, 1, 2, true);
    t.instances(out);
    expect(out.count[0]).toBe(1);
    poses.push([...out.data[0]!.subarray(0, 6)]);
  }
  return poses;
}

describe("traffic view", () => {
  it("never jumps: position and heading change smoothly through bends, junctions, lane changes and U-turns", () => {
    for (let e = 0; e < g.edges.count; e++) {
      for (const dir of [1, -1]) {
        const lanes = dir > 0 ? g.edges.lanesFwd[e]! : g.edges.lanesBack[e]!;
        for (let lane = 0; lane < lanes; lane++) {
          const poses = drive(e, dir, lane, 20, 90);
          for (let k = 1; k < poses.length; k++) {
            const [x0, y0, z0, fx0, fy0, fz0] = poses[k - 1]!, [x1, y1, z1, fx1, fy1, fz1] = poses[k]!;
            // At most 20 m/s (15 + 10 mph per lane) for 1/30 s, with room for curves longer than their reach.
            expect(Math.hypot(x1! - x0!, y1! - y0!, z1! - z0!), `edge ${e} dir ${dir} lane ${lane} frame ${k}`).toBeLessThan(1.5);
            const turn = (Math.acos(Math.min(1, fx0! * fx1! + fy0! * fy1! + fz0! * fz1!)) * 180) / Math.PI;
            expect(turn, `edge ${e} dir ${dir} lane ${lane} frame ${k}`).toBeLessThan(15);
          }
        }
      }
    }
  });
});
