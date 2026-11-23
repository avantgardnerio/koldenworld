import { describe, expect, it } from "vitest";
import { HIP, PART, PERSON_HEIGHT, personMesh, SHOULDER } from "../src/index.ts";

describe("person model", () => {
  it("is low poly, with unit normals, facing +y, feet on z = 0, PERSON_HEIGHT tall, symmetric", () => {
    const m = personMesh();
    expect(m.indices.length % 3).toBe(0);
    expect(m.indices.length / 3).toBeLessThan(300);
    const xs: number[] = [], ys: number[] = [], zs: number[] = [];
    for (let i = 0; i < m.positions.length; i += 3) {
      xs.push(m.positions[i]!); ys.push(m.positions[i + 1]!); zs.push(m.positions[i + 2]!);
      expect(Math.hypot(m.normals[i]!, m.normals[i + 1]!, m.normals[i + 2]!)).toBeCloseTo(1, 4);
    }
    expect(Math.min(...zs)).toBeCloseTo(0, 6);
    expect(Math.max(...zs)).toBeCloseTo(PERSON_HEIGHT, 6);
    expect(Math.max(...xs) + Math.min(...xs)).toBeCloseTo(0, 6);
    // The shoes stick out forward.
    expect(Math.max(...ys)).toBeGreaterThan(-Math.min(...ys));
  });

  it("knows each vertex's part: legs below the hips, arms about the shoulders, on their own sides", () => {
    const m = personMesh();
    expect(m.parts.length).toBe(m.positions.length / 3);
    const seen = new Set<number>();
    for (let v = 0; v < m.parts.length; v++) {
      const [x, z] = [m.positions[3 * v]!, m.positions[3 * v + 2]!], p = m.parts[v]!;
      seen.add(p);
      if (p === PART.leftLeg || p === PART.rightLeg) expect(z).toBeLessThanOrEqual(HIP + 1e-6);
      if (p === PART.leftArm || p === PART.rightArm) expect(z).toBeLessThanOrEqual(SHOULDER + 0.1);
      if (p === PART.leftLeg || p === PART.leftArm) expect(x).toBeLessThan(0);
      if (p === PART.rightLeg || p === PART.rightArm) expect(x).toBeGreaterThan(0);
    }
    expect([...seen].sort()).toEqual(Object.values(PART).sort());
  });
});
