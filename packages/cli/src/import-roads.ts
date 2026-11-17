import { readFile } from "node:fs/promises";
import { importRoadWays, type OsmFetch } from "@game/db";
import { extractRoadWays, type OverpassResponse } from "@game/osm-import";
import { osmPaths } from "./paths.ts";

/** Converts a downloaded area's raw OSM into road ways and upserts them into Postgres. */
export async function importRoads(area: string, log: (msg: string) => void): Promise<void> {
  const paths = osmPaths(area);
  const raw = JSON.parse(await readFile(paths.raw, "utf8")) as OverpassResponse;
  const meta = JSON.parse(await readFile(paths.meta, "utf8")) as {
    zip: string; bbox: OsmFetch["bbox"]; source: string;
    osmBaseTimestamp: string | null; fetchedAt: string; sha256: string;
  };

  const { ways, stats } = extractRoadWays(raw.elements);
  log(`${stats.roadWays} road ways (${stats.skippedWays} skipped)`);
  const result = await importRoadWays({
    area: meta.zip,
    bbox: meta.bbox,
    source: meta.source,
    osmBaseTimestamp: meta.osmBaseTimestamp,
    fetchedAt: meta.fetchedAt,
    sha256: meta.sha256,
  }, ways);
  log(`fetch ${result.fetchId}: upserted ${result.upserted}, deleted ${result.deleted}`);
}
