import type { AerowayArea, AerowayLine } from "@game/osm-import";
import type { AerowayAreaInput, AerowayLineInput } from "@game/world";
import pg from "pg";
import { clientConfig, DATABASE_URL } from "./config.ts";
import type { Bbox } from "./export.ts";
import { upsertFetch, type OsmFetch } from "./fetches.ts";
import type { ImportOptions, ImportResult } from "./roads.ts";

const ring = (r: [number, number][]) => `(${r.map(([lon, lat]) => `${lon} ${lat}`).join(",")})`;
const multipolygonWkt = (polygons: [number, number][][][]) =>
  `MULTIPOLYGON(${polygons.map((p) => `(${p.map(ring).join(",")})`).join(",")})`;

/**
 * Imports one snapshot's airport areas and center lines, in one transaction,
 * the same way as water: record the fetch, upsert by OSM key, then (unless
 * told not to) delete rows with a vertex in the fetched box that this
 * snapshot no longer has.
 */
export async function importAeroways(
  fetch: OsmFetch, areas: AerowayArea[], lines: AerowayLine[], opts: ImportOptions = {}, url = DATABASE_URL,
): Promise<ImportResult> {
  const client = new pg.Client(clientConfig(url));
  await client.connect();
  try {
    await client.query("BEGIN");
    const fetchId = await upsertFetch(client, fetch);
    const a = await client.query(
      `INSERT INTO aeroway_areas (osm_type, osm_id, kind, geom, tags, fetch_id)
       SELECT osm_type, osm_id, kind, ST_Multi(ST_GeomFromText(wkt, 4326)), tags, $1
       FROM unnest($2::text[], $3::bigint[], $4::text[], $5::text[], $6::jsonb[]) AS x(osm_type, osm_id, kind, wkt, tags)
       ON CONFLICT (osm_type, osm_id) DO UPDATE SET
         kind = excluded.kind, geom = excluded.geom, tags = excluded.tags, fetch_id = excluded.fetch_id`,
      [
        fetchId, areas.map((w) => w.osmType), areas.map((w) => w.osmId), areas.map((w) => w.kind),
        areas.map((w) => multipolygonWkt(w.polygons)), areas.map((w) => JSON.stringify(w.tags)),
      ]);
    const l = await client.query(
      `INSERT INTO aeroway_lines (osm_way_id, kind, ref, width_m, geom, tags, fetch_id)
       SELECT osm_way_id, kind, ref, width_m, ST_GeomFromText(wkt, 4326), tags, $1
       FROM unnest($2::bigint[], $3::text[], $4::text[], $5::real[], $6::text[], $7::jsonb[])
         AS x(osm_way_id, kind, ref, width_m, wkt, tags)
       ON CONFLICT (osm_way_id) DO UPDATE SET
         kind = excluded.kind, ref = excluded.ref, width_m = excluded.width_m, geom = excluded.geom,
         tags = excluded.tags, fetch_id = excluded.fetch_id`,
      [
        fetchId, lines.map((w) => w.osmWayId), lines.map((w) => w.kind), lines.map((w) => w.ref), lines.map((w) => w.width),
        lines.map((w) => `LINESTRING(${w.points.map(([lon, lat]) => `${lon} ${lat}`).join(",")})`),
        lines.map((w) => JSON.stringify(w.tags)),
      ]);
    let deleted = 0;
    if (opts.deleteMissing !== false) {
      const da = await client.query(
        `DELETE FROM aeroway_areas w USING osm_fetches f
         WHERE f.id = $1 AND w.geom && f.bbox
           AND (w.osm_type, w.osm_id) NOT IN (SELECT * FROM unnest($2::text[], $3::bigint[]))
           AND EXISTS (SELECT 1 FROM ST_DumpPoints(w.geom) p WHERE ST_Intersects(p.geom, f.bbox))`,
        [fetchId, areas.map((w) => w.osmType), areas.map((w) => w.osmId)]);
      const dl = await client.query(
        `DELETE FROM aeroway_lines w USING osm_fetches f
         WHERE f.id = $1 AND w.geom && f.bbox AND w.osm_way_id <> ALL($2::bigint[])
           AND EXISTS (SELECT 1 FROM ST_DumpPoints(w.geom) p WHERE ST_Intersects(p.geom, f.bbox))`,
        [fetchId, lines.map((w) => w.osmWayId)]);
      deleted = (da.rowCount ?? 0) + (dl.rowCount ?? 0);
    }
    await client.query("COMMIT");
    return { fetchId, upserted: (a.rowCount ?? 0) + (l.rowCount ?? 0), deleted };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }
}

/** Airport areas and center lines touching a box, ordered by OSM key so output is reproducible. */
export async function loadAeroways(bbox: Bbox, url = DATABASE_URL): Promise<{ areas: AerowayAreaInput[]; lines: AerowayLineInput[] }> {
  const client = new pg.Client(clientConfig(url));
  await client.connect();
  try {
    const env = [bbox.west, bbox.south, bbox.east, bbox.north];
    const a = await client.query<{ osm_id: string; kind: AerowayAreaInput["kind"]; coords: [number, number][][][] }>(
      `SELECT osm_id::text, kind, ST_AsGeoJSON(geom)::json -> 'coordinates' AS coords FROM aeroway_areas
       WHERE ST_Intersects(geom, ST_MakeEnvelope($1, $2, $3, $4, 4326)) ORDER BY osm_type, osm_id`, env);
    const l = await client.query<{ osm_way_id: string; kind: AerowayLineInput["kind"]; width_m: number; coords: [number, number][] }>(
      `SELECT osm_way_id::text, kind, width_m, ST_AsGeoJSON(geom)::json -> 'coordinates' AS coords FROM aeroway_lines
       WHERE ST_Intersects(geom, ST_MakeEnvelope($1, $2, $3, $4, 4326)) ORDER BY osm_way_id`, env);
    return {
      areas: a.rows.map((r) => ({ osmId: Number(r.osm_id), kind: r.kind, polygons: r.coords })),
      lines: l.rows.map((r) => ({ osmId: Number(r.osm_way_id), kind: r.kind, width: r.width_m, points: r.coords })),
    };
  } finally {
    await client.end();
  }
}
