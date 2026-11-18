import type { OsmBuilding } from "@game/osm-import";
import pg from "pg";
import { DATABASE_URL } from "./config.ts";
import { upsertFetch, type OsmFetch } from "./fetches.ts";
import type { ImportResult } from "./roads.ts";

const ring = (r: [number, number][]) => `(${r.map(([lon, lat]) => `${lon} ${lat}`).join(",")})`;
const multipolygonWkt = (polygons: [number, number][][][]) =>
  `MULTIPOLYGON(${polygons.map((p) => `(${p.map(ring).join(",")})`).join(",")})`;

/**
 * Imports one snapshot's buildings and building parts, in one transaction, the
 * same way as road ways: record the fetch, upsert by (osm_type, osm_id), then
 * delete buildings with a vertex inside the fetched box that this snapshot no
 * longer has.
 */
export async function importBuildings(fetch: OsmFetch, buildings: OsmBuilding[], url = DATABASE_URL): Promise<ImportResult> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN");
    const fetchId = await upsertFetch(client, fetch);

    const upsert = await client.query(
      `INSERT INTO buildings (osm_type, osm_id, kind, is_part, name, height_m, min_height_m,
                              height_source, levels, geom, tags, fetch_id)
       SELECT osm_type, osm_id, kind, is_part, name, height_m, min_height_m,
              height_source, levels, ST_Multi(ST_GeomFromText(wkt, 4326)), tags, $1
       FROM unnest($2::text[], $3::bigint[], $4::text[], $5::boolean[], $6::text[], $7::real[], $8::real[],
                   $9::text[], $10::real[], $11::text[], $12::jsonb[])
         AS x(osm_type, osm_id, kind, is_part, name, height_m, min_height_m,
              height_source, levels, wkt, tags)
       ON CONFLICT (osm_type, osm_id) DO UPDATE SET
         kind = excluded.kind, is_part = excluded.is_part, name = excluded.name,
         height_m = excluded.height_m, min_height_m = excluded.min_height_m,
         height_source = excluded.height_source, levels = excluded.levels,
         geom = excluded.geom, tags = excluded.tags, fetch_id = excluded.fetch_id`,
      [
        fetchId,
        buildings.map((b) => b.osmType),
        buildings.map((b) => b.osmId),
        buildings.map((b) => b.kind),
        buildings.map((b) => b.isPart),
        buildings.map((b) => b.name),
        buildings.map((b) => b.height),
        buildings.map((b) => b.minHeight),
        buildings.map((b) => b.heightSource),
        buildings.map((b) => b.levels),
        buildings.map((b) => multipolygonWkt(b.polygons)),
        buildings.map((b) => JSON.stringify(b.tags)),
      ]);

    const del = await client.query(
      `DELETE FROM buildings b
       USING osm_fetches f
       WHERE f.id = $1
         AND b.geom && f.bbox
         AND (b.osm_type, b.osm_id) NOT IN (SELECT * FROM unnest($2::text[], $3::bigint[]))
         AND EXISTS (SELECT 1 FROM ST_DumpPoints(b.geom) p WHERE ST_Intersects(p.geom, f.bbox))`,
      [fetchId, buildings.map((b) => b.osmType), buildings.map((b) => b.osmId)]);

    await client.query("COMMIT");
    return { fetchId, upserted: upsert.rowCount ?? 0, deleted: del.rowCount ?? 0 };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }
}
