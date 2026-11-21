import { describe, expect, it } from "vitest";
import { fromYawPitch, viewProjection, type Camera } from "../src/camera.ts";
import { frustumPlanes, sphereVisible } from "../src/frustum.ts";

const DEG = Math.PI / 180;
// 10 m up, looking north, level; 60° vertical field of view, square viewport.
const cam: Camera = { pos: [0, 0, 10], rot: fromYawPitch(0, 0) };
const planes = frustumPlanes(viewProjection(cam, 1));

describe("frustum culling", () => {
  it("keeps what is ahead and drops what is behind", () => {
    expect(sphereVisible(planes, 0, 1000, 10, 1)).toBe(true);
    expect(sphereVisible(planes, 0, -1000, 10, 1)).toBe(false);
  });

  it("drops what is off to the side, unless it reaches into view", () => {
    // 30° half-angle: at 1 km ahead the view spans ±577 m.
    expect(sphereVisible(planes, 700, 1000, 10, 50)).toBe(false);
    expect(sphereVisible(planes, 700, 1000, 10, 200)).toBe(true);
  });

  it("keeps a sphere around the camera, and drops one past the far plane", () => {
    expect(sphereVisible(planes, 0, -500, 10, 600)).toBe(true);
    expect(sphereVisible(planes, 0, 70_000, 10, 100)).toBe(false);
  });

  it("follows the camera's yaw", () => {
    const west = frustumPlanes(viewProjection({ pos: [0, 0, 10], rot: fromYawPitch(90 * DEG, 0) }, 1));
    expect(sphereVisible(west, -1000, 0, 10, 1)).toBe(true);
    expect(sphereVisible(west, 0, 1000, 10, 1)).toBe(false);
  });
});
