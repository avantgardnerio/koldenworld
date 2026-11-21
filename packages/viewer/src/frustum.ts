// Frustum culling: is a bounding sphere at least partly inside the view?
// Planes come straight from the view-projection matrix (Gribb & Hartmann):
// a point p is inside when every plane gives n·p + d ≥ 0. A sphere is culled
// only when it lies entirely behind one plane, so the test never drops
// anything visible (it may keep a few spheres near the frustum's corners).

export type Planes = Float64Array;  // 6 × (nx, ny, nz, d), normalized

/** The six planes (left, right, bottom, top, near, far) of a column-major clip matrix. */
export function frustumPlanes(m: ArrayLike<number>): Planes {
  const row = (i: number) => [m[i]!, m[4 + i]!, m[8 + i]!, m[12 + i]!];
  const r0 = row(0), r1 = row(1), r2 = row(2), r3 = row(3);
  const out = new Float64Array(24);
  [[r0, 1], [r0, -1], [r1, 1], [r1, -1], [r2, 1], [r2, -1]].forEach(([r, sign], p) => {
    const v = [0, 1, 2, 3].map((k) => r3[k]! + (sign as number) * (r as number[])[k]!);
    const len = Math.hypot(v[0]!, v[1]!, v[2]!);
    for (let k = 0; k < 4; k++) out[4 * p + k] = v[k]! / len;
  });
  return out;
}

export function sphereVisible(planes: Planes, x: number, y: number, z: number, radius: number): boolean {
  for (let p = 0; p < 24; p += 4) {
    if (planes[p]! * x + planes[p + 1]! * y + planes[p + 2]! * z + planes[p + 3]! < -radius) return false;
  }
  return true;
}
