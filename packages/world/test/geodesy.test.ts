import { describe, expect, it } from "vitest";
import {
  cellEdgeNeighbors, cellFrame, cellFromLatLon, ecefToGeodetic, ecefToLocal, enuFrame, frameToFrame, geodeticToEcef,
  localToEcef, transformPoint, WGS84_A, WGS84_B, type Vec3,
} from "../src/index.ts";

const near = (a: Vec3, b: Vec3, tol: number) => a.forEach((v, k) => expect(Math.abs(v - b[k]!)).toBeLessThan(tol));
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const f32 = (p: Vec3): Vec3 => [Math.fround(p[0]), Math.fround(p[1]), Math.fround(p[2])];

describe("WGS84", () => {
  it("places known points", () => {
    near(geodeticToEcef({ lat: 0, lon: 0, h: 0 }), [WGS84_A, 0, 0], 1e-9);
    near(geodeticToEcef({ lat: 0, lon: 90, h: 100 }), [0, WGS84_A + 100, 0], 1e-9);
    near(geodeticToEcef({ lat: 90, lon: 0, h: 0 }), [0, 0, WGS84_B], 1e-9);
    near(geodeticToEcef({ lat: -90, lon: 0, h: -10 }), [0, 0, -WGS84_B + 10], 1e-9);
  });

  it("round-trips geodetic → ECEF → geodetic, poles and antimeridian included", () => {
    const cases = [
      [39.758861, -104.964699, 1600], [41.878113, -87.629799, 180], [90, 0, 0], [-90, 0, 9000],
      [89.9999999, 45, 20], [0, 180, -400], [-33.9, 18.4, 30_000], [27.9881, 86.925, 8849],
    ];
    for (const [lat, lon, h] of cases) {
      const back = ecefToGeodetic(geodeticToEcef({ lat: lat!, lon: lon!, h: h! }));
      expect(back.lat).toBeCloseTo(lat!, 11);
      if (Math.abs(lat!) < 90) expect(back.lon).toBeCloseTo(lon!, 11);
      expect(back.h).toBeCloseTo(h!, 6);
    }
  });

  it("measures a degree of latitude and longitude at Denver like the ellipsoid does", () => {
    // Meridian and prime-vertical radii at 39.76°: 6,361.6 km and 6,386.9 km.
    const a = geodeticToEcef({ lat: 39.758861, lon: -104.964699, h: 0 });
    const n = geodeticToEcef({ lat: 39.758861 + 0.01, lon: -104.964699, h: 0 });
    const e = geodeticToEcef({ lat: 39.758861, lon: -104.964699 + 0.01, h: 0 });
    expect(dist(a, n)).toBeCloseTo(1110.3, 1);
    expect(dist(a, e)).toBeCloseTo(856.93, 2);
  });
});

describe("ENU frames", () => {
  const denver = enuFrame({ lat: 39.758861, lon: -104.964699, h: 1600 });

  it("are orthonormal and right-handed, with up along the ellipsoid normal", () => {
    const { east: e, north: n, up: u } = denver;
    const cross: Vec3 = [e[1] * n[2] - e[2] * n[1], e[2] * n[0] - e[0] * n[2], e[0] * n[1] - e[1] * n[0]];
    near(cross, u, 1e-15);
    // A point straight up is (0, 0, h) locally.
    const above = geodeticToEcef({ lat: 39.758861, lon: -104.964699, h: 2600 });
    near(ecefToLocal(denver, above), [0, 0, 1000], 1e-6);
  });

  it("put north on +y and east on +x", () => {
    const n = ecefToLocal(denver, geodeticToEcef({ lat: 39.768861, lon: -104.964699, h: 1600 }));
    const e = ecefToLocal(denver, geodeticToEcef({ lat: 39.758861, lon: -104.954699, h: 1600 }));
    expect(n[1]).toBeCloseTo(1110.3, 0);
    expect(Math.abs(n[0])).toBeLessThan(1e-6);
    expect(e[0]).toBeCloseTo(857.15, 2);  // 1,600 m up, so slightly more than at h = 0
    // Curvature: 1.1 km away the surface is ~10 cm below the tangent plane.
    expect(n[2]).toBeCloseTo(-0.097, 2);
  });

  it("round-trip local ↔ ECEF", () => {
    const p: Vec3 = [1234.5, -678.9, 42];
    near(ecefToLocal(denver, localToEcef(denver, p)), p, 1e-8);
  });

  it("frameToFrame agrees with going through ECEF", () => {
    const chicago = enuFrame({ lat: 41.878113, lon: -87.629799, h: 180 });
    const p: Vec3 = [100, 200, 3];
    const m = frameToFrame(denver, chicago);
    near(transformPoint(m, p), ecefToLocal(chicago, localToEcef(denver, p)), 1e-6);
    // Up differs by ~14° between the two cities.
    const tilt = Math.acos(m[10]!) * 180 / Math.PI;
    expect(tilt).toBeGreaterThan(13);
    expect(tilt).toBeLessThan(15);
  });
});

describe("partition frames (decision 20)", () => {
  it("neighboring cells stored in f32 meet without a seam in the camera's frame", () => {
    const a = cellFromLatLon(39.758861, -104.964699, 13);
    const [, b] = cellEdgeNeighbors(a);
    const fa = cellFrame(a, 1600), fb = cellFrame(b, 1600);
    // A camera somewhere nearby, also far from either anchor's numbers in ECEF.
    const cam = enuFrame({ lat: 39.76, lon: -104.95, h: 1700 });
    const ma = frameToFrame(fa, cam), mb = frameToFrame(fb, cam);
    for (const [lat, lon, h] of [[39.7590, -104.9600, 1601], [39.7612, -104.9555, 1650.25], [39.7550, -104.9700, 1590]]) {
      // The same point, stored by each partition as f32 local coordinates.
      const p = geodeticToEcef({ lat: lat!, lon: lon!, h: h! });
      const viaA = transformPoint(Float32Array.from(ma), f32(ecefToLocal(fa, p)));
      const viaB = transformPoint(Float32Array.from(mb), f32(ecefToLocal(fb, p)));
      expect(dist(viaA, viaB)).toBeLessThan(0.001);
      expect(dist(viaA, ecefToLocal(cam, p))).toBeLessThan(0.001);
    }
  });

  it("f32 in ECEF directly would not be good enough", () => {
    const p = geodeticToEcef({ lat: 39.758861, lon: -104.964699, h: 1600 });
    expect(dist(f32(p), p)).toBeGreaterThan(0.01);
  });
});
