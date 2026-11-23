import { describe, expect, it } from "vitest";
import { NO_CROSSING, PASSAGE } from "@game/sim";
import { buildRoadGraph, enuFrame, enuProjection, enuUnprojection, type RoadWayInput } from "@game/world";
import { PeopleView } from "../src/people-view.ts";
import { PERSON_STRIDE, type PersonInstances } from "../src/person-layer.ts";
import { TrafficView } from "../src/traffic-view.ts";

// A crossroads: four 100 m roads out of a junction at the origin, east, north, west and south, sidewalks on both
// sides, each ending in a dead end; the north road is two ways, joined at OSM node 3, 50 m out.
const frame = enuFrame({ lat: 0, lon: 0, h: 0 });
const ll = enuUnprojection(frame);
const road = (id: number, nodes: number[], pts: [number, number][]): RoadWayInput => ({
  osmWayId: id, nodeIds: nodes, points: pts.map(([x, y]) => ll(x, y)), class: "primary", name: null,
  lanesFwd: 1, lanesBack: 1, speedLimitMps: 15, sidewalks: 3,
});
const g = buildRoadGraph([
  road(1, [1, 2], [[0, 0], [100, 0]]),
  road(2, [1, 3], [[0, 0], [0, 50]]),
  road(5, [3, 4], [[0, 50], [0, 100]]),
  road(3, [1, 5], [[0, 0], [-100, 0]]),
  road(4, [1, 6], [[0, 0], [0, -100]]),
], enuProjection(frame));
const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const none = { count: 0, model: new Uint8Array(0), edge: new Uint32Array(0), dir: new Int8Array(0), lane: new Uint8Array(0), s: new Float32Array(0) };

/** The crossroads registered, and populated (its cell 0 m away). */
function crossroads(): PeopleView {
  const tc = new TrafficView(1).add(g, none, identity);
  tc.visible = true;
  const v = new PeopleView(2);
  v.add(tc, 3);
  step(v, 0);
  return v;
}
const step = (v: PeopleView, dt: number, distance = 0) => v.update(dt, () => distance, 1, 2, true);

describe("people view", () => {
  it("populates a cell's sidewalks when it's near, and empties them when it's far", () => {
    const v = crossroads();
    expect(v.people.count).toBeGreaterThan(15);
    const n = v.people.count;
    step(v, 1, 1.5);  // between near and far: as it was
    expect(v.people.count).toBe(n);
    step(v, 1, 3);
    expect(v.people.count).toBe(0);
    step(v, 1, 0);  // back: the same placements
    expect(v.people.count).toBe(n);
  });

  it("never jumps: everyone moves and turns smoothly along sidewalks, round corners and across crosswalks", () => {
    const v = crossroads(), out: PersonInstances = { data: new Float32Array(PERSON_STRIDE * 64), count: 0 };
    const n = v.people.count;
    let last: Float32Array | undefined;
    for (let k = 0; k < 30 * 300; k++) {
      step(v, 1 / 30);
      v.instances(out);
      expect(out.count).toBe(n);
      const now = out.data.slice(0, PERSON_STRIDE * n);
      if (last) {
        for (let i = 0; i < n; i++) {
          const o = PERSON_STRIDE * i;
          // At most 1.65 m/s for 1/30 s, with room for passages measured shorter than they walk.
          expect(Math.hypot(now[o]! - last[o]!, now[o + 1]! - last[o + 1]!), `person ${i} frame ${k}`).toBeLessThan(0.15);
          const turn = (Math.acos(Math.min(1, now[o + 3]! * last[o + 3]! + now[o + 4]! * last[o + 4]!)) * 180) / Math.PI;
          expect(turn, `person ${i} frame ${k}`).toBeLessThan(25);
        }
      }
      last = now;
    }
  });

  it("round corners, cross roads, and only walk on along a street", () => {
    const v = crossroads(), c = v.people.c;
    let corners = 0, crossings = 0;
    const along = new Set<number>();
    for (let k = 0; k < 30 * 600; k++) {
      step(v, 1 / 30);
      for (let i = 0; i < v.people.count; i++) {
        if (c.leg[i] !== PASSAGE || c.s[i]! > 0.06) continue;  // just set out
        // At the node along the north road, they walk on, on the same side of the street (both ways run north).
        const e = c.edge[i]!, node = g.nodes.osmId[c.dir[i]! > 0 ? g.edges.to[e]! : g.edges.from[e]!];
        if (node === 3) {
          expect(c.xcell[i]).toBe(NO_CROSSING);
          expect(c.nedge[i]).not.toBe(e);
          expect([g.edges.from[c.nedge[i]!], g.edges.to[c.nedge[i]!]].map((n) => g.nodes.osmId[n!])).toContain(3);
          expect(c.nside[i]).toBe(c.side[i]);
          along.add(i);
        } else if (c.nedge[i] !== c.edge[i]) {
          if (c.xcell[i] === NO_CROSSING) corners++;
          else crossings++;
        }
      }
    }
    expect(along.size).toBeGreaterThan(0);
    expect(corners).toBeGreaterThan(5);
    expect(crossings).toBeGreaterThan(5);
  });
});
