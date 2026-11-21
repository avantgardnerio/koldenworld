import { describe, expect, it } from "vitest";
import { fromYawPitch, MIN_ALTITUDE, yawPitch, type CameraInput } from "../src/camera.ts";
import { formatGlobeHash, parseGlobeHash, stepGlobe, type GlobeCamera } from "../src/globe-camera.ts";

const DEG = Math.PI / 180;
const denver = (yaw = 0, pitch = 0, h = 100): GlobeCamera => ({ lat: 39.758861, lon: -104.964699, h, rot: fromYawPitch(yaw * DEG, pitch * DEG) });
const forward: CameraInput = { move: [0, 1, 0], look: [0, 0], fast: false };

describe("globe camera", () => {
  it("moves north along the meridian at constant height", () => {
    let c = denver();
    for (let k = 0; k < 100; k++) c = stepGlobe(c, forward, 0.1);  // 100 m/s × 10 s = 1 km
    expect(c.lon).toBeCloseTo(-104.964699, 9);
    expect((c.lat - 39.758861) * 111_030).toBeCloseTo(1000, -1);  // ≈ 111.03 km per degree here
    expect(c.h).toBeCloseTo(100, 2);  // 100 steps, each rising d²/2R ≈ 8 µm
  });

  it("follows the curve of the Earth on a long flight east", () => {
    let c = denver(-90);
    // 1,000 steps of 100 m: a 100 km flight, level all the way.
    for (let k = 0; k < 1000; k++) c = stepGlobe(c, forward, 1);
    expect(c.lon).toBeGreaterThan(-104.964699 + 1.1);
    expect(Math.abs(c.h - 100)).toBeLessThan(1);  // each step rises d²/2R ≈ 0.8 mm
    expect(yawPitch(c.rot)[0] / DEG).toBeCloseTo(-90, 6);
  });

  it("moves by height above the ground and never goes below it", () => {
    const ground = (_lat: number, lon: number) => 1600 + (lon + 104.964699) * 100_000;  // rising eastward, ~50°
    let c = { ...denver(-90), h: 1700 };  // 100 m above the ground, facing east
    c = stepGlobe(c, forward, 0.1, ground);
    expect((c.lon + 104.964699) * 85_000).toBeCloseTo(10, 0);  // 100 m/s at 100 m up, as on flat ground
    for (let k = 0; k < 200; k++) c = stepGlobe(c, forward, 0.1, ground);
    expect(c.h).toBeCloseTo(ground(c.lat, c.lon) + MIN_ALTITUDE, 6);  // ran into the rising ground; rides it
  });

  it("only turns when looking", () => {
    const c = stepGlobe(denver(), { move: [0, 0, 0], look: [100, 0], fast: false }, 0.1);
    expect([c.lat, c.lon, c.h]).toEqual([39.758861, -104.964699, 100]);
    expect(yawPitch(c.rot)[0]).toBeCloseTo(-0.25, 9);
  });
});

describe("URL hash", () => {
  it("round-trips the pose to about a centimeter", () => {
    const c = denver(-135, -30, 789);
    const back = parseGlobeHash(formatGlobeHash(c))!;
    expect(back.lat).toBeCloseTo(c.lat, 7);
    expect(back.lon).toBeCloseTo(c.lon, 7);
    expect(back.h).toBe(789);
    expect(formatGlobeHash(c)).toBe("#39.7588610,-104.9646990,789.0,-135.0,-30.0");
  });

  it("rejects junk and clamps", () => {
    expect(parseGlobeHash("#1,2,3")).toBeNull();
    expect(parseGlobeHash("#a,b,c,d,e")).toBeNull();
    expect(parseGlobeHash("#91,0,5,0,0")).toBeNull();
    expect(parseGlobeHash("#0,0,-5,0,-120")!.h).toBe(MIN_ALTITUDE);
    expect(yawPitch(parseGlobeHash("#0,0,5,0,-120")!.rot)[1]).toBeCloseTo(-90 * DEG, 9);
  });
});
