import { readFile } from "node:fs/promises";
import { importBuildings, importRoadWays, type OsmFetch } from "@game/db";
import { extractBuildings, extractRoadWays, type OverpassResponse } from "@game/osm-import";
import { osmPaths } from "./paths.ts";

/** Converts a downloaded area's raw OSM into road ways and buildings and upserts them into Postgres. */
export async function importArea(area: string, log: (msg: string) => void): Promise<void> {
  const paths = osmPaths(area);
  const raw = JSON.parse(await readFile(paths.raw, "utf8")) as OverpassResponse;
  const meta = JSON.parse(await readFile(paths.meta, "utf8")) as {
    zip: string; bbox: OsmFetch["bbox"]; source: string;
    osmBaseTimestamp: string | null; fetchedAt: string; sha256: string;
  };
  const fetch: OsmFetch = {
    area: meta.zip,
    bbox: meta.bbox,
    source: meta.source,
    osmBaseTimestamp: meta.osmBaseTimestamp,
    fetchedAt: meta.fetchedAt,
    sha256: meta.sha256,
  };

  const roads = extractRoadWays(raw.elements);
  log(`${roads.stats.roadWays} road ways (${roads.stats.skippedWays} skipped)`);
  const r = await importRoadWays(fetch, roads.ways);
  log(`road_ways: fetch ${r.fetchId}, upserted ${r.upserted}, deleted ${r.deleted}`);

  const { buildings, stats } = extractBuildings(raw.elements);
  const h = stats.byHeightSource;
  log(`${stats.buildings} buildings + ${stats.parts} parts (${stats.skipped} skipped); ` +
      `heights from height ${h.height}, levels ${h.levels}, default ${h.default}`);
  const b = await importBuildings(fetch, buildings);
  log(`buildings: fetch ${b.fetchId}, upserted ${b.upserted}, deleted ${b.deleted}`);
}
