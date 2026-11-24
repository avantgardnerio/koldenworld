// Props: small generated models placed in the world and drawn instanced (a
// door in its doorway; shops' furniture), each facing +y, with z up, standing
// on z = 0, centered on x = y = 0, in meters. Colors are swatches in
// PROPS_PALETTE, a 16 × 1 texture the uvs point at.

import { Builder } from "./aircraft.ts";
import { DOOR } from "./doors.ts";
import type { ModelMesh } from "./glb.ts";

const SWATCH = {
  frame: 0, panel: 1, handle: 2, wood: 3, top: 4, metal: 5, glass: 6, red: 7, yellow: 8, blue: 9, green: 10, cream: 11,
} as const;
const PALETTE = [
  "#2b2d31", "#4d6570", "#b9bec4", "#7a5a3c", "#d9d4c7", "#6b6f75", "#9fc7cf", "#c4473a", "#e0b43c", "#3f6fb5",
  "#4f9a5a", "#efe6cf",
];
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
export const PROPS = ["door", "table", "chair", "counter", "case", "shelf", "register"] as const;
export type Prop = (typeof PROPS)[number];
export const PROP = Object.fromEntries(PROPS.map((p, i) => [p, i])) as Record<Prop, number>;

/** Each prop's footprint, m: across (x) and front to back (y). */
export const PROP_SIZE: Record<Prop, [number, number]> = {
  door: [DOOR.width, 0.05], table: [0.8, 0.8], chair: [0.44, 0.44], counter: [1.0, 0.6], case: [1.0, 0.6],
  shelf: [1.0, 0.4], register: [0.4, 0.35],
};

export function propMeshes(): ModelMesh[] {
  return [doorMesh(), tableMesh(), chairMesh(), counterMesh(false), counterMesh(true), shelfMesh(), registerMesh()];
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

/** A café table: a square wooden top on a pedestal and a foot. */
function tableMesh(): ModelMesh {
  const b = new Builder(), w = PROP_SIZE.table[0] / 2;
  b.box(-w, w, -w, w, 0.72, 0.76, SWATCH.wood);
  b.box(-0.04, 0.04, -0.04, 0.04, 0.03, 0.72, SWATCH.metal);
  b.box(-0.25, 0.25, -0.25, 0.25, 0, 0.03, SWATCH.metal);
  return b.mesh();
}

/** A chair facing +y: a seat on four legs, its back behind (−y). */
function chairMesh(): ModelMesh {
  const b = new Builder(), w = PROP_SIZE.chair[0] / 2;
  b.box(-w, w, -w, w, 0.43, 0.47, SWATCH.wood);
  for (const x of [-w + 0.03, w - 0.03]) for (const y of [-w + 0.03, w - 0.03]) b.box(x - 0.02, x + 0.02, y - 0.02, y + 0.02, 0, 0.43, SWATCH.metal);
  b.box(-w, w, -w, -w + 0.04, 0.47, 0.9, SWATCH.wood);
  return b.mesh();
}

/** A metre of counter, served across from behind (−y): a cabinet with a lighter top; glass above for a display case. */
function counterMesh(glass: boolean): ModelMesh {
  const b = new Builder(), [w, d] = [PROP_SIZE.counter[0] / 2, PROP_SIZE.counter[1] / 2];
  if (!glass) {
    b.box(-w, w, -d, d, 0, 1.0, SWATCH.wood);
    b.box(-w, w, -d - 0.02, d + 0.03, 1.0, 1.05, SWATCH.top);
    return b.mesh();
  }
  b.box(-w, w, -d, d, 0, 0.55, SWATCH.frame);
  b.box(-w + 0.02, w - 0.02, -d + 0.02, d - 0.02, 0.55, 0.95, SWATCH.glass);
  b.box(-w + 0.1, w - 0.1, -d + 0.1, d - 0.1, 0.56, 0.6, SWATCH.metal);  // what's on show
  b.box(-w, w, -d, d, 0.95, 0.98, SWATCH.frame);
  return b.mesh();
}

/** A metre of shelving facing +y: uprights, four shelves, and goods on them in a few colors. */
function shelfMesh(): ModelMesh {
  const b = new Builder(), [w, d] = [PROP_SIZE.shelf[0] / 2, PROP_SIZE.shelf[1] / 2];
  for (const x of [-w, w - 0.03]) b.box(x, x + 0.03, -d, d, 0, 1.8, SWATCH.metal);
  b.box(-w, w, -d, -d + 0.02, 0.1, 1.8, SWATCH.metal);
  const goods = [SWATCH.red, SWATCH.yellow, SWATCH.blue, SWATCH.green, SWATCH.cream];
  for (let s = 0; s < 4; s++) {
    const z = 0.1 + s * 0.45;
    b.box(-w, w, -d, d, z, z + 0.03, SWATCH.metal);
    for (let g = 0; g < 4; g++) {
      const x = -w + 0.06 + g * 0.23;
      b.box(x, x + 0.18, -d + 0.05, d - 0.06, z + 0.03, z + 0.22 + 0.06 * ((s + g) % 3), goods[(s * 3 + g) % goods.length]!);
    }
  }
  return b.mesh();
}

/** A till on a counter (its base at the counter's top), its screen toward whoever's behind it (−y). */
function registerMesh(): ModelMesh {
  const b = new Builder(), [w, d] = [PROP_SIZE.register[0] / 2, PROP_SIZE.register[1] / 2];
  b.box(-w, w, -d, d, 1.05, 1.15, SWATCH.frame);
  b.box(-w + 0.05, w - 0.05, -d + 0.02, -d + 0.06, 1.15, 1.38, SWATCH.frame);
  b.box(-w + 0.07, w - 0.07, -d + 0.015, -d + 0.02, 1.18, 1.35, SWATCH.blue);
  return b.mesh();
}
