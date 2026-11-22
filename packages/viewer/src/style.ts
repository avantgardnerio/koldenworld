// Colors and atmosphere are a view concern: they live here, not in the map data.

import { BUILDING_GROUPS, ROAD_CLASSES, SurfaceMaterial, type BuildingGroup, type RoadClass } from "@game/world";
import type { TerrainStyle } from "./terrain-layer.ts";

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const palette = (hexes: string[]) => new Float32Array(hexes.flatMap(rgb));

export const SKY = palette(["#a9c8e6"]);
/**
 * Ground color by elevation and slope (decision 26), tuned for Colorado: plains grass, montane
 * forest from ~2,300 m, alpine tundra above treeline (~3,450 m), rock from ~3,700 m and on
 * slopes steeper than ~35–45°, snow from ~3,950 m. Heights are above the ellipsoid (about
 * 17 m below sea-level heights here). Land cover data will replace the guesswork below treeline.
 */
export const TERRAIN_STYLE: TerrainStyle = {
  colors: palette(["#5b7f3a", "#3d5a2c", "#7d7b56", "#8a857e", "#eef1f5"]),
  bands: [2300, 3450, 3700, 3950],
  jitter: [200, 120, 150, 150],
  steep: [0.70, 0.82],
};

/** vec3 per WaterMaterial: lake, river, stream. */
export const WATER = palette(["#3b6a8c", "#4a7690", "#55809a"]);

/** vec3 per AerowayMaterial: apron, taxiway, runway (concrete, the runway lightest). */
export const AEROWAY = palette(["#8f9196", "#7d8086", "#a4a6aa"]);

const SURFACE: Record<keyof typeof SurfaceMaterial, string> = {
  Asphalt: "#2e3034",
  Yellow: "#e2b62a",
  White: "#e6e6e2",
  Fill: "#7c705a",   // earth: the embankment under a road above the ground
};
/** Surface materials that are markings (1..MARKINGS): they fade into the asphalt at a distance. */
export const MARKINGS = 2;
/** vec3 per SurfaceMaterial, in material order. */
export const SURFACE_COLORS = palette(
  Object.entries(SurfaceMaterial).sort((a, b) => a[1] - b[1]).map(([k]) => SURFACE[k as keyof typeof SurfaceMaterial]),
);

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

/** Lane markings blend into the asphalt before they get thinner than a pixel. */
export const MARKING_FADE: [start: number, end: number] = [60, 220];
