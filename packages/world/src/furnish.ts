// Furnishing a shop: its unit (units.ts) gets props (props.ts) and staff by a
// layout picked from its business's kind:
//
// - tables: a counter across the back with a till and staff behind it, tables
//   with a chair either side in front (cafés, restaurants, bars, delis);
// - counter: a counter across the room, staff behind it (banks, post offices,
//   pharmacies); glass cases and racks on the back wall for gun shops and
//   jewelers;
// - aisles: back-to-back shelves in rows running in from the door, a till by
//   the entrance (convenience stores, supermarkets);
// - store: shelves along the walls, a till by the entrance (anything else).
//
// Placement works in the unit's frame: s along its door's wall (from the
// door), t in from it. A prop goes where its footprint, its corners kept
// MARGIN inside the outline, overlaps no other and leaves the way in from the
// door (ENTRANCE) clear; props turn only in quarter turns, so footprints stay
// rectangles there. Pure and deterministic.

import { DOOR, type Doors } from "./doors.ts";
import { PROP, PROP_SIZE, type Prop } from "./props.ts";
import type { Units } from "./units.ts";

export type Layout = "tables" | "counter" | "aisles" | "store";

const TABLES = new Set(["restaurant", "cafe", "fast_food", "bar", "pub", "ice_cream", "food_court", "biergarten", "bakery", "coffee", "deli", "tea", "pastry"]);
const COUNTERS = new Set(["bank", "post_office", "pharmacy", "bureau_de_change", "money_transfer", "weapons", "jewelry", "pawnbroker", "mobile_phone", "travel_agency"]);
const AISLES = new Set(["convenience", "supermarket", "general", "variety_store", "alcohol", "chemist", "hardware", "doityourself", "department_store", "books", "pet"]);
/** Counters that are glass cases, with racks behind. */
const CASES = new Set(["weapons", "jewelry", "pawnbroker"]);

/** The layout for a business, by its POI category and kind. */
export function layoutFor(category: string, kind: string): Layout {
  if (TABLES.has(kind)) return "tables";
  if (COUNTERS.has(kind) || category === "office") return "counter";
  if (AISLES.has(kind)) return "aisles";
  return "store";
}

/** Props' corners stay this far inside a unit's outline, m; props may touch (to within TOUCH m) but not overlap. */
const MARGIN = 0.05, TOUCH = 0.001;
/** Shelves against a wall stand this far out from it (their middle), m: half their depth, the margin, and some. */
const WALL = 0.3;
/** Kept clear in from the door: this far either side of it, this deep (m). */
const ENTRANCE = { half: 0.9, depth: 2.2 };
/** The floor this far above the unit's z, as interiors.ts lays it, m. */
const FLOOR_LIFT = 0.03;

/** A unit's furniture, as columns: which prop, where it stands (m in the cell's frame), the way it faces. */
export interface Furniture {
  count: number;
  prop: Uint8Array;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  fx: Float32Array;
  fy: Float32Array;
}

/** A unit's staff, as columns: where each stands, the way they face, and their figure (sim's BODY: 0 man, 1 woman). */
export interface Staff {
  count: number;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  fx: Float32Array;
  fy: Float32Array;
  body: Uint8Array;
}

/** The way a prop faces in the unit's frame: toward the door (−t), in (+t), or along the door's wall (±s). */
type Facing = "out" | "in" | "left" | "right";

/** Unit k furnished by `layout`. */
export function furnish(u: Units, k: number, d: Doors, layout: Layout, kind = ""): { furniture: Furniture; staff: Staff } {
  const door = u.door[k]!, [ox, oy, ux, uy] = [d.x[door]!, d.y[door]!, d.ux[door]!, d.uy[door]!];
  const z = u.z[k]! + FLOOR_LIFT;
  // The outline in (s, t), and its extent.
  const a = u.pointStart[k]!, e = u.pointStart[k + 1]!, n = e - a, st = new Float64Array(2 * n);
  let [s0, s1, tBack] = [Infinity, -Infinity, -Infinity];
  for (let p = 0; p < n; p++) {
    const [rx, ry] = [u.points[2 * (a + p)]! - ox, u.points[2 * (a + p) + 1]! - oy];
    const [s, t] = [rx * ux + ry * uy, -rx * uy + ry * ux];
    [st[2 * p], st[2 * p + 1]] = [s, t];
    [s0, s1, tBack] = [Math.min(s0, s), Math.max(s1, s), Math.max(tBack, t)];
  }
  const inside = (s: number, t: number) => {
    let c = false;
    for (let p = 0, q = n - 1; p < n; q = p++) {
      const [sp, tp, sq, tq] = [st[2 * p]!, st[2 * p + 1]!, st[2 * q]!, st[2 * q + 1]!];
      if ((tp > t) !== (tq > t) && s < sp + ((t - tp) * (sq - sp)) / (tq - tp)) c = !c;
    }
    return c;
  };
  // The outline's extent along s at depth t (where a line across the room at t crosses it).
  const across = (t: number): [number, number] => {
    let [lo, hi] = [Infinity, -Infinity];
    for (let p = 0, q = n - 1; p < n; q = p++) {
      const [sp, tp, sq, tq] = [st[2 * p]!, st[2 * p + 1]!, st[2 * q]!, st[2 * q + 1]!];
      if ((tp > t) === (tq > t)) continue;
      const s = sp + ((t - tp) * (sq - sp)) / (tq - tp);
      [lo, hi] = [Math.min(lo, s), Math.max(hi, s)];
    }
    return [lo, hi];
  };

  const out = { prop: [] as number[], x: [] as number[], y: [] as number[], z: [] as number[], fx: [] as number[], fy: [] as number[] };
  const staff = { x: [] as number[], y: [] as number[], z: [] as number[], fx: [] as number[], fy: [] as number[], body: [] as number[] };
  const taken: number[] = [];  // footprints placed: s0, t0, s1, t1 each
  const forward = (f: Facing): [number, number] => {
    const [fs, ft] = f === "in" ? [0, 1] : f === "out" ? [0, -1] : f === "right" ? [1, 0] : [-1, 0];
    return [fs * ux - ft * uy, fs * uy + ft * ux];
  };
  const toCell = (s: number, t: number): [number, number] => [ox + s * ux - t * uy, oy + s * uy + t * ux];
  // Half its footprint along s and t, facing f.
  const half = (p: Prop, f: Facing): [number, number] => {
    const [w, dp] = PROP_SIZE[p];
    return f === "in" || f === "out" ? [w / 2, dp / 2] : [dp / 2, w / 2];
  };
  const fits = (p: Prop, s: number, t: number, f: Facing) => {
    const [hs, ht] = half(p, f);
    const [a0, b0, a1, b1] = [s - hs, t - ht, s + hs, t + ht];
    if (b0 < DOOR.reveal + MARGIN) return false;
    if (a1 > -ENTRANCE.half && a0 < ENTRANCE.half && b0 < ENTRANCE.depth) return false;
    for (const [cs, ct] of [[a0 - MARGIN, b0 - MARGIN], [a1 + MARGIN, b0 - MARGIN], [a1 + MARGIN, b1 + MARGIN], [a0 - MARGIN, b1 + MARGIN]] as const) {
      if (!inside(cs, ct)) return false;
    }
    for (let r = 0; r < taken.length; r += 4) {
      if (a0 < taken[r + 2]! - TOUCH && taken[r]! < a1 - TOUCH && b0 < taken[r + 3]! - TOUCH && taken[r + 1]! < b1 - TOUCH) return false;
    }
    return true;
  };
  const put = (p: Prop, s: number, t: number, f: Facing, footprint = true) => {
    const [x, y] = toCell(s, t), [fx, fy] = forward(f);
    out.prop.push(PROP[p]);
    out.x.push(x);
    out.y.push(y);
    out.z.push(z);
    out.fx.push(fx);
    out.fy.push(fy);
    if (!footprint) return;
    const [hs, ht] = half(p, f);
    taken.push(s - hs, t - ht, s + hs, t + ht);
  };
  const tryPut = (p: Prop, s: number, t: number, f: Facing) => {
    if (!fits(p, s, t, f)) return false;
    put(p, s, t, f);
    return true;
  };
  // Someone standing at (s, t), if that's inside.
  const person = (s: number, t: number, f: Facing) => {
    if (!inside(s, t)) return;
    const [x, y] = toCell(s, t), [fx, fy] = forward(f);
    staff.x.push(x);
    staff.y.push(y);
    staff.z.push(z);
    staff.fx.push(fx);
    staff.fy.push(fy);
    staff.body.push(hash(door, staff.body.length) & 1);
  };
  // A counter across the room at depth t, facing the door, in metre lengths where they fit; a till on the first, and
  // staff behind it every few metres. Returns how many lengths.
  const counter = (t: number, glass: boolean) => {
    const placed: number[] = [];
    for (let s = s0 + 0.5; s <= s1 - 0.5; s += 1) if (tryPut(glass ? "case" : "counter", s, t, "out")) placed.push(s);
    if (placed.length === 0) return 0;
    if (!glass) put("register", placed[0]!, t, "out", false);
    for (let i = 0; i < placed.length; i += 3) person(placed[i]!, t + 0.75, "out");
    return placed.length;
  };
  // A till by the entrance, on whichever side fits, its staff behind it facing the middle.
  const till = () => {
    for (const side of [1, -1]) {
      const s = side * (ENTRANCE.half + 1.0), f: Facing = side > 0 ? "left" : "right";
      if (!fits("counter", s, 1.6, f) || !fits("counter", s, 2.6, f) || !inside(s + side * 0.75, 2.1)) continue;
      put("counter", s, 1.6, f);
      put("counter", s, 2.6, f);
      put("register", s, 1.6, f, false);
      person(s + side * 0.75, 2.1, f);
      return;
    }
  };

  if (layout === "tables") {
    const tc = tBack - 1.3;
    counter(tc, false);
    for (let t = ENTRANCE.depth + 0.6; t <= tc - 1.6; t += 2.4) {
      for (let s = s0 + 1; s <= s1 - 1; s += 2.2) {
        if (fits("table", s, t, "in") && fits("chair", s, t - 0.62, "in") && fits("chair", s, t + 0.62, "out")) {
          put("table", s, t, "in");
          put("chair", s, t - 0.62, "in");
          put("chair", s, t + 0.62, "out");
        }
      }
    }
  } else if (layout === "counter") {
    const glass = CASES.has(kind), tc = Math.min(tBack - 1.2, Math.max(3.2, Math.min(8, tBack * 0.55)));
    counter(tc, glass);
    if (glass) for (let s = s0 + 0.5; s <= s1 - 0.5; s += 1) tryPut("shelf", s, tBack - WALL, "out");
  } else {
    till();
    if (layout === "aisles") {
      // Back-to-back shelves in rows running in from the door, a metre at a time.
      for (let s = s0 + 1.4; s <= s1 - 1.4; s += 2.4) {
        for (let t = ENTRANCE.depth + 1; t <= tBack - 1.4; t += 1) {
          if (fits("shelf", s - 0.21, t, "left") && fits("shelf", s + 0.21, t, "right")) {
            put("shelf", s - 0.21, t, "left");
            put("shelf", s + 0.21, t, "right");
          }
        }
      }
    }
    // Along the walls: the back, then each side, facing in.
    for (let s = s0 + 0.5; s <= s1 - 0.5; s += 1) tryPut("shelf", s, tBack - WALL, "out");
    for (let t = 1; t <= tBack - 0.8; t += 1) {
      const [lo, hi] = across(t);
      if (lo < hi) {
        tryPut("shelf", lo + WALL, t, "right");
        tryPut("shelf", hi - WALL, t, "left");
      }
    }
  }
  return {
    furniture: {
      count: out.prop.length, prop: Uint8Array.from(out.prop), x: Float32Array.from(out.x), y: Float32Array.from(out.y),
      z: Float32Array.from(out.z), fx: Float32Array.from(out.fx), fy: Float32Array.from(out.fy),
    },
    staff: {
      count: staff.x.length, x: Float32Array.from(staff.x), y: Float32Array.from(staff.y), z: Float32Array.from(staff.z),
      fx: Float32Array.from(staff.fx), fy: Float32Array.from(staff.fy), body: Uint8Array.from(staff.body),
    },
  };
}

/** A stable 32-bit hash of two numbers. */
function hash(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  return (h ^ (h >>> 15)) >>> 0;
}
