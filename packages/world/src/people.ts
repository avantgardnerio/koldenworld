// People: a generated low-poly figure, blocky like a toy brick figure, for
// pedestrians and for vagrants (a different outfit), and where each start in
// a cell (placePeople on the sidewalks; placeVagrants around the places that
// draw them: shelters, soup kitchens, outreach, by charityWeight). Pure.
//
// The figure is rigid parts, so it can be animated by swinging them about
// their pivots (thighs at the hips, shins at the knees, upper arms at the
// shoulders, forearms at the elbows) with no skeleton: thighs, shins with
// shoes, hips, torso, upper arms, forearms with hands, neck, head (an
// eight-sided column) and hair. Each vertex knows its part (PART).
//
// It faces +y, with z up and its feet on z = 0, in meters, PERSON_HEIGHT tall.
// Colors are swatches in PEOPLE_PALETTE, a 16 × 1 texture the uvs point at.

import { Builder } from "./aircraft.ts";
import type { ModelMesh } from "./glb.ts";
import type { Buildings } from "./buildings.ts";
import { buildingBounds, inBuilding, type Pois } from "./pois.ts";
import { ROAD_CLASSES, type RoadClass, type RoadGraph } from "./road-graph.ts";
import { rng } from "./vehicles.ts";

export const PERSON_HEIGHT = 1.8;
/** Where the legs and arms swing from (the hips' and shoulders' height) and bend (the knees' and elbows'), m. */
export const HIP = 0.85, SHOULDER = 1.38, KNEE = 0.47, ELBOW = 1.19;
/** How far a limb's two halves overlap either side of the joint, m, so bending opens no gap. */
const JOINT = 0.03;
/**
 * The parts that move on their own; left and right as the figure sees them (left is −x). Legs and arms are the
 * thighs and upper arms; the shins and forearms hang from them.
 */
export const PART = {
  body: 0, leftLeg: 1, rightLeg: 2, leftArm: 3, rightArm: 4, leftShin: 5, rightShin: 6, leftForearm: 7, rightForearm: 8,
} as const;

const SWATCH = { skin: 0, shirt: 1, pants: 2, shoes: 3, hair: 4, coat: 5, worn: 6, beanie: 7, bundle: 8 } as const;
const PALETTE = ["#e8b98f", "#2f6fd6", "#3a3f4a", "#26282c", "#5a3a22", "#5b5a3c", "#4a4038", "#33343a", "#7a6a4f"];
const PALETTE_SIZE = 16;

/** What a figure wears: swatches for its top, legs and head, and whether it carries a bundle on its back. */
interface Outfit { top: number; legs: number; head: number; bundle: boolean }
const PEDESTRIAN: Outfit = { top: SWATCH.shirt, legs: SWATCH.pants, head: SWATCH.hair, bundle: false };
const VAGRANT: Outfit = { top: SWATCH.coat, legs: SWATCH.worn, head: SWATCH.beanie, bundle: true };

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

/** Vagrants around a place that draws them: this many per unit of its charityWeight, within this many m of it. */
export const VAGRANTS = { perWeight: 12, spread: 120 } as const;

/** Where vagrants start in a cell, and the place each stays near (its anchor), in the cell's frame. */
export interface VagrantPlacements {
  count: number;
  x: Float32Array;
  y: Float32Array;
  ax: Float32Array;
  ay: Float32Array;
}

/**
 * Where vagrants start in a cell: VAGRANTS.perWeight per unit of each place's charityWeight (rounded), anywhere
 * within VAGRANTS.spread m of it but not inside a building; each anchored to its place.
 */
export function placeVagrants(pois: Pois, b: Buildings, seed: number): VagrantPlacements {
  const rand = rng(seed), bounds = buildingBounds(b);
  const out = { x: [] as number[], y: [] as number[], ax: [] as number[], ay: [] as number[] };
  for (let i = 0; i < pois.count; i++) {
    const n = Math.round(pois.charity[i]! * VAGRANTS.perWeight), [ax, ay] = [pois.x[i]!, pois.y[i]!];
    for (let k = 0; k < n; k++) {
      // A few tries for a spot out of doors.
      for (let t = 0; t < 10; t++) {
        const r = VAGRANTS.spread * Math.sqrt(rand()), a = 2 * Math.PI * rand();
        const [x, y] = [ax + r * Math.cos(a), ay + r * Math.sin(a)];
        if (inBuilding(b, bounds, x, y)) continue;
        out.x.push(x);
        out.y.push(y);
        out.ax.push(ax);
        out.ay.push(ay);
        break;
      }
    }
  }
  return {
    count: out.x.length, x: Float32Array.from(out.x), y: Float32Array.from(out.y),
    ax: Float32Array.from(out.ax), ay: Float32Array.from(out.ay),
  };
}

/** The figure's mesh, and each vertex's part. */
export interface PersonMesh extends ModelMesh {
  parts: Uint8Array;
}

/** A pedestrian, standing. */
export const personMesh = (): PersonMesh => figure(PEDESTRIAN);

/** A vagrant, standing: a drab coat and trousers, a beanie, a bundle on the back. */
export const vagrantMesh = (): PersonMesh => figure(VAGRANT);

function figure(o: Outfit): PersonMesh {
  const b = new Builder();
  const parts: number[] = [];
  // Every vertex added since the last call belongs to `part`.
  const mark = (part: number) => {
    while (parts.length < b.pos.length / 3) parts.push(part);
  };
  for (const side of [1, -1]) {
    // A thigh; under it a shin (a touch narrower, overlapping it at the knee), its shoe sticking out forward.
    const [x0, x1] = side > 0 ? [0.02, 0.17] : [-0.17, -0.02];
    b.box(x0, x1, -0.08, 0.08, KNEE - JOINT, HIP, o.legs);
    mark(side > 0 ? PART.rightLeg : PART.leftLeg);
    b.box(x0 + 0.005, x1 - 0.005, -0.075, 0.075, 0.08, KNEE + JOINT, o.legs);
    b.box(x0, x1, -0.09, 0.15, 0, 0.08, SWATCH.shoes);
    mark(side > 0 ? PART.rightShin : PART.leftShin);
    // An upper arm; under it a forearm (overlapping it at the elbow), its hand below.
    const [a0, a1] = side > 0 ? [0.19, 0.29] : [-0.29, -0.19];
    b.box(a0, a1, -0.06, 0.06, ELBOW - JOINT, 1.44, o.top);
    mark(side > 0 ? PART.rightArm : PART.leftArm);
    b.box(a0 + 0.005, a1 - 0.005, -0.055, 0.055, 0.96, ELBOW + JOINT, o.top);
    b.box(a0 + 0.015, a1 - 0.015, -0.045, 0.045, 0.86, 0.96, SWATCH.skin);
    mark(side > 0 ? PART.rightForearm : PART.leftForearm);
  }
  b.box(-0.18, 0.18, -0.09, 0.09, HIP - 0.05, 0.93, o.legs);
  // The torso narrows to the shoulders.
  b.hexa(
    [[-0.19, -0.1, 0.93], [0.19, -0.1, 0.93], [0.19, 0.1, 0.93], [-0.19, 0.1, 0.93]],
    [[-0.15, -0.09, 1.46], [0.15, -0.09, 1.46], [0.15, 0.09, 1.46], [-0.15, 0.09, 1.46]],
    o.top,
  );
  if (o.bundle) b.box(-0.14, 0.14, -0.27, -0.1, 1.0, 1.4, SWATCH.bundle);
  column(b, 0.06, 1.46, 1.51, SWATCH.skin);
  // The head, under hair; or under a beanie, pulled down and a little wider.
  const cap = o.head === SWATCH.beanie;
  column(b, 0.12, 1.51, cap ? 1.71 : 1.75, SWATCH.skin);
  column(b, cap ? 0.13 : 0.125, cap ? 1.71 : 1.75, PERSON_HEIGHT, o.head);
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
