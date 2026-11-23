// People: a generated low-poly figure, blocky like a toy brick figure, for
// pedestrians and for vagrants (a different outfit), and where each start in
// a cell (placePeople on the sidewalks; placeVagrants around the places that
// draw them: shelters, soup kitchens, outreach, by charityWeight). Pure.
//
// The figure is rigid parts, so it can be animated by swinging them about
// their pivots (thighs at the hips, shins at the knees, upper arms at the
// shoulders, forearms at the elbows) with no skeleton: thighs, shins with
// shoes, hips, torso, upper arms, forearms with hands, neck, head (an
// eight-sided column) and hair. A woman's has a skirt for hips, bare legs, a
// bust and long hair. Each vertex knows its part (PART).
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
export const HIP = 0.85, SHOULDER = 1.38, KNEE = 0.47, ELBOW = 1.15;
/** The middle of a hand, hanging (m up), and how far either side of the middle the arms hang (m). */
export const HAND = 0.82, ARM_X = 0.24;
/** How far a limb's two halves overlap either side of the joint, m, so bending opens no gap. */
const JOINT = 0.03;
/**
 * The parts that move on their own; left and right as the figure sees them (left is −x). Legs and arms are the
 * thighs and upper arms; the shins and forearms hang from them.
 */
export const PART = {
  body: 0, leftLeg: 1, rightLeg: 2, leftArm: 3, rightArm: 4, leftShin: 5, rightShin: 6, leftForearm: 7, rightForearm: 8,
} as const;

const SWATCH = {
  skin: 0, shirt: 1, pants: 2, shoes: 3, hair: 4, coat: 5, worn: 6, beanie: 7, bundle: 8, jacket: 9, blouse: 10, skirt: 11,
} as const;
const PALETTE = [
  "#e8b98f", "#2f6fd6", "#3a3f4a", "#26282c", "#5a3a22", "#5b5a3c", "#4a4038", "#33343a", "#7a6a4f", "#d2402f",
  "#c2557f", "#2c3447",
];
const PALETTE_SIZE = 16;

/**
 * What a figure wears: swatches for its top, legs and head, whether it carries a bundle on its back, and whether it's
 * a woman's (a skirt over bare legs, long hair, a bust, a narrower waist and shoulders).
 */
interface Outfit { top: number; legs: number; head: number; bundle: boolean; woman?: boolean }
const PEDESTRIAN: Outfit = { top: SWATCH.shirt, legs: SWATCH.pants, head: SWATCH.hair, bundle: false };
const WOMAN: Outfit = { top: SWATCH.blouse, legs: SWATCH.skirt, head: SWATCH.hair, bundle: false, woman: true };
const VAGRANT: Outfit = { top: SWATCH.coat, legs: SWATCH.worn, head: SWATCH.beanie, bundle: true };
const PLAYER: Outfit = { top: SWATCH.jacket, legs: SWATCH.pants, head: SWATCH.hair, bundle: false };

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

/** A woman, standing: a blouse, a skirt to above the knee, long hair down her back. */
export const womanMesh = (): PersonMesh => figure(WOMAN);

/** A vagrant, standing: a drab coat and trousers, a beanie, a bundle on the back. */
export const vagrantMesh = (): PersonMesh => figure(VAGRANT);

/** The player on foot: a pedestrian in a red jacket, to stand out. */
export const playerMesh = (): PersonMesh => figure(PLAYER);

/**
 * Where a gun's muzzle is, below the right shoulder with the arm hanging (m), by gun: the arm raised, this far ahead
 * of it.
 */
export const MUZZLE = { x: ARM_X, z: HAND - 0.23, rifleZ: HAND - 0.55 } as const;

/**
 * A pistol in the right hand, as a part of the right forearm (so it moves with it): its barrel pointing down the
 * hanging arm, to MUZZLE (forward, with the arm raised to aim), its grip in the hand, pointing back.
 */
export function pistolMesh(): PersonMesh {
  const b = new Builder(), [x0, x1] = [MUZZLE.x - 0.018, MUZZLE.x + 0.018];
  b.box(x0, x1, -0.005, 0.035, MUZZLE.z, HAND - 0.01, SWATCH.shoes);                     // slide and barrel
  b.box(x0 + 0.003, x1 - 0.003, -0.11, -0.005, HAND - 0.06, HAND - 0.02, SWATCH.shoes);  // grip
  b.box(x0 + 0.008, x1 - 0.008, -0.04, -0.005, HAND - 0.08, HAND - 0.06, SWATCH.shoes);  // trigger guard
  return held(b, PART.rightForearm);
}

/**
 * An AR-15-style rifle in the right hand, aimed: as a part of the right forearm, held by the receiver behind its
 * pistol grip, its barrel down the hanging arm to MUZZLE.rifleZ (forward, the arm raised) and its stock up behind the
 * hand (against the shoulder, the arm raised); the magazine and grip toward the back, the sight toward the front.
 */
export function rifleMesh(): PersonMesh {
  const b = new Builder();
  rifle(b);
  return held(b, PART.rightForearm);
}

/**
 * A rifle in patrol ready (PATROL): muzzle down at the ground a foot in front of the left foot, held in front of the
 * chest by both hands (the right on the grip, the left at the front of the receiver), as part of the body.
 */
export function rifleCarryMesh(): PersonMesh {
  const b = new Builder();
  rifle(b);
  const m = b.mesh(), { grip, dir } = PATROL;
  // Its frame, hanging in the hand (x across, y its top, z back up the barrel), onto the patrol line: the barrel along
  // `dir`, its top as near up as it gets, across it what's left; the hand's middle onto the grip.
  const top = normalize(sub([0, 0, 1], scale(dir, dir[2])));
  const across = cross(top, scale(dir, -1));
  const back = scale(dir, -1);
  for (let i = 0; i < m.positions.length; i += 3) {
    const [x, y, z] = [m.positions[i]! - ARM_X, m.positions[i + 1]!, m.positions[i + 2]! - HAND];
    const [nx, ny, nz] = [m.normals[i]!, m.normals[i + 1]!, m.normals[i + 2]!];
    for (let k = 0; k < 3; k++) {
      m.positions[i + k] = grip[k]! + across[k]! * x + top[k]! * y + back[k]! * z;
      m.normals[i + k] = across[k]! * nx + top[k]! * ny + back[k]! * nz;
    }
  }
  return { ...m, parts: new Uint8Array(m.positions.length / 3).fill(PART.body) };
}

/** A rifle's sling: a strap from the left shoulder down across the chest to the right hip, and the same across the back. */
export function slingMesh(): PersonMesh {
  const b = new Builder();
  for (const y of [0.11, -0.11]) strap(b, [-0.14, y * 0.92, 1.45], [0.17, y, 0.95], 0.04, SWATCH.shoes);
  return held(b, PART.body);
}

/**
 * Patrol ready: the rifle's line (the hand's middle on the grip, the barrel along `dir` toward `aim`, a foot in front
 * of the left foot), where the left hand holds it (`front`), and the arms that put the hands there: each [swing
 * forward, roll toward the middle (right +, left −), elbow bend], radians, as the shader turns them.
 */
export const PATROL = (() => {
  const aim: Vec3 = [-0.095, 0.15 + 0.3, 0];
  const grip: Vec3 = [0, 0.25, 1.15];
  const dir = normalize(sub(aim, grip));
  const front = add(grip, scale(dir, 0.19));
  return { aim, grip, dir, front, right: reachArm(ARM_X, grip), left: reachArm(-ARM_X, front) };
})();

/**
 * The arm (from the shoulder at x) that puts the hand's middle at a point: [swing, roll, elbow], radians. The shader
 * bends the forearm forward at the elbow, swings the arm forward at the shoulder, then rolls it about the forward axis
 * through the shoulder; out of reach, the arm points at it.
 */
function reachArm(x: number, t: Vec3): [number, number, number] {
  const [dx, dy, dz] = [t[0] - x, t[1], t[2] - SHOULDER];
  const l1 = SHOULDER - ELBOW, l2 = ELBOW - HAND;
  const d = Math.min(l1 + l2 - 1e-4, Math.max(Math.abs(l1 - l2) + 1e-4, Math.hypot(dx, dy, dz)));
  const elbow = Math.acos(Math.max(-1, Math.min(1, (d * d - l1 * l1 - l2 * l2) / (2 * l1 * l2))));
  // Rolled, the arm's plane takes the hand out to dx: it reaches vz down in that plane.
  const vz = -Math.hypot(dx, dz), roll = Math.atan2(dx / vz, dz / vz);
  const swing = Math.atan2(dy, -vz) - Math.atan2(l2 * Math.sin(elbow), l1 + l2 * Math.cos(elbow));
  return [swing, roll, elbow];
}

/** An AR-15-style rifle, hanging in the right hand (as rifleMesh describes it). */
function rifle(b: Builder): void {
  const x = MUZZLE.x, h = HAND - 0.91;  // modeled for a hand at 0.91 m
  const at = (hw: number, y0: number, y1: number, z0: number, z1: number, swatch: number) => b.box(x - hw, x + hw, y0, y1, z0 + h, z1 + h, swatch);
  at(0.025, -0.02, 0.05, 0.72, 1.02, SWATCH.shoes);            // receiver
  at(0.022, -0.01, 0.05, 0.5, 0.72, SWATCH.pants);             // handguard
  at(0.01, 0.01, 0.03, MUZZLE.rifleZ - h, 0.5, SWATCH.shoes);  // barrel
  at(0.018, -0.03, 0.04, 1.02, 1.28, SWATCH.shoes);            // stock
  at(0.012, -0.15, -0.02, 0.78, 0.86, SWATCH.shoes);           // magazine
  at(0.012, -0.1, -0.02, 0.92, 0.96, SWATCH.shoes);            // pistol grip
  at(0.01, 0.05, 0.08, 0.82, 0.98, SWATCH.shoes);              // sight rail
}

/** A strap from a to b, `w` wide, flat against the body (thin front to back). */
function strap(b: Builder, p: Vec3, q: Vec3, w: number, swatch: number): void {
  const along = sub(q, p), side = scale(normalize(cross(along, [0, 1, 0])), w / 2), thick: Vec3 = [0, 0.01, 0];
  const ring = (c: Vec3): Vec3[] => [
    sub(sub(c, side), thick), sub(add(c, side), thick), add(add(c, side), thick), add(sub(c, side), thick),
  ];
  b.hexa(ring(p), ring(q), swatch);
}

/** A held thing's mesh: all of it one part, so it moves with it. */
function held(b: Builder, part: number): PersonMesh {
  const m = b.mesh();
  return { ...m, parts: new Uint8Array(m.positions.length / 3).fill(part) };
}

type Vec3 = [number, number, number];
// Declared, not assigned, so PATROL (worked out as the module loads) can use them.
function add(a: Vec3, b: Vec3): Vec3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function sub(a: Vec3, b: Vec3): Vec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function scale(a: Vec3, k: number): Vec3 { return [a[0] * k, a[1] * k, a[2] * k]; }
function cross(a: Vec3, b: Vec3): Vec3 { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function normalize(a: Vec3): Vec3 { return scale(a, 1 / Math.hypot(...a)); }

function figure(o: Outfit): PersonMesh {
  const b = new Builder();
  const parts: number[] = [];
  // Every vertex added since the last call belongs to `part`.
  const mark = (part: number) => {
    while (parts.length < b.pos.length / 3) parts.push(part);
  };
  // Under a skirt, bare legs.
  const legs = o.woman ? SWATCH.skin : o.legs;
  for (const side of [1, -1]) {
    // A thigh; under it a shin (a touch narrower, overlapping it at the knee), its shoe sticking out forward.
    const [x0, x1] = side > 0 ? [0.02, 0.17] : [-0.17, -0.02];
    b.box(x0, x1, -0.08, 0.08, KNEE - JOINT, HIP, legs);
    mark(side > 0 ? PART.rightLeg : PART.leftLeg);
    b.box(x0 + 0.005, x1 - 0.005, -0.075, 0.075, 0.08, KNEE + JOINT, legs);
    b.box(x0, x1, -0.09, 0.15, 0, 0.08, SWATCH.shoes);
    mark(side > 0 ? PART.rightShin : PART.leftShin);
    // An upper arm; under it a forearm (overlapping it at the elbow), its hand below.
    const [a0, a1] = side > 0 ? [0.19, 0.29] : [-0.29, -0.19];
    b.box(a0, a1, -0.06, 0.06, ELBOW - JOINT, 1.44, o.top);
    mark(side > 0 ? PART.rightArm : PART.leftArm);
    b.box(a0 + 0.005, a1 - 0.005, -0.055, 0.055, HAND + 0.05, ELBOW + JOINT, o.top);
    b.box(a0 + 0.015, a1 - 0.015, -0.045, 0.045, HAND - 0.05, HAND + 0.05, SWATCH.skin);
    mark(side > 0 ? PART.rightForearm : PART.leftForearm);
  }
  if (o.woman) {
    // A skirt from the waist, flaring to a hem above the knees, roomy enough for the thighs to swing in.
    b.hexa(
      [[-0.22, -0.17, 0.56], [0.22, -0.17, 0.56], [0.22, 0.17, 0.56], [-0.22, 0.17, 0.56]],
      [[-0.17, -0.1, 1.0], [0.17, -0.1, 1.0], [0.17, 0.1, 1.0], [-0.17, 0.1, 1.0]],
      o.legs,
    );
  } else b.box(-0.18, 0.18, -0.09, 0.09, HIP - 0.05, 0.93, o.legs);
  // The torso narrows to the shoulders (a woman's a little more).
  const [waist, shoulders] = o.woman ? [0.17, 0.14] : [0.19, 0.15];
  b.hexa(
    [[-waist, -0.1, 0.93], [waist, -0.1, 0.93], [waist, 0.1, 0.93], [-waist, 0.1, 0.93]],
    [[-shoulders, -0.09, 1.46], [shoulders, -0.09, 1.46], [shoulders, 0.09, 1.46], [-shoulders, 0.09, 1.46]],
    o.top,
  );
  // A bust on the chest: a short slope in under it to its fullest, a longer one up into the chest; no point.
  if (o.woman) {
    const ring = (z: number, hw: number, depth: number): Vec3[] => [[-hw, 0.08, z], [hw, 0.08, z], [hw, depth, z], [-hw, depth, z]];
    const [under, fullest, top] = [ring(1.15, 0.12, 0.125), ring(1.21, 0.13, 0.145), ring(1.33, 0.12, 0.105)];
    b.hexa(under, fullest, o.top);
    b.hexa(fullest, top, o.top);
  }
  if (o.bundle) b.box(-0.14, 0.14, -0.27, -0.1, 1.0, 1.4, SWATCH.bundle);
  // Long hair, down the back of the head to the shoulders.
  if (o.woman) b.box(-0.12, 0.12, -0.15, -0.05, 1.36, 1.78, o.head);
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
