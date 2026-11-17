import type { RoadClass, RoadWayInput } from "@game/world";
import pg from "pg";
import { DATABASE_URL } from "./config.ts";

export interface Bbox { south: number; west: number; north: number; east: number }

export interface FetchInfo {
  id: number;
  area: string;
  bbox: Bbox;
  osmBaseTimestamp: string | null;
  sha256: string;
}

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** The most recently fetched snapshot for an area. */
export function latestFetch(area: string, url = DATABASE_URL): Promise<FetchInfo> {
  return withClient(url, async (c) => {
    const { rows: [r] } = await c.query<{
      id: string; area: string; south: number; west: number; north: number; east: number;
      osm_base_timestamp: Date | null; sha256: string;
    }>(
      `SELECT id, area, ST_YMin(bbox) south, ST_XMin(bbox) west, ST_YMax(bbox) north, ST_XMax(bbox) east,
              osm_base_timestamp, sha256
       FROM osm_fetches WHERE area = $1 ORDER BY fetched_at DESC, id DESC LIMIT 1`, [area]);
    if (!r) throw new Error(`no fetch recorded for area ${area}; run import-roads first`);
    return {
      id: Number(r.id),
      area: r.area,
      bbox: { south: r.south, west: r.west, north: r.north, east: r.east },
      osmBaseTimestamp: r.osm_base_timestamp?.toISOString() ?? null,
      sha256: r.sha256,
    };
  });
}

/** Road ways intersecting the box, ordered by OSM id so graph output is reproducible. */
export function loadRoadWays(bbox: Bbox, url = DATABASE_URL): Promise<RoadWayInput[]> {
  return withClient(url, async (c) => {
    const { rows } = await c.query<{
      osm_way_id: string; node_ids: string[]; class: RoadClass; name: string | null;
      lanes_fwd: number; lanes_back: number; speed_limit_mps: number; coords: [number, number][];
    }>(
      `SELECT osm_way_id::text, node_ids::text[] AS node_ids, class, name, lanes_fwd, lanes_back,
              speed_limit_mps, ST_AsGeoJSON(geom)::json -> 'coordinates' AS coords
       FROM road_ways
       WHERE ST_Intersects(geom, ST_MakeEnvelope($1, $2, $3, $4, 4326))
       ORDER BY osm_way_id`,
      [bbox.west, bbox.south, bbox.east, bbox.north]);
    return rows.map((r) => ({
      osmWayId: Number(r.osm_way_id),
      nodeIds: r.node_ids.map(Number),
      points: r.coords,
      class: r.class,
      name: r.name,
      lanesFwd: r.lanes_fwd,
      lanesBack: r.lanes_back,
      speedLimitMps: r.speed_limit_mps,
    }));
  });
}
