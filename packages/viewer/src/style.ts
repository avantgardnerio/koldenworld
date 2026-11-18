// Colors and atmosphere are a view concern: they live here, not in the map data.

import { ROAD_CLASSES, SurfaceMaterial, type RoadClass } from "@game/world";

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const palette = (hexes: string[]) => new Float32Array(hexes.flatMap(rgb));

export const SKY = palette(["#a9c8e6"]);
export const GROUND = palette(["#5b7f3a"]);

const SURFACE: Record<keyof typeof SurfaceMaterial, string> = {
  Asphalt: "#2e3034",
  Yellow: "#e2b62a",
  White: "#e6e6e2",
};
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

/** Fog grows with altitude, so the overview stays clear and street level gets a horizon. */
export function fogRange(altitude: number): [start: number, end: number] {
  const start = 1500 + 3 * altitude;
  return [start, start * 6];
}

/** Lane markings blend into the asphalt before they get thinner than a pixel. */
export const MARKING_FADE: [start: number, end: number] = [60, 220];
