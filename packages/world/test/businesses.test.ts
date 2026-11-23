import { describe, expect, it } from "vitest";
import {
  buildBuildings, buildingMesh, buildPois, businessSigns, enuFrame, enuProjection, enuUnprojection, poisFromArrow, poisToArrow,
  charityWeight, placeVagrants, SHOPFRONT, SIGN, VAGRANTS, type BuildingInput, type PoiInput,
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
