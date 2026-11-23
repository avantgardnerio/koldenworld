import { charityWeight, type BuildingInput, type HeightSource, type OsmType, type PoiCategory, type PoiInput, type RoadClass, type RoadWayInput } from "@game/world";
type Tags = Record<string, string>;
import pg from "pg";
import { clientConfig, DATABASE_URL } from "./config.ts";

export interface Bbox { south: number; west: number; north: number; east: number }

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client(clientConfig(url));
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
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
      bridge: string | null; tunnel: string | null; sidewalk_tags: Record<string, string>;
    }>(
      `WITH hit AS (
         SELECT osm_way_id, node_ids FROM road_ways WHERE ST_Intersects(geom, ST_MakeEnvelope($1, $2, $3, $4, 4326))
       ), touching AS (
         SELECT r.osm_way_id FROM road_ways r
         WHERE r.node_ids && (SELECT array_agg(DISTINCT n) FROM hit, unnest(hit.node_ids) n)
       )
       SELECT osm_way_id::text, node_ids::text[] AS node_ids, class, name, lanes_fwd, lanes_back,
              speed_limit_mps, ST_AsGeoJSON(geom)::json -> 'coordinates' AS coords,
              tags ->> 'bridge' AS bridge, tags ->> 'tunnel' AS tunnel,
              (SELECT coalesce(jsonb_object_agg(key, value), '{}') FROM jsonb_each_text(tags)
               WHERE key IN ('highway', 'oneway', 'tunnel') OR key LIKE 'sidewalk%') AS sidewalk_tags
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
      structure: roadStructure({ ...(r.bridge ? { bridge: r.bridge } : {}), ...(r.tunnel ? { tunnel: r.tunnel } : {}) }),
      sidewalks: roadSidewalks(r.sidewalk_tags, r.speed_limit_mps),
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
      height_m: number; min_height_m: number; height_source: HeightSource; levels: number | null;
      min_level: string | null; roof_shape: string | null; coords: [number, number][][][];
    }>(
      `WITH box AS (SELECT ST_MakeEnvelope($1, $2, $3, $4, 4326) AS g)
       SELECT b.osm_type, b.osm_id::text, b.kind, b.is_part, b.height_m, b.min_height_m, b.height_source,
              b.levels, b.tags ->> 'building:min_level' AS min_level, b.tags ->> 'roof:shape' AS roof_shape,
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
      levels: r.levels,
      minLevel: r.min_level !== null && Number.isFinite(parseFloat(r.min_level)) ? parseFloat(r.min_level) : null,
      roofShape: r.roof_shape,
      polygons: r.coords,
    }));
  });
}

/** Points of interest in the box, ordered by OSM key so output is reproducible. */
export function loadPois(bbox: Bbox, url = DATABASE_URL): Promise<PoiInput[]> {
  return withClient(url, async (c) => {
    const { rows } = await c.query<{
      osm_id: string; category: PoiCategory; kind: string; name: string | null; brand: string | null; lon: number; lat: number;
      tags: Record<string, string>;
    }>(
      `SELECT osm_id::text, category, kind, name, brand, ST_X(geom) AS lon, ST_Y(geom) AS lat, tags FROM pois
       WHERE geom && ST_MakeEnvelope($1, $2, $3, $4, 4326) ORDER BY osm_type, osm_id`,
      [bbox.west, bbox.south, bbox.east, bbox.north]);
    return rows.map((r) => ({
      osmId: Number(r.osm_id), category: r.category, kind: r.kind, name: r.name, brand: r.brand, lon: r.lon, lat: r.lat,
      charity: charityWeight(r.category, r.kind, r.tags),
    }));
  });
}

// --- road tags: stored ways keep their tags; these resolve what the graph needs ---------------------

/** Sidewalk bits (decision 33): which sides of a stored road way have one, looking along its stored node order. */
const SIDEWALK_LEFT = 1, SIDEWALK_RIGHT = 2;

/** Town streets: where untagged roads get sidewalks on both sides (at most 40 mph). */
const SIDEWALK_CLASSES = new Set(["primary", "secondary", "tertiary", "unclassified", "residential", "living_street"]);
const SIDEWALK_MAX_SPEED = 40 * 0.44704;

/**
 * Which sides of a road have a sidewalk, from sidewalk=*, sidewalk:left/right/both=*
 * (a separately mapped sidewalk counts: it's drawn at the curb), or, untagged,
 * by class and speed limit. Left and right are relative to the stored node
 * order, which runs against the way for oneway=-1.
 */
function roadSidewalks(tags: Tags, speedLimitMps: number): number {
  const yes = (v: string | undefined) => v === undefined ? undefined : !["no", "none"].includes(v);
  let left: boolean | undefined, right: boolean | undefined;
  const both = tags["sidewalk:both"] ?? tags.sidewalk;
  if (both !== undefined) {
    if (both === "left") [left, right] = [true, false];
    else if (both === "right") [left, right] = [false, true];
    else left = right = yes(both);
  }
  left = yes(tags["sidewalk:left"]) ?? left;
  right = yes(tags["sidewalk:right"]) ?? right;
  if (left === undefined && right === undefined) {
    const town = SIDEWALK_CLASSES.has(tags.highway ?? "") && speedLimitMps <= SIDEWALK_MAX_SPEED + 0.01
      && (tags.tunnel === undefined || tags.tunnel === "no" || tags.tunnel === "building_passage");
    left = right = town;
  }
  if (onewayDirection(tags) === -1) [left, right] = [right, left];
  return (left ? SIDEWALK_LEFT : 0) | (right ? SIDEWALK_RIGHT : 0);
}

/** Bridges and tunnels run straight between their ends instead of following the ground (decision 29). */
function roadStructure(tags: Tags): "bridge" | "tunnel" | null {
  if (tags.bridge !== undefined && tags.bridge !== "no") return "bridge";
  // A building passage is a short gap under a building at ground level, not a tunnel through ground.
  if (tags.tunnel !== undefined && tags.tunnel !== "no" && tags.tunnel !== "building_passage") return "tunnel";
  return null;
}

/** 1 = one-way along node order, -1 = one-way against it, 0 = two-way. */
function onewayDirection(tags: Tags): 1 | -1 | 0 {
  switch (tags.oneway) {
    case "yes": case "true": case "1": return 1;
    case "-1": case "reverse": return -1;
    case "no": case "false": case "0": case "reversible": case "alternating": return 0;
  }
  // Implied one-way when untagged.
  if (tags.highway === "motorway" || tags.highway === "motorway_link") return 1;
  if (tags.junction === "roundabout" || tags.junction === "circular") return 1;
  return 0;
}
