import { describe, expect, it } from "vitest";
import { standIn } from "../src/car-layer.ts";

// A 2 × 4 × 1.5 m "car": a big flat body triangle in swatch (0.25, 0.5) and a small one in (0.75, 0.5).
const model = {
  positions: Float32Array.of(-1, -2, 0, 1, -2, 0, 1, 2, 1.5, 0, 0, 1, 0.1, 0, 1, 0, 0.1, 1),
  normals: new Float32Array(18),
  uvs: Float32Array.of(0.25, 0.5, 0.25, 0.5, 0.25, 0.5, 0.75, 0.5, 0.75, 0.5, 0.75, 0.5),
  indices: Uint32Array.of(0, 1, 2, 3, 4, 5),
};

describe("car stand-in", () => {
  const s = standIn(model);

  it("is two boxes: 24 triangles", () => {
    expect(s.indices.length / 3).toBe(24);
    expect(s.positions.length / 3).toBe(48);
  });

  it("stays within the model's bounding box", () => {
    for (let i = 0; i < s.positions.length; i += 3) {
      expect(s.positions[i]!).toBeGreaterThanOrEqual(-1);
      expect(s.positions[i]!).toBeLessThanOrEqual(1);
      expect(s.positions[i + 1]!).toBeGreaterThanOrEqual(-2);
      expect(s.positions[i + 1]!).toBeLessThanOrEqual(2);
      expect(s.positions[i + 2]!).toBeGreaterThanOrEqual(0);
      expect(s.positions[i + 2]!).toBeLessThanOrEqual(1.5);
    }
  });

  it("takes the color of the model's largest triangle", () => {
    expect(new Set(Array.from({ length: s.uvs.length / 2 }, (_, k) => `${s.uvs[2 * k]},${s.uvs[2 * k + 1]}`))).toEqual(new Set(["0.25,0.5"]));
  });
});
