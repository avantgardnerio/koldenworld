import { describe, expect, it } from "vitest";
import { forwardSpeed, placeVehicle, rectangleSegment, stepVehicle, VEHICLE, type VehicleWorld } from "../src/index.ts";

const flat: VehicleWorld = { height: () => 1600, walls: () => {} };
const go = { throttle: 1, steer: 0, handbrake: false };
const run = (seconds: number, f: (t: number) => void) => { for (let t = 0; t < seconds; t += 1 / 60) f(t); };

describe("vehicle", () => {
  it("accelerates, then brakes to a stop and reverses", () => {
    const v = placeVehicle(0, 0, 0, flat);
    expect(v.z).toBe(1600);
    run(3, () => stepVehicle(v, go, 1 / 60, flat));
    expect(forwardSpeed(v)).toBeGreaterThan(12);
    expect(v.x).toBeGreaterThan(15);
    expect(Math.abs(v.y)).toBeLessThan(1e-9);  // straight ahead (east)
    run(4, () => stepVehicle(v, { ...go, throttle: -1 }, 1 / 60, flat));
    expect(forwardSpeed(v)).toBeLessThan(0);   // stopped, then backing up
    expect(forwardSpeed(v)).toBeGreaterThanOrEqual(-VEHICLE.reverseMax);
  });

  it("jumps off a ramp, can't steer in the air, and lands", () => {
    // Flat to x = 10, a 20% ramp up to x = 20 (2 m high), then a 2 m drop back to flat.
    const ramp: VehicleWorld = { height: (x) => 1600 + (x > 10 && x < 20 ? (x - 10) * 0.2 : 0), walls: () => {} };
    const v = placeVehicle(0, 0, 0, ramp);
    [v.vx, v.vy] = [25, 0];
    let flew = 0, headingInAir = NaN, turned = 0, top = 0;
    run(3, () => {
      stepVehicle(v, { throttle: 1, steer: v.x > 20 ? 1 : 0, handbrake: false }, 1 / 60, ramp);  // steer hard once off the ramp
      if (v.air > 0) {
        flew++;
        if (Number.isNaN(headingInAir)) headingInAir = v.heading;
        turned = Math.max(turned, Math.abs(v.heading - headingInAir));
        top = Math.max(top, v.z - ramp.height(v.x, v.y));
      }
    });
    expect(flew).toBeGreaterThan(20);      // over a third of a second in the air
    expect(top).toBeGreaterThan(2);        // higher than the drop
    expect(turned).toBe(0);                // the wheels turned, the car didn't
    expect(v.air).toBe(0);                 // landed
    expect(v.z).toBeCloseTo(1600, 6);
    expect(Math.abs(v.heading)).toBeGreaterThan(0.05);  // and steers again on the ground
  });

  it("stays on the ground over gentle bumps at speed", () => {
    const bumps: VehicleWorld = { height: (x) => 1600 + 0.3 * Math.sin(x / 8), walls: () => {} };
    const v = placeVehicle(0, 0, 0, bumps);
    [v.vx, v.vy] = [20, 0];
    let flew = 0;
    run(3, () => { stepVehicle(v, go, 1 / 60, bumps); if (v.air > 0) flew++; });
    expect(flew).toBe(0);
  });

  it("brakes hard to a stop, waits, then backs up; slows off the throttle", () => {
    const v = placeVehicle(0, 0, 0, flat);
    [v.vx, v.vy] = [20, 0];
    let t = 0;
    for (; forwardSpeed(v) > 0.01 && t < 5; t += 1 / 60) stepVehicle(v, { throttle: -1, steer: 0, handbrake: false }, 1 / 60, flat);
    expect(t).toBeLessThan(2);                  // 20 m/s (72 km/h) in under 2 s
    expect(v.x).toBeLessThan(20);               // in under 20 m
    stepVehicle(v, { throttle: -1, steer: 0, handbrake: false }, 0.1, flat);
    expect(forwardSpeed(v)).toBeCloseTo(0, 6);  // still stopped: not reversing yet
    run(1, () => stepVehicle(v, { throttle: -1, steer: 0, handbrake: false }, 1 / 60, flat));
    expect(forwardSpeed(v)).toBeLessThan(-1);   // now backing up
    const coast = placeVehicle(0, 0, 0, flat);
    [coast.vx, coast.vy] = [20, 0];
    run(3, () => stepVehicle(coast, { throttle: 0, steer: 0, handbrake: false }, 1 / 60, flat));
    expect(forwardSpeed(coast)).toBeLessThan(15);
  });

  it("turns left when steered left, tighter slowly than fast", () => {
    const radius = (speed: number) => {
      const v = placeVehicle(0, 0, 0, flat);
      [v.vx, v.vy] = [speed, 0];
      run(2, () => stepVehicle(v, { throttle: 0, steer: -1, handbrake: false }, 1 / 60, flat));
      return { left: v.y > 0, turned: v.heading };
    };
    expect(radius(8).left).toBe(true);
    // Turning per meter travelled: more at 8 m/s than at 30 (steering falls off with speed).
    expect(radius(8).turned / 8).toBeGreaterThan(radius(30).turned / 30);
  });

  it("slides with the handbrake: sideways speed lasts", () => {
    const sideways = (handbrake: boolean) => {
      const v = placeVehicle(0, 0, 0, flat);
      [v.vx, v.vy] = [0, 10];  // moving north, facing east
      stepVehicle(v, { throttle: 0, steer: 0, handbrake }, 0.25, flat);
      return Math.abs(v.vy);
    };
    expect(sideways(true)).toBeGreaterThan(5 * sideways(false));
  });

  it("speeds up downhill", () => {
    const slope: VehicleWorld = { height: (x) => -0.1 * x, walls: () => {} };  // down 10% going east
    const v = placeVehicle(0, 0, 0, slope);
    expect(v.pitch).toBeLessThan(0);
    run(5, () => stepVehicle(v, { throttle: 0, steer: 0, handbrake: false }, 1 / 60, slope));
    expect(forwardSpeed(v)).toBeGreaterThan(2);
  });

  it("stops at a wall instead of going through it", () => {
    // A wall across the road 20 m east.
    const wall: VehicleWorld = { height: () => 0, walls: (_x0, _y0, _x1, _y1, visit) => visit(20, -10, 20, 10) };
    const v = placeVehicle(0, 0, 0, wall);
    run(6, () => stepVehicle(v, go, 1 / 60, wall));
    expect(v.x + VEHICLE.halfLength).toBeLessThanOrEqual(20 + 1e-6);
    expect(Math.abs(forwardSpeed(v))).toBeLessThan(2);  // pinned against it, not bouncing off fast
  });

  it("finds the way out of a wall it overlaps, or none when clear", () => {
    expect(rectangleSegment(0, 0, 0, 2, 1, 5, -3, 5, 3)).toBeUndefined();
    const [nx, ny, depth] = rectangleSegment(0, 0, 0, 2, 1, 1.5, -3, 1.5, 3)!;
    expect(nx).toBeCloseTo(-1, 9);  // back, west
    expect(ny).toBeCloseTo(0, 9);
    expect(depth).toBeCloseTo(0.5, 9);
  });
});
