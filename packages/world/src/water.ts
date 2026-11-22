// Water helpers: the terrain carved a little under lakes and river surfaces, for the heights cars and the camera use.
// The drawn water is part of the ground from the Rust generator (crates/cellgen), where road and airports win over it.

import { cellLattice, type CellId } from "./s2.ts";
import type { CellTerrain } from "./terrain.ts";

export interface WaterAreaInput {
  osmId: number;
  kind: "lake" | "river";
  polygons: [lon: number, lat: number][][][];  // polygon → rings (outer first, closed) → points
}

export interface WaterwayInput {
  osmId: number;
  kind: string;     // waterway=* value
  width: number;    // m
  points: [lon: number, lat: number][];
}

/** How far the terrain lattice is lowered inside lakes and river surfaces, m. */
export const WATER_CARVE = 1;

/**
 * Lowers the terrain lattice inside water areas, so the drawn ground near a
 * shore (which the 17 m lattice smooths up toward the bank) can't cover the
 * water. Each cell decides for its own lattice points from the same polygons,
 * so neighbors agree along shared edges. For groundSampler's `carve`.
 */
export function carveWater(areas: WaterAreaInput[]): (cell: CellId, t: CellTerrain) => CellTerrain {
  const polys = areas.flatMap((a) => a.polygons).map((rings) => {
    const lons = rings[0]!.map((p) => p[0]), lats = rings[0]!.map((p) => p[1]);
    return { rings, w: Math.min(...lons), e: Math.max(...lons), s: Math.min(...lats), n: Math.max(...lats) };
  });
  const inRing = (lon: number, lat: number, r: [number, number][]) => {
    let inside = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i]!, [xj, yj] = r[j]!;
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  return (cell, t) => {
    if (polys.length === 0) return t;
    const ll = cellLattice(cell, t.n), heights = Float32Array.from(t.heights);
    for (let k = 0; k < heights.length; k++) {
      const lat = ll[2 * k]!, lon = ll[2 * k + 1]!;
      for (const p of polys) {
        if (lon < p.w || lon > p.e || lat < p.s || lat > p.n || !inRing(lon, lat, p.rings[0]!)) continue;
        if (p.rings.slice(1).some((h) => inRing(lon, lat, h))) continue;
        heights[k] = heights[k]! - WATER_CARVE;
        break;
      }
    }
    return { n: t.n, heights };
  };
}
