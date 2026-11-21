import type { RoadWay } from "@game/osm-import";
import pg from "pg";
import { clientConfig, DATABASE_URL } from "./config.ts";
import { upsertFetch, type OsmFetch } from "./fetches.ts";

export interface ImportOptions {
  /**
   * Delete rows with a node in the fetch box that the snapshot lacks (default
   * true). Right for an Overpass box, which returns everything touching it;
   * wrong for a batch that is not a box query (a cell's share of an extract).
   */
  deleteMissing?: boolean;
}

export interface ImportResult {
  fetchId: number;
  upserted: number;
  deleted: number;   // ways in the box that this snapshot no longer has
}

/**
 * Imports one snapshot's road ways, in one transaction: records the fetch,
 * upserts ways by OSM id, then deletes road ways that have a node inside the
 * fetched box but are absent from this snapshot (deleted upstream, or no
 * longer a road). Overpass returns every way with a node in the box, so
 * anything matching that test and missing is really gone.
 */
export async function importRoadWays(
  fetch: OsmFetch, ways: RoadWay[], opts: ImportOptions = {}, url = DATABASE_URL,
): Promise<ImportResult> {
  const client = new pg.Client(clientConfig(url));
  await client.connect();
  try {
    await client.query("BEGIN");
    const fetchId = await upsertFetch(client, fetch);

    // One statement for all rows: each column is passed as an array and zipped by unnest.
    // node_ids travel as JSON because unnest would flatten a 2-D bigint array.
    const upsert = await client.query(
      `INSERT INTO road_ways (osm_way_id, class, name, oneway, lanes_fwd, lanes_back,
                              speed_limit_mps, speed_limit_from_tag, length_m,
                              node_ids, geom, tags, fetch_id)
       SELECT osm_way_id, class, name, oneway, lanes_fwd, lanes_back,
              speed_limit_mps, speed_limit_from_tag, ST_Length(g::geography),
              ARRAY(SELECT jsonb_array_elements_text(node_ids)::bigint), g, tags, $1
       FROM unnest($2::bigint[], $3::text[], $4::text[], $5::boolean[], $6::smallint[], $7::smallint[],
                   $8::real[], $9::boolean[], $10::jsonb[], $11::text[], $12::jsonb[])
         AS x(osm_way_id, class, name, oneway, lanes_fwd, lanes_back,
              speed_limit_mps, speed_limit_from_tag, node_ids, wkt, tags),
         LATERAL ST_GeomFromText(wkt, 4326) AS g
       ON CONFLICT (osm_way_id) DO UPDATE SET
         class = excluded.class, name = excluded.name, oneway = excluded.oneway,
         lanes_fwd = excluded.lanes_fwd, lanes_back = excluded.lanes_back,
         speed_limit_mps = excluded.speed_limit_mps, speed_limit_from_tag = excluded.speed_limit_from_tag,
         length_m = excluded.length_m, node_ids = excluded.node_ids, geom = excluded.geom,
         tags = excluded.tags, fetch_id = excluded.fetch_id`,
      [
        fetchId,
        ways.map((w) => w.osmWayId),
        ways.map((w) => w.class),
        ways.map((w) => w.name),
        ways.map((w) => w.oneway),
        ways.map((w) => w.lanesFwd),
        ways.map((w) => w.lanesBack),
        ways.map((w) => w.speedLimitMps),
        ways.map((w) => w.speedLimitFromTag),
        ways.map((w) => JSON.stringify(w.nodeIds)),
        ways.map((w) => `LINESTRING(${w.points.map(([lon, lat]) => `${lon} ${lat}`).join(",")})`),
        ways.map((w) => JSON.stringify(w.tags)),
      ]);

    const del = opts.deleteMissing === false ? { rowCount: 0 } : await client.query(
      `DELETE FROM road_ways r
       USING osm_fetches f
       WHERE f.id = $1
         AND r.geom && f.bbox
         AND r.osm_way_id <> ALL($2::bigint[])
         AND EXISTS (SELECT 1 FROM ST_DumpPoints(r.geom) p WHERE ST_Intersects(p.geom, f.bbox))`,
      [fetchId, ways.map((w) => w.osmWayId)]);

    await client.query("COMMIT");
    return { fetchId, upserted: upsert.rowCount ?? 0, deleted: del.rowCount ?? 0 };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }
}
