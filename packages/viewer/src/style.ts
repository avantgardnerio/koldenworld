// Colors and atmosphere are a view concern: they live here, not in the map data.

import { BUILDING_GROUPS, ROAD_CLASSES, type BuildingGroup, type RoadClass } from "@game/world";

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const palette = (hexes: string[]) => new Float32Array(hexes.flatMap(rgb));

export const SKY = palette(["#a9c8e6"]);
/**
 * vec3 per ground material from the Rust cell generator: asphalt, yellow, white, grass, sidewalk, lot, water, and the
 * airports' runway, taxiway, apron (concrete, the runway lightest).
 */
export const GROUND = palette([
  "#48484c", "#e8be28", "#f0f0ec", "#68964a", "#c4c2ba", "#7eaa5c", "#4078be", "#a4a6aa", "#7d8086", "#8f9196",
]);

/** vec3 per massing material from the Rust cell generator (a coarse tile's buildings): wall, roof. */
export const MASSING = palette(["#d2c6b2", "#8e7e6e"]);


const CLASS_COLORS: Record<RoadClass, string> = {
  motorway: "#e8803a", motorway_link: "#e8803a",
  trunk: "#e8a03a", trunk_link: "#e8a03a",
  primary: "#e8c84a", primary_link: "#e8c84a",
  secondary: "#d8d870", secondary_link: "#d8d870",
  tertiary: "#ffffff", tertiary_link: "#ffffff",
  unclassified: "#ff60c0", residential: "#ff60c0", living_street: "#ff60c0",
  service: "#60d0ff", road: "#60d0ff",
};
/** Graph overlay: vec3 per road class, in ROAD_CLASSES order. Bright, to stand out on asphalt. */
export const CLASS_COLORS_RGB = palette(ROAD_CLASSES.map((c) => CLASS_COLORS[c]));

const BUILDING_COLORS: Record<BuildingGroup, [wall: string, roof: string]> = {
  residential: ["#d9cbb4", "#8c7462"],
  commercial: ["#c8ccd3", "#8e9298"],
  industrial: ["#bdb6a8", "#8a867e"],
  civic: ["#d8bc96", "#9c7e62"],
  utility: ["#b4ada3", "#7b7670"],
  other: ["#cfc8bb", "#918b84"],
};
/** vec3 per building material: group × 2 + (1 for roof), as emitted by buildingMesh. */
export const BUILDING_COLORS_RGB = palette(BUILDING_GROUPS.flatMap((g) => BUILDING_COLORS[g]));

/** Unit vector toward the sun: high in the south-southeast, so north and west walls fall in shade. */
export const SUN: [number, number, number] = (() => {
  const v = [0.3, -0.55, 0.78];
  const n = Math.hypot(...v);
  return [v[0]! / n, v[1]! / n, v[2]! / n];
})();

/** Fog closes in at the edge of what is loaded, so the world fades out instead of ending. */
export function fogRange(loadRadius: number): [start: number, end: number] {
  return [0.75 * loadRadius, loadRadius];
}
