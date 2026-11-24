import { describe, expect, it } from "vitest";
import {
  buildBuildings, buildingMesh, buildPois, businessSigns, enuFrame, enuProjection, enuUnprojection, poisFromArrow, poisToArrow,
  charityWeight, DOOR, furnish, interiorMesh, layoutFor, placeVagrants, PROP, PROP_SIZE, PROPS, SHOPFRONT, shopUnits, SIGN,
  UNIT, VAGRANTS, wallGrid, type Furniture, type BuildingInput, type PoiInput,
} from "../src/index.ts";

const toLonLat = enuUnprojection(enuFrame({ lat: 0, lon: 0, h: 0 }));
const origin = enuProjection(enuFrame({ lat: 0, lon: 0, h: 0 }));
const rect = (x0: number, y0: number, x1: number, y1: number): [number, number][] =>
  [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]].map(([x, y]) => toLonLat(x!, y!));
// A 30 × 20 m shop building and a house 50 m east of it.
const buildings = buildBuildings([
  { osmType: "way", osmId: 1, kind: "retail", isPart: false, height: 8, minHeight: 0, heightSource: "height", polygons: [[rect(0, 0, 30, 20)]] },
  { osmType: "way", osmId: 2, kind: "house", isPart: false, height: 6, minHeight: 0, heightSource: "default", polygons: [[rect(80, 0, 90, 10)]] },
] as BuildingInput[], origin);
const poi = (osmId: number, x: number, y: number, name: string, kind = "cafe"): PoiInput => {
  const [lon, lat] = toLonLat(x, y);
  return { osmId, category: "amenity", kind, name, brand: null, lon, lat };
};

/** The area of a mesh's triangles facing n (wound counterclockwise seen from there), of those whose first corner's x passes. */
function areaFacing(m: { positions: Float32Array; indices: ArrayLike<number> }, n: [number, number, number], keep = (_x: number) => true): number {
  let area = 0;
  for (let t = 0; t < m.indices.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => Array.from(m.positions.subarray(3 * m.indices[t + k]!, 3 * m.indices[t + k]! + 3)));
    const [u, v] = [b!.map((x, k) => x - a![k]!), c!.map((x, k) => x - a![k]!)];
    const cross = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
    const len = Math.hypot(...cross);
    if (keep(a![0]!) && len > 0 && cross.every((x, k) => Math.abs(x / len - n[k]!) < 1e-6)) area += len / 2;
  }
  return area;
}

describe("businesses", () => {
  it("assigns a business to the building it's in, or the nearest within reach, else drops it", () => {
    const p = buildPois([poi(1, 10, 5, "Inside"), poi(2, 40, 10, "Next door"), poi(3, 50, 60, "Nowhere")], buildings, origin);
    expect(p.count).toBe(2);
    expect([...p.building]).toEqual([0, 0]);  // 10 m east of the shop: still the shop's
    expect(p.names).toEqual(["Inside", "Next door"]);
  });

  it("puts each sign on the wall nearest its business, facing out, without overlapping", () => {
    // Two cafés near the south wall (y = 0), close together.
    const p = buildPois([poi(1, 10, 2, "Cafe One"), poi(2, 11, 2, "Cafe Two")], buildings, origin);
    const { signs, shopfront } = businessSigns(buildings, p);
    expect([...shopfront]).toEqual([1, 0]);
    expect(signs.length).toBe(2);
    for (const s of signs) {
      expect(s.y).toBeCloseTo(-(SIGN.out + SIGN.thick / 2), 6);  // just outside the south wall
      expect(s.dir).toBeCloseTo(0, 6);                           // along it, reading west to east
      expect(s.x - s.width / 2).toBeGreaterThanOrEqual(0);
      expect(s.x + s.width / 2).toBeLessThanOrEqual(30);
    }
    const [a, b] = signs.sort((s, t) => s.x - t.x);
    expect(b!.x - b!.width / 2).toBeGreaterThanOrEqual(a!.x + a!.width / 2);
  });

  it("gives the shop's ground floor a shopfront and leaves the house alone", () => {
    const p = buildPois([poi(1, 10, 2, "Cafe")], buildings, origin);
    const m = buildingMesh(buildings, businessSigns(buildings, p).shopfront);
    const shopWalls = new Set<number>(), houseWalls = new Set<number>();
    for (let v = 0; v < m.material.length; v++) {
      if (m.normals[4 * v + 2] !== 0) continue;
      (m.positions[3 * v]! < 50 ? shopWalls : houseWalls).add(m.floor[v]! & SHOPFRONT);
    }
    expect(shopWalls).toEqual(new Set([SHOPFRONT]));
    expect(houseWalls).toEqual(new Set([0]));
  });

  it("puts a door under each sign, its opening cut out of the wall and lined", () => {
    const p = buildPois([poi(1, 10, 2, "Cafe")], buildings, origin);
    const { signs, doors } = businessSigns(buildings, p);
    expect(doors.count).toBe(1);
    expect([doors.building[0], doors.x[0], doors.y[0], doors.ux[0], doors.uy[0]]).toEqual([0, signs[0]!.x, 0, 1, 0]);
    // The south wall's area facing out (−y), and the reveal's faces (into the opening ±x, the lintel down).
    const m = buildingMesh(buildings, undefined, doors);
    const facing = (n: [number, number, number]) => areaFacing(m, n, (x) => x < 50);
    expect(facing([0, -1, 0])).toBeCloseTo(30 * 8 - DOOR.width * DOOR.height, 4);
    expect(facing([1, 0, 0]) - 20 * 8).toBeCloseTo(DOOR.reveal * DOOR.height, 4);  // the east wall, and a jamb
    expect(facing([-1, 0, 0]) - 20 * 8).toBeCloseTo(DOOR.reveal * DOOR.height, 4);
    expect(facing([0, 0, -1])).toBeCloseTo(DOOR.reveal * DOOR.width, 4);
  });

  it("gives each door its share of the ground floor: nearest door, at most UNIT.depth in", () => {
    const unitArea = (u: ReturnType<typeof shopUnits>, k: number) => {
      const p = u.points.subarray(2 * u.pointStart[k]!, 2 * u.pointStart[k + 1]!);
      let s = 0;
      for (let i = 0, n = p.length / 2; i < n; i++) s += p[2 * i]! * p[2 * ((i + 1) % n) + 1]! - p[2 * ((i + 1) % n)]! * p[2 * i + 1]!;
      return s / 2;
    };
    // One café on the south wall: the whole 30 × 20 m floor.
    let d = businessSigns(buildings, buildPois([poi(1, 10, 2, "Cafe")], buildings, origin)).doors;
    let u = shopUnits(buildings, d);
    expect(u.count).toBe(1);
    expect(unitArea(u, 0)).toBeCloseTo(600, 3);
    // One on the west wall: only UNIT.depth (20 m) in from it.
    d = businessSigns(buildings, buildPois([poi(1, 1, 10, "Cafe")], buildings, origin)).doors;
    u = shopUnits(buildings, d);
    expect(unitArea(u, 0)).toBeCloseTo(UNIT.depth * 20, 3);
    // Two on the south wall: split halfway between their doors.
    d = businessSigns(buildings, buildPois([poi(1, 10, 2, "Cafe One"), poi(2, 11, 2, "Cafe Two")], buildings, origin)).doors;
    u = shopUnits(buildings, d);
    expect(u.count).toBe(2);
    const mid = (d.x[0]! + d.x[1]!) / 2;
    const [west, east] = d.x[u.door[0]!]! < d.x[u.door[1]!]! ? [0, 1] : [1, 0];
    expect(unitArea(u, west)).toBeCloseTo(mid * 20, 3);
    expect(unitArea(u, east)).toBeCloseTo((30 - mid) * 20, 3);
    expect([...d.poi].sort()).toEqual([0, 1]);
  });

  it("opens the walls at doors, walls the shop in, and builds its shell facing in", () => {
    const d = businessSigns(buildings, buildPois([poi(1, 10, 2, "Cafe")], buildings, origin)).doors;
    const u = shopUnits(buildings, d);
    // Collisions: the south wall less the doorway; the shop's own wall behind it, at the reveal, less the doorway.
    const g = wallGrid(buildings, d, u);
    const along = (y: number) => {
      let len = 0;
      for (let s = 0; s < g.segments.length; s += 4) {
        const [ax, ay, bx, by] = [g.segments[s]!, g.segments[s + 1]!, g.segments[s + 2]!, g.segments[s + 3]!];
        if (ax < 50 && Math.abs(ay - y) < 1e-4 && Math.abs(by - y) < 1e-4) len += Math.abs(bx - ax);  // the shop's
      }
      return len;
    };
    expect(along(0)).toBeCloseTo(30 - DOOR.width, 4);
    expect(along(DOOR.reveal)).toBeCloseTo(30 - DOOR.width, 4);
    // The shell: floor up and ceiling down, 30 × 20 m; the door's wall facing into the room, open at the door with the
    // wall over it; the other walls facing in too.
    const m = interiorMesh(u, 0, d), z = u.z[0]!, h = u.height[0]!;
    const [z0, z1] = [z + 0.03, z + h - 0.05];
    expect(areaFacing(m, [0, 0, 1])).toBeCloseTo(600, 3);
    expect(areaFacing(m, [0, 0, -1])).toBeCloseTo(600, 3);
    expect(areaFacing(m, [0, 1, 0])).toBeCloseTo((30 - DOOR.width) * (z1 - z0) + DOOR.width * (z1 - z - DOOR.height), 3);
    expect(areaFacing(m, [0, -1, 0])).toBeCloseTo(30 * (z1 - z0), 3);
    // (The side walls reach the outline's corners, past the door's wall, where it hides them.)
    expect(areaFacing(m, [1, 0, 0]) + areaFacing(m, [-1, 0, 0])).toBeCloseTo(2 * 20 * (z1 - z0), 3);
  });

  it("furnishes a shop by its kind: everything inside, clear of the way in, nothing overlapping", () => {
    expect([layoutFor("amenity", "cafe"), layoutFor("amenity", "bank"), layoutFor("shop", "weapons"),
      layoutFor("shop", "convenience"), layoutFor("shop", "clothes"), layoutFor("office", "lawyer")])
      .toEqual(["tables", "counter", "counter", "aisles", "store", "counter"]);
    const d = businessSigns(buildings, buildPois([poi(1, 10, 2, "Cafe")], buildings, origin)).doors;
    const u = shopUnits(buildings, d), [dx] = [d.x[0]!];
    const count = (fu: Furniture, p: keyof typeof PROP) => fu.prop.filter((x) => x === PROP[p]).length;
    for (const layout of ["tables", "counter", "aisles", "store"] as const) {
      const { furniture: fu, staff } = furnish(u, 0, d, layout, layout === "counter" ? "weapons" : "");
      // The shop is the whole 30 × 20 m building, its door on the south wall (y = 0) at x = dx: s = x − dx, t = y.
      const boxes: [number, number, number, number][] = [];
      for (let k = 0; k < fu.count; k++) {
        const p = PROPS[fu.prop[k]!]!, [w, dp] = PROP_SIZE[p];
        const [hx, hy] = Math.abs(fu.fy[k]!) > 0.5 ? [w / 2, dp / 2] : [dp / 2, w / 2];
        const box: [number, number, number, number] = [fu.x[k]! - hx, fu.y[k]! - hy, fu.x[k]! + hx, fu.y[k]! + hy];
        expect(box[0]).toBeGreaterThan(0);
        expect(box[2]).toBeLessThan(30);
        expect(box[1]).toBeGreaterThan(DOOR.reveal);
        expect(box[3]).toBeLessThan(20);
        expect(box[2] > dx - 0.9 && box[0] < dx + 0.9 && box[1] < 2.2, `${p} in the way in`).toBe(false);
        if (p !== "register") boxes.push(box);
      }
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const [a, b] = [boxes[i]!, boxes[j]!];
          expect(a[0] < b[2] - 1e-3 && b[0] < a[2] - 1e-3 && a[1] < b[3] - 1e-3 && b[1] < a[3] - 1e-3, `${layout}: ${i} and ${j} overlap`).toBe(false);
        }
      }
      expect(staff.count).toBeGreaterThan(0);
      for (let k = 0; k < staff.count; k++) expect(staff.x[k]! > 0 && staff.x[k]! < 30 && staff.y[k]! > 0 && staff.y[k]! < 20).toBe(true);
      if (layout === "tables") expect([count(fu, "table") > 4, count(fu, "chair"), count(fu, "register")]).toEqual([true, 2 * count(fu, "table"), 1]);
      if (layout === "counter") expect([count(fu, "case") > 10, count(fu, "shelf") > 10]).toEqual([true, true]);
      if (layout === "aisles") expect(count(fu, "shelf")).toBeGreaterThan(40);
      if (layout === "store") expect([count(fu, "shelf") > 20, count(fu, "register")]).toEqual([true, 1]);
    }
    // The same every time.
    expect(furnish(u, 0, d, "tables")).toEqual(furnish(u, 0, d, "tables"));
  });

  it("round-trips through Arrow", () => {
    const p = buildPois([poi(1, 10, 2, "Cafe"), poi(2, 85, 5, "Bakery", "bakery")], buildings, origin);
    const back = poisFromArrow(poisToArrow(p, {}));
    expect(back.count).toBe(2);
    expect(back.names).toEqual(p.names);
    expect([...back.building]).toEqual([...p.building]);
    expect(back.kinds).toEqual(["cafe", "bakery"]);
  });
});

describe("charities", () => {
  it("weighs places by how much they draw people with nowhere to live", () => {
    const w = (category: string, kind: string, tags: Record<string, string> = {}) => charityWeight(category, kind, tags);
    expect(w("amenity", "social_facility", { social_facility: "shelter", "social_facility:for": "homeless" })).toBe(4);
    expect(w("amenity", "social_facility", { social_facility: "food_bank" })).toBe(3);
    expect(w("amenity", "social_facility", { social_facility: "outreach" })).toBe(2);
    expect(w("amenity", "social_facility", { social_facility: "nursing_home" })).toBe(0);
    expect(w("amenity", "social_facility", { social_facility: "assisted_living", "social_facility:for": "homeless" })).toBe(3);
    expect(w("amenity", "social_facility", { social_facility: "shelter", name: "Ronald McDonald House" })).toBe(0);
    expect(w("shop", "charity", { name: "Goodwill" })).toBe(0.5);
    expect(w("office", "ngo", { name: "The Salvation Army" })).toBe(2);
    expect(w("office", "company", { name: "Salvation Army Crossroads Resource Center" })).toBe(2);
    expect(w("amenity", "childcare", { name: "Catholic Charities Margery Reed Day Care Center" })).toBe(0);
    expect(w("amenity", "cafe", { name: "Coffee" })).toBe(0);
  });

  it("carries each place's weight through the cell file", () => {
    const p = buildPois([{ ...poi(1, 10, 5, "Shelter", "social_facility"), charity: 4 }, poi(2, 12, 5, "Cafe")], buildings, origin);
    const back = poisFromArrow(poisToArrow(p, {}));
    expect([...back.charity]).toEqual([4, 0]);
  });

  it("places vagrants around them, never indoors, each anchored to its place", () => {
    const p = buildPois([{ ...poi(1, 10, 5, "Shelter", "social_facility"), charity: 4 }, poi(2, 12, 5, "Cafe")], buildings, origin);
    const v = placeVagrants(p, buildings, 1);
    expect(v.count).toBe(4 * VAGRANTS.perWeight);
    for (let i = 0; i < v.count; i++) {
      expect([v.ax[i], v.ay[i]]).toEqual([p.x[0], p.y[0]]);
      expect(Math.hypot(v.x[i]! - p.x[0]!, v.y[i]! - p.y[0]!)).toBeLessThanOrEqual(VAGRANTS.spread + 1e-3);
      const inShop = v.x[i]! > 0 && v.x[i]! < 30 && v.y[i]! > 0 && v.y[i]! < 20;
      expect(inShop).toBe(false);
    }
    expect(placeVagrants(p, buildings, 1)).toEqual(v);
  });
});
