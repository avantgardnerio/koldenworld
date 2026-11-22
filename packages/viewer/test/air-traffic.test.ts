import { describe, expect, it } from "vitest";
import { ecefToGeodetic, enuFrame, type AircraftReport, type Vec3 } from "@game/world";
import { AirTraffic, CONTRAIL_AGL, emptyContrails, TRAIL_S } from "../src/air-traffic.ts";

const report = (over: Partial<AircraftReport>): AircraftReport => ({
  id: "a1", callsign: "UAL1", model: 0, lat: 39.8, lon: -104.7, h: 3000, ground: false,
  speed: 120, track: 0, climb: 0, age: 0, ...over,
});

const dist = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
const angle = (a: number[], b: number[]) =>
  (Math.acos(Math.min(1, (a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!) / (Math.hypot(...a) * Math.hypot(...b)))) * 180) / Math.PI;

describe("air traffic", () => {
  it("flies on at its reported speed between reports, from where the report was made", () => {
    const air = new AirTraffic(() => 1600);
    air.update([report({ age: 1 })], 0);  // the position is a second old: it's already 120 m on
    const a = air.poses(0).get("a1")!, b = air.poses(5).get("a1")!;
    expect(dist(a.at, b.at)).toBeCloseTo(600, 0);
    expect(ecefToGeodetic(a.at).lat).toBeCloseTo(39.8 + 120 / 111_000, 4);
  });

  it("never jumps when a report disagrees: it eases onto the new position and track", () => {
    const air = new AirTraffic(() => 1600);
    air.update([report({})], 0);
    const frames: { at: Vec3; fwd: Vec3 }[] = [];
    for (let k = 0; k <= 30 * 20; k++) {
      const t = k / 30;
      // At 10 s the plane turns out to have turned 40° right, ~250 m off the extrapolated line.
      if (k === 300) air.update([report({ lat: 39.8 + 1000 / 111_000, lon: -104.7 + 150 / 85_000, track: (40 * Math.PI) / 180 })], t);
      frames.push(air.poses(t).get("a1")!);
    }
    for (let k = 1; k < frames.length; k++) {
      // 4 m per frame at 120 m/s; the correction adds at most ~4 m more while it fades.
      expect(dist(frames[k]!.at, frames[k - 1]!.at), `frame ${k}`).toBeLessThan(10);
      expect(angle(frames[k]!.fwd, frames[k - 1]!.fwd), `frame ${k}`).toBeLessThan(3);
    }
    // And it ends up where the report says, on its new track.
    const end = ecefToGeodetic(frames.at(-1)!.at);
    expect(end.lon).toBeGreaterThan(-104.7 + 150 / 85_000);
  });

  it("leaves contrails behind planes high in the air (from the first sight), not on the ground or taking off and landing", () => {
    const air = new AirTraffic(() => 1600);
    air.update([
      report({ h: 10_000 }),
      report({ id: "g", ground: true, h: undefined, speed: 10 }),
      report({ id: "low", h: 1600 + CONTRAIL_AGL - 500, climb: 20 }),  // climbing out: 500 m below where contrails start
    ], 0);
    const vf = enuFrame({ lat: 39.8, lon: -104.7, h: 0 }), mesh = emptyContrails();
    air.contrails(vf, 0, mesh);
    // One ribbon: TRAIL_S one-second samples behind it, plus where it is now; two vertices each.
    expect(mesh.vertices).toBe(2 * (TRAIL_S + 1));
    expect(mesh.count).toBe(6 * TRAIL_S);
    const at = (v: number) => [...mesh.data.subarray(8 * v, 8 * v + 8)];
    const [oldest, newest] = [at(0), at(mesh.vertices - 1)];
    expect(oldest[6]).toBeCloseTo(1, 3);  // age
    expect(newest[6]).toBe(0);
    expect(newest[1]! - oldest[1]!).toBeCloseTo(120 * TRAIL_S, -1);  // it flies north at 120 m/s
    expect(newest[4]).toBeCloseTo(1, 3);  // pointing north
    // Later, the trail follows the plane and old samples drop off.
    const ribbons = () => mesh.vertices / 2 - mesh.count / 6;  // points − segments: one more point than segments per ribbon
    expect(ribbons()).toBe(1);
    // The climbing plane is still 100 m short at 20 s; it crosses at 25 s and starts its own.
    for (let s = 1; s <= 20; s++) air.contrails(vf, s, mesh);
    expect(ribbons()).toBe(1);
    expect(mesh.vertices).toBeLessThanOrEqual(2 * (TRAIL_S + 2));  // old samples drop off as new ones come
    for (let s = 21; s <= 28; s++) air.contrails(vf, s, mesh);
    expect(ribbons()).toBe(2);
  });

  it("taxis on the ground, holds still once stale, and is forgotten", () => {
    const air = new AirTraffic(() => 1600);
    air.update([report({ id: "g", ground: true, h: undefined, speed: 10, track: Math.PI })], 0);
    expect(ecefToGeodetic(air.poses(3).get("g")!.at).h).toBeCloseTo(1600, 3);
    expect(dist(air.poses(40).get("g")!.at, air.poses(50).get("g")!.at)).toBe(0);
    air.update([], 61);
    expect(air.count).toBe(0);
  });
});
