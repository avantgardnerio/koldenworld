import type pg from "pg";

/** What data/osm/<area>.meta.json records about a raw snapshot. */
export interface OsmFetch {
  area: string;
  bbox: { south: number; west: number; north: number; east: number };
  source: string;
  osmBaseTimestamp: string | null;
  fetchedAt: string;
  sha256: string;
}

/** Records a snapshot (idempotent by file hash) and returns its id. Runs inside the caller's transaction. */
export async function upsertFetch(client: pg.Client, fetch: OsmFetch): Promise<number> {
  const { rows: [f] } = await client.query<{ id: string }>(
    `INSERT INTO osm_fetches (area, bbox, source, osm_base_timestamp, fetched_at, sha256)
     VALUES ($1, ST_MakeEnvelope($2, $3, $4, $5, 4326), $6, $7, $8, $9)
     ON CONFLICT (sha256) DO UPDATE SET imported_at = now()
     RETURNING id`,
    [fetch.area, fetch.bbox.west, fetch.bbox.south, fetch.bbox.east, fetch.bbox.north,
     fetch.source, fetch.osmBaseTimestamp, fetch.fetchedAt, fetch.sha256]);
  return Number(f!.id);
}
