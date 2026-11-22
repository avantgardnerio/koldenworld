import { readFile } from "node:fs/promises";
import { importAeroways, importBuildings, importRoadWays, importWater, type ImportOptions, type OsmFetch } from "@game/db";
import { extractAeroways, extractBuildings, extractRoadWays, extractWater, type OsmElement, type OverpassResponse } from "@game/osm-import";
import { osmPaths } from "./paths.ts";

/** Converts a downloaded area's raw OSM into road ways and buildings and upserts them into Postgres. */
export async function importArea(area: string, log: (msg: string) => void): Promise<void> {
  const paths = osmPaths(area);
  const raw = JSON.parse(await readFile(paths.raw, "utf8")) as OverpassResponse;
  const meta = JSON.parse(await readFile(paths.meta, "utf8")) as {
    zip: string; bbox: OsmFetch["bbox"]; source: string;
    osmBaseTimestamp: string | null; fetchedAt: string; sha256: string;
  };
  await importSnapshot(raw.elements, {
    area: meta.zip,
    bbox: meta.bbox,
    source: meta.source,
    osmBaseTimestamp: meta.osmBaseTimestamp,
    fetchedAt: meta.fetchedAt,
    sha256: meta.sha256,
  }, log);
}

/** Converts one raw snapshot (elements from Overpass JSON or a PBF) into road ways, buildings, water and airports and upserts them. */
export async function importSnapshot(
  elements: OsmElement[], fetch: OsmFetch, log: (msg: string) => void, opts: ImportOptions = {},
): Promise<void> {
  const roads = extractRoadWays(elements);
  log(`${roads.stats.roadWays} road ways (${roads.stats.skippedWays} skipped)`);
  const r = await importRoadWays(fetch, roads.ways, opts);
  log(`road_ways: fetch ${r.fetchId}, upserted ${r.upserted}, deleted ${r.deleted}`);

  const { buildings, stats } = extractBuildings(elements);
  const h = stats.byHeightSource;
  log(`${stats.buildings} buildings + ${stats.parts} parts (${stats.skipped} skipped); ` +
      `heights from height ${h.height}, levels ${h.levels}, default ${h.default}`);
  const b = await importBuildings(fetch, buildings, opts);
  log(`buildings: fetch ${b.fetchId}, upserted ${b.upserted}, deleted ${b.deleted}`);

  const water = extractWater(elements);
  log(`${water.stats.areas} water areas, ${water.stats.lines} waterways (${water.stats.skipped} skipped)`);
  const w = await importWater(fetch, water.areas, water.lines, opts);
  log(`water: fetch ${w.fetchId}, upserted ${w.upserted}, deleted ${w.deleted}`);

  const air = extractAeroways(elements);
  log(`${air.stats.areas} aeroway areas, ${air.stats.lines} runway and taxiway lines (${air.stats.skipped} skipped)`);
  const a = await importAeroways(fetch, air.areas, air.lines, opts);
  log(`aeroways: fetch ${a.fetchId}, upserted ${a.upserted}, deleted ${a.deleted}`);
}
