import { describe, expect, it } from "vitest";
import { fitBounds, formatHash, MIN_MPP, pan, parseHash, screenToWorld, viewMatrix, zoomAt } from "../src/camera.ts";

const W = 800, H = 600;
const cam = { x: 100, y: -50, mpp: 2 };

// Apply the column-major mat3 to a world point.
const clip = (m: Float32Array, x: number, y: number) => [m[0]! * x + m[6]!, m[4]! * y + m[7]!];

describe("camera", () => {
  it("maps the center to clip origin and the viewport edges to ±1", () => {
    const m = viewMatrix(cam, W, H);
    const close = (got: number[], want: number[]) => got.forEach((v, i) => expect(v).toBeCloseTo(want[i]!, 6));
    close(clip(m, 100, -50), [0, 0]);
    close(clip(m, 100 + (W / 2) * 2, -50 + (H / 2) * 2), [1, 1]);
    close(clip(m, 100 - (W / 2) * 2, -50 - (H / 2) * 2), [-1, -1]);
  });

  it("agrees with screenToWorld", () => {
    expect(screenToWorld(cam, W, H, 0, 0)).toEqual([100 - 800, -50 + 600]);
  });

  it("fits bounds with a margin, keeping aspect", () => {
    const c = fitBounds({ minX: -1000, minY: -500, maxX: 1000, maxY: 500 }, W, H, 0);
    expect(c).toEqual({ x: 0, y: 0, mpp: 2.5 });
  });

  it("keeps the point under the cursor fixed when zooming", () => {
    const before = screenToWorld(cam, W, H, 123, 456);
    const after = screenToWorld(zoomAt(cam, W, H, 123, 456, 1.7), W, H, 123, 456);
    expect(after[0]).toBeCloseTo(before[0], 9);
    expect(after[1]).toBeCloseTo(before[1], 9);
  });

  it("pans with the drag (y down on screen, up in the world)", () => {
    expect(pan(cam, 10, 10)).toEqual({ x: 80, y: -30, mpp: 2 });
  });

  it("round-trips through the URL hash and rejects junk", () => {
    expect(parseHash(formatHash(cam))).toEqual(cam);
    expect(parseHash("#1,2")).toBeNull();
    expect(parseHash("#a,b,c")).toBeNull();
    expect(parseHash("#0,0,0")).toBeNull();
    expect(parseHash("#0,0,0.000001")!.mpp).toBe(MIN_MPP);
  });
});
