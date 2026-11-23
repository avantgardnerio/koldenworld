// People: a generated low-poly figure, blocky like a toy brick figure, for
// pedestrians, and where they start in a cell (placePeople). Pure.
//
// The figure is rigid parts, so it can be animated by swinging them about
// their pivots (legs at the hips, arms at the shoulders) with no skeleton:
// legs, hips, torso, arms with hands, neck, head (an eight-sided column) and
// hair. Each vertex knows its part (PART).
//
// It faces +y, with z up and its feet on z = 0, in meters, PERSON_HEIGHT tall.
// Colors are swatches in PEOPLE_PALETTE, a 16 × 1 texture the uvs point at.

import { Builder } from "./aircraft.ts";
import type { ModelMesh } from "./glb.ts";
import { ROAD_CLASSES, type RoadClass, type RoadGraph } from "./road-graph.ts";
import { rng } from "./vehicles.ts";

export const PERSON_HEIGHT = 1.8;
/** Where the legs and arms swing from: the hips' and shoulders' height, m. */
export const HIP = 0.85, SHOULDER = 1.38;
/** The parts that move on their own; left and right as the figure sees them (left is −x). */
export const PART = { body: 0, leftLeg: 1, rightLeg: 2, leftArm: 3, rightArm: 4 } as const;

const SWATCH = { skin: 0, shirt: 1, pants: 2, shoes: 3, hair: 4 } as const;
const PALETTE = ["#e8b98f", "#2f6fd6", "#3a3f4a", "#26282c", "#5a3a22"];
const PALETTE_SIZE = 16;

/** RGBA, 16 × 1: the texture the figure's uvs point at. */
export const PEOPLE_PALETTE: Uint8Array = (() => {
  const out = new Uint8Array(4 * PALETTE_SIZE);
  PALETTE.forEach((hex, i) => {
    for (let c = 0; c < 3; c++) out[4 * i + c] = parseInt(hex.slice(1 + 2 * c, 3 + 2 * c), 16);
    out[4 * i + 3] = 255;
  });
  return out;
})();

/** Average gap between people on one sidewalk, m, by the road's class: busy streets are fuller. */
const SPACING: Record<RoadClass, number> = {
  motorway: 200, motorway_link: 200, trunk: 60, trunk_link: 80, primary: 40, primary_link: 60,
  secondary: 40, secondary_link: 60, tertiary: 50, tertiary_link: 70,
  unclassified: 80, residential: 100, living_street: 60, service: 120, road: 100,
};

/** Where people start in a cell: per sidewalk, s m past its edge's from node, walking dir. */
export interface PeoplePlacements {
  count: number;
  edge: Uint32Array;
  side: Int8Array;  // 1: right of from → to, −1: left
  dir: Int8Array;
  s: Float32Array;
}

/** Where people start in a cell: spaced by road class along every sidewalk, either way. */
export function placePeople(g: RoadGraph, seed: number): PeoplePlacements {
  const rand = rng(seed);
  const out = { edge: [] as number[], side: [] as number[], dir: [] as number[], s: [] as number[] };
  for (let e = 0; e < g.edges.count; e++) {
    const bits = g.edges.sidewalks[e]!, gap = SPACING[ROAD_CLASSES[g.edges.class[e]!]!], length = g.edges.length[e]!;
    for (const side of [1, -1]) {
      if (!(bits & (side > 0 ? 2 : 1))) continue;
      for (let s = rand() * gap; s < length; s += gap * (0.4 + 1.2 * rand())) {
        out.edge.push(e);
        out.side.push(side);
        out.dir.push(rand() < 0.5 ? 1 : -1);
        out.s.push(s);
      }
    }
  }
  return {
    count: out.edge.length, edge: Uint32Array.from(out.edge), side: Int8Array.from(out.side),
    dir: Int8Array.from(out.dir), s: Float32Array.from(out.s),
  };
}

/** The figure's mesh, and each vertex's part. */
export interface PersonMesh extends ModelMesh {
  parts: Uint8Array;
}

/** The figure, standing. */
export function personMesh(): PersonMesh {
  const b = new Builder();
  const parts: number[] = [];
  // Every vertex added since the last call belongs to `part`.
  const mark = (part: number) => {
    while (parts.length < b.pos.length / 3) parts.push(part);
  };
  for (const side of [1, -1]) {
    // A leg, its shoe sticking out forward.
    const [x0, x1] = side > 0 ? [0.02, 0.17] : [-0.17, -0.02];
    b.box(x0, x1, -0.08, 0.08, 0.08, HIP, SWATCH.pants);
    b.box(x0, x1, -0.09, 0.15, 0, 0.08, SWATCH.shoes);
    mark(side > 0 ? PART.rightLeg : PART.leftLeg);
    // An arm, its hand below.
    const [a0, a1] = side > 0 ? [0.19, 0.29] : [-0.29, -0.19];
    b.box(a0, a1, -0.06, 0.06, 0.96, 1.44, SWATCH.shirt);
    b.box(a0 + 0.015, a1 - 0.015, -0.045, 0.045, 0.86, 0.96, SWATCH.skin);
    mark(side > 0 ? PART.rightArm : PART.leftArm);
  }
  b.box(-0.18, 0.18, -0.09, 0.09, HIP - 0.05, 0.93, SWATCH.pants);
  // The torso narrows to the shoulders.
  b.hexa(
    [[-0.19, -0.1, 0.93], [0.19, -0.1, 0.93], [0.19, 0.1, 0.93], [-0.19, 0.1, 0.93]],
    [[-0.15, -0.09, 1.46], [0.15, -0.09, 1.46], [0.15, 0.09, 1.46], [-0.15, 0.09, 1.46]],
    SWATCH.shirt,
  );
  column(b, 0.06, 1.46, 1.51, SWATCH.skin);
  column(b, 0.12, 1.51, 1.75, SWATCH.skin);
  column(b, 0.125, 1.75, PERSON_HEIGHT, SWATCH.hair);
  mark(PART.body);
  return { ...b.mesh(), parts: Uint8Array.from(parts) };
}

/** An upright eight-sided column on the z axis, radius r, from z0 to z1, capped. */
function column(b: Builder, r: number, z0: number, z1: number, swatch: number, sides = 8): void {
  const at = (k: number, z: number): [number, number, number] => {
    const a = (2 * Math.PI * (k + 0.5)) / sides;
    return [r * Math.cos(a), r * Math.sin(a), z];
  };
  for (let k = 0; k < sides; k++) {
    b.quad(at(k, z0), at(k + 1, z0), at(k + 1, z1), at(k, z1), swatch);
    b.tri([0, 0, z0], at(k + 1, z0), at(k, z0), swatch);
    b.tri([0, 0, z1], at(k, z1), at(k + 1, z1), swatch);
  }
}
