// Top-down 2D camera. Pure functions over a plain value, so the view is fully
// described by three numbers, which round-trip through the URL hash: the same
// URL renders the same pixels.

import type { Bounds } from "@game/world";

export interface Camera {
  x: number;    // world center, m
  y: number;
  mpp: number;  // meters per CSS pixel
}

export const MIN_MPP = 0.02;
export const MAX_MPP = 200;

const clampMpp = (mpp: number) => Math.min(MAX_MPP, Math.max(MIN_MPP, mpp));

export function fitBounds(b: Bounds, width: number, height: number, margin = 0.05): Camera {
  const w = Math.max(b.maxX - b.minX, 1);
  const h = Math.max(b.maxY - b.minY, 1);
  return {
    x: (b.minX + b.maxX) / 2,
    y: (b.minY + b.maxY) / 2,
    mpp: clampMpp(Math.max(w / width, h / height) * (1 + 2 * margin)),
  };
}

/** World meters → clip space, as a column-major 3×3 matrix for a viewport in CSS pixels. */
export function viewMatrix(c: Camera, width: number, height: number): Float32Array {
  const sx = 2 / (c.mpp * width);
  const sy = 2 / (c.mpp * height);
  return new Float32Array([sx, 0, 0, 0, sy, 0, -c.x * sx, -c.y * sy, 1]);
}

/** CSS pixel (origin top left, y down) → world meters. */
export function screenToWorld(c: Camera, width: number, height: number, px: number, py: number): [number, number] {
  return [c.x + (px - width / 2) * c.mpp, c.y - (py - height / 2) * c.mpp];
}

/** Move the camera so the world follows a drag of (dx, dy) CSS pixels. */
export function pan(c: Camera, dx: number, dy: number): Camera {
  return { x: c.x - dx * c.mpp, y: c.y + dy * c.mpp, mpp: c.mpp };
}

/** Zoom by `factor` (>1 zooms out) keeping the world point under the cursor fixed. */
export function zoomAt(c: Camera, width: number, height: number, px: number, py: number, factor: number): Camera {
  const [wx, wy] = screenToWorld(c, width, height, px, py);
  const mpp = clampMpp(c.mpp * factor);
  const k = mpp / c.mpp;
  return { x: wx + (c.x - wx) * k, y: wy + (c.y - wy) * k, mpp };
}

export function formatHash(c: Camera): string {
  return `#${c.x.toFixed(1)},${c.y.toFixed(1)},${+c.mpp.toPrecision(4)}`;
}

export function parseHash(hash: string): Camera | null {
  const parts = hash.replace(/^#/, "").split(",").map(Number);
  if (parts.length !== 3 || !parts.every(Number.isFinite) || parts[2]! <= 0) return null;
  return { x: parts[0]!, y: parts[1]!, mpp: clampMpp(parts[2]!) };
}
