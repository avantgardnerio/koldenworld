// Colors are a view concern: they live here, not in the map data.

import { ROAD_CLASSES, type RoadClass } from "@game/world";

export const BACKGROUND: readonly [number, number, number] = [0.07, 0.08, 0.1];

const CLASS_COLORS: Record<RoadClass, string> = {
  motorway: "#e8803a", motorway_link: "#e8803a",
  trunk: "#e8a03a", trunk_link: "#e8a03a",
  primary: "#e8c84a", primary_link: "#e8c84a",
  secondary: "#d8d870", secondary_link: "#d8d870",
  tertiary: "#e0e0e0", tertiary_link: "#e0e0e0",
  unclassified: "#a8acb4", residential: "#a8acb4", living_street: "#a8acb4",
  service: "#5a606a", road: "#5a606a",
};

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

/** vec3 per class, in ROAD_CLASSES order, ready for a uniform array. */
export function classColors(): Float32Array {
  return new Float32Array(ROAD_CLASSES.flatMap((c) => rgb(CLASS_COLORS[c])));
}
