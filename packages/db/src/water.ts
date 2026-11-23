import type { WaterAreaInput, WaterwayInput } from "@game/world";
import pg from "pg";
import { clientConfig, DATABASE_URL } from "./config.ts";
import type { Bbox } from "./export.ts";

/** Water areas and waterways touching a box, ordered by OSM key so output is reproducible. */
export async function loadWater(bbox: Bbox, url = DATABASE_URL): Promise<{ areas: WaterAreaInput[]; lines: WaterwayInput[] }> {
  const client = new pg.Client(clientConfig(url));
  await client.connect();
  try {
    const env = [bbox.west, bbox.south, bbox.east, bbox.north];
    const a = await client.query<{ osm_id: string; kind: "lake" | "river"; coords: [number, number][][][] }>(
      `SELECT osm_id::text, kind, ST_AsGeoJSON(geom)::json -> 'coordinates' AS coords FROM water_areas
       WHERE ST_Intersects(geom, ST_MakeEnvelope($1, $2, $3, $4, 4326)) ORDER BY osm_type, osm_id`, env);
    const l = await client.query<{ osm_way_id: string; kind: string; width_m: number; coords: [number, number][] }>(
      `SELECT osm_way_id::text, kind, width_m, ST_AsGeoJSON(geom)::json -> 'coordinates' AS coords FROM waterways
       WHERE ST_Intersects(geom, ST_MakeEnvelope($1, $2, $3, $4, 4326)) ORDER BY osm_way_id`, env);
    return {
      areas: a.rows.map((r) => ({ osmId: Number(r.osm_id), kind: r.kind, polygons: r.coords })),
      lines: l.rows.map((r) => ({ osmId: Number(r.osm_way_id), kind: r.kind, width: r.width_m, points: r.coords })),
    };
  } finally {
    await client.end();
  }
}
