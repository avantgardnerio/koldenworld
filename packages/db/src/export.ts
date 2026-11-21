import type { BuildingInput, HeightSource, OsmType, RoadClass, RoadWayInput } from "@game/world";
import pg from "pg";
import { clientConfig, DATABASE_URL } from "./config.ts";

export interface Bbox { south: number; west: number; north: number; east: number }

export interface FetchInfo {
  id: number;
  area: string;
  bbox: Bbox;
  osmBaseTimestamp: string | null;
  sha256: string;
}

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client(clientConfig(url));
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Whether any snapshot has been imported for an area. */
export function hasFetch(area: string, url = DATABASE_URL): Promise<boolean> {
  return withClient(url, async (c) => {
    const { rows } = await c.query("SELECT 1 FROM osm_fetches WHERE area = $1 LIMIT 1", [area]);
    return rows.length > 0;
  });
}

/** Every area with an imported snapshot whose name starts with a prefix. */
export function fetchAreas(prefix: string, url = DATABASE_URL): Promise<Set<string>> {
  return withClient(url, async (c) => {
    const { rows } = await c.query<{ area: string }>("SELECT DISTINCT area FROM osm_fetches WHERE starts_with(area, $1)", [prefix]);
    return new Set(rows.map((r) => r.area));
  });
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
    if (!r) throw new Error(`no fetch recorded for area ${area}; run import first`);
    return {
      id: Number(r.id),
      area: r.area,
      bbox: { south: r.south, west: r.west, north: r.north, east: r.east },
      osmBaseTimestamp: r.osm_base_timestamp?.toISOString() ?? null,
      sha256: r.sha256,
    };
  });
}

/**
 * Road ways intersecting the box, plus every way sharing a node with one of
 * them (so a way is cut at the same intersections whichever box selected it),
 * ordered by OSM id so graph output is reproducible.
 */
export function loadRoadWays(bbox: Bbox, url = DATABASE_URL): Promise<RoadWayInput[]> {
  return withClient(url, async (c) => {
    const { rows } = await c.query<{
      osm_way_id: string; node_ids: string[]; class: RoadClass; name: string | null;
      lanes_fwd: number; lanes_back: number; speed_limit_mps: number; coords: [number, number][];
    }>(
      `WITH hit AS (
         SELECT osm_way_id, node_ids FROM road_ways WHERE ST_Intersects(geom, ST_MakeEnvelope($1, $2, $3, $4, 4326))
       ), touching AS (
         SELECT r.osm_way_id FROM road_ways r
         WHERE r.node_ids && (SELECT array_agg(DISTINCT n) FROM hit, unnest(hit.node_ids) n)
       )
       SELECT osm_way_id::text, node_ids::text[] AS node_ids, class, name, lanes_fwd, lanes_back,
              speed_limit_mps, ST_AsGeoJSON(geom)::json -> 'coordinates' AS coords
       FROM road_ways
       WHERE osm_way_id IN (SELECT osm_way_id FROM hit UNION SELECT osm_way_id FROM touching)
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

/**
 * Buildings and parts intersecting the box, ordered by OSM key so output is
 * reproducible. A building outline is left out when a part lies inside it: the
 * parts describe its shape in more detail (the usual rule for 3D buildings).
 */
export function loadBuildings(bbox: Bbox, url = DATABASE_URL): Promise<BuildingInput[]> {
  return withClient(url, async (c) => {
    const { rows } = await c.query<{
      osm_type: OsmType; osm_id: string; kind: string; is_part: boolean;
      height_m: number; min_height_m: number; height_source: HeightSource; coords: [number, number][][][];
    }>(
      `WITH box AS (SELECT ST_MakeEnvelope($1, $2, $3, $4, 4326) AS g)
       SELECT b.osm_type, b.osm_id::text, b.kind, b.is_part, b.height_m, b.min_height_m, b.height_source,
              ST_AsGeoJSON(b.geom)::json -> 'coordinates' AS coords
       FROM buildings b, box
       WHERE ST_Intersects(b.geom, box.g)
         AND (b.is_part OR NOT EXISTS (
               SELECT 1 FROM buildings p
               WHERE p.is_part AND p.geom && b.geom
                 AND ST_Intersects(b.geom, ST_PointOnSurface(p.geom))))
       ORDER BY b.osm_type, b.osm_id`,
      [bbox.west, bbox.south, bbox.east, bbox.north]);
    return rows.map((r) => ({
      osmType: r.osm_type,
      osmId: Number(r.osm_id),
      kind: r.kind,
      isPart: r.is_part,
      height: r.height_m,
      minHeight: r.min_height_m,
      heightSource: r.height_source,
      polygons: r.coords,
    }));
  });
}
