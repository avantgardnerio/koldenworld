// Props: small generated models placed in the world and drawn instanced (a
// door in its doorway; furniture to come), each facing +y, with z up, standing
// on z = 0, in meters. Colors are swatches in PROPS_PALETTE, a 16 × 1 texture
// the uvs point at.

import { Builder } from "./aircraft.ts";
import { DOOR } from "./doors.ts";
import type { ModelMesh } from "./glb.ts";

const SWATCH = { frame: 0, panel: 1, handle: 2 } as const;
const PALETTE = ["#2b2d31", "#4d6570", "#b9bec4"];
const PALETTE_SIZE = 16;

/** RGBA, 16 × 1: the texture props' uvs point at. */
export const PROPS_PALETTE: Uint8Array = (() => {
  const out = new Uint8Array(4 * PALETTE_SIZE);
  PALETTE.forEach((hex, i) => {
    for (let c = 0; c < 3; c++) out[4 * i + c] = parseInt(hex.slice(1 + 2 * c, 3 + 2 * c), 16);
    out[4 * i + 3] = 255;
  });
  return out;
})();

/** The models, by index: what a prop instance names. */
export const PROPS = ["door"] as const;

export function propMeshes(): ModelMesh[] {
  return [doorMesh()];
}

/**
 * A shop door, closed, filling its opening (DOOR): a dark frame, a tinted panel standing a little proud of it both
 * sides, and a push bar on the outside (+y).
 */
function doorMesh(): ModelMesh {
  const b = new Builder(), [w, h, t] = [DOOR.width / 2, DOOR.height, 0.05];
  b.box(-w, w, -t / 2, t / 2, 0, h, SWATCH.frame);
  b.box(-w + 0.09, w - 0.09, -t / 2 - 0.005, t / 2 + 0.005, 0.3, h - 0.12, SWATCH.panel);
  b.box(-w + 0.15, w - 0.15, t / 2 + 0.02, t / 2 + 0.045, 0.98, 1.03, SWATCH.handle);
  for (const x of [-w + 0.17, w - 0.17]) b.box(x - 0.012, x + 0.012, t / 2, t / 2 + 0.03, 0.98, 1.03, SWATCH.handle);
  return b.mesh();
}
