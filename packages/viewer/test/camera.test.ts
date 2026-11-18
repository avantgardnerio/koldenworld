import { describe, expect, it } from "vitest";
import {
  forward, formatHash, fromYawPitch, MIN_ALTITUDE, parseHash, right, stepCamera, up, viewProjection, yawPitch,
  type Camera, type CameraInput, type Vec3,
} from "../src/camera.ts";
import { decodeInput } from "../src/input.ts";

const DEG = Math.PI / 180;
const near = (got: readonly number[], want: readonly number[], digits = 9) =>
  got.forEach((v, i) => expect(v).toBeCloseTo(want[i]!, digits));
const still: CameraInput = { move: [0, 0, 0], look: [0, 0], fast: false };
const at = (pos: Vec3, yaw = 0, pitch = 0): Camera => ({ pos, rot: fromYawPitch(yaw * DEG, pitch * DEG) });

/** Apply a column-major 4×4 to a point and divide by w. */
function project(m: Float32Array, p: Vec3): Vec3 {
  const c = [0, 1, 2, 3].map((r) => m[r]! * p[0] + m[4 + r]! * p[1] + m[8 + r]! * p[2] + m[12 + r]!);
  return [c[0]! / c[3]!, c[1]! / c[3]!, c[2]! / c[3]!];
}

describe("orientation", () => {
  it("identity looks north, level", () => {
    const c = at([0, 0, 10]);
    near(forward(c), [0, 1, 0]);
    near(right(c), [1, 0, 0]);
    near(up(c), [0, 0, 1]);
  });

  it("yaw is counterclockwise from north; pitch is up", () => {
    near(forward(at([0, 0, 10], 90)), [-1, 0, 0]);
    near(forward(at([0, 0, 10], 0, 30)), [0, Math.cos(30 * DEG), Math.sin(30 * DEG)]);
  });

  it("looking straight down is well defined: screen up is the facing direction", () => {
    const c = at([0, 0, 10], -90, -90);  // facing east, then pitched down
    near(forward(c), [0, 0, -1]);
    near(up(c), [1, 0, 0]);
    near(right(c), [0, -1, 0]);
    near(yawPitch(c.rot), [-90 * DEG, -90 * DEG]);
  });
});

describe("look", () => {
  it("mouse right turns right, mouse up looks up", () => {
    const c = stepCamera(at([0, 0, 10]), { ...still, look: [100, -40] }, 0);
    const [yaw, pitch] = yawPitch(c.rot);
    expect(yaw).toBeLessThan(0);
    expect(pitch).toBeGreaterThan(0);
  });

  it("clamps pitch at straight down and never rolls", () => {
    let c = at([0, 0, 10], 20, -80);
    for (let i = 0; i < 50; i++) c = stepCamera(c, { ...still, look: [37, 90] }, 0);
    expect(yawPitch(c.rot)[1]).toBeCloseTo(-90 * DEG, 6);
    expect(right(c)[2]).toBeCloseTo(0, 9);  // right stays horizontal
    c = stepCamera(c, { ...still, look: [0, -200] }, 0);
    expect(yawPitch(c.rot)[1]).toBeGreaterThan(-90 * DEG);
  });

  it("keeps the quaternion normalized", () => {
    let c = at([0, 0, 10]);
    for (let i = 0; i < 10_000; i++) c = stepCamera(c, { ...still, look: [3, i % 2 ? 5 : -5] }, 0);
    expect(Math.hypot(...c.rot)).toBeCloseTo(1, 12);
  });
});

describe("move", () => {
  it("flies along the view direction, faster when higher", () => {
    const low = stepCamera(at([0, 0, 10], 0, -45), { ...still, move: [0, 1, 0] }, 1);
    near(low.pos, [10 * Math.SQRT1_2, 10 - 10 * Math.SQRT1_2].flatMap((v, i) => (i === 0 ? [0, v] : [v])) as Vec3, 6);
    const high = stepCamera(at([0, 0, 1000]), { ...still, move: [1, 0, 0] }, 1);
    near(high.pos, [1000, 0, 1000]);
  });

  it("goes up in world space whatever the pitch, and stops at the ground", () => {
    near(stepCamera(at([0, 0, 10], 0, -90), { ...still, move: [0, 0, 1] }, 1).pos, [0, 0, 20]);
    expect(stepCamera(at([0, 0, 10], 0, -90), { ...still, move: [0, 1, 0], fast: true }, 10).pos[2]).toBe(MIN_ALTITUDE);
  });
});

describe("projection", () => {
  it("puts the point straight ahead at the center of the screen", () => {
    const c = at([5, 5, 100], 30, -60);
    const f = forward(c);
    const ahead: Vec3 = [5 + f[0] * 50, 5 + f[1] * 50, 100 + f[2] * 50];
    near(project(viewProjection(c, 1.5), ahead).slice(0, 2), [0, 0], 5);
  });

  it("shows world east on screen right when facing north", () => {
    const p = project(viewProjection(at([0, 0, 10]), 1), [10, 100, 10]);
    expect(p[0]).toBeGreaterThan(0);
    expect(p[1]).toBeCloseTo(0, 6);
  });
});

describe("URL hash", () => {
  it("round-trips the pose", () => {
    const c = at([12.3, -45.6, 789], -135, -30);
    const back = parseHash(formatHash(c))!;
    near(back.pos, c.pos, 6);
    near(yawPitch(back.rot), yawPitch(c.rot), 6);
    expect(formatHash(c)).toBe("#12.3,-45.6,789.0,-135.0,-30.0");
  });

  it("rejects junk and clamps", () => {
    expect(parseHash("#1,2,3")).toBeNull();
    expect(parseHash("#a,b,c,d,e")).toBeNull();
    expect(parseHash("#0,0,-5,0,-120")!.pos[2]).toBe(MIN_ALTITUDE);
    expect(yawPitch(parseHash("#0,0,5,0,-120")!.rot)[1]).toBeCloseTo(-90 * DEG, 9);
  });
});

describe("decodeInput", () => {
  it("maps physical keys to axes; opposite keys cancel", () => {
    expect(decodeInput(new Set(["KeyW", "KeyD", "ShiftLeft"]), [1, 2])).toEqual({ move: [1, 1, 0], look: [1, 2], fast: true });
    expect(decodeInput(new Set(["KeyW", "KeyS", "KeyQ"]), [0, 0]).move).toEqual([0, 0, -1]);
    expect(decodeInput(new Set(["KeyW", "ArrowUp"]), [0, 0]).move).toEqual([0, 1, 0]);
  });
});
