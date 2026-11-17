// One-time download of raw OSM data for a square around a zip code, via the
// Overpass API. Saved to data/osm/ so imports never hit the API again.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { lookupZip } from "./census.ts";
import { osmPaths } from "./paths.ts";

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const USER_AGENT = "game-osm-fetch/0.1 (hobby project; one-time area download)";

export interface Bbox { south: number; west: number; north: number; east: number }

export function squareAround(lat: number, lon: number, sizeKm: number): Bbox {
  const half = (sizeKm * 1000) / 2;
  const dLat = half / 111_320;
  const dLon = half / (111_320 * Math.cos((lat * Math.PI) / 180));
  return { south: lat - dLat, west: lon - dLon, north: lat + dLat, east: lon + dLon };
}

/** Everything in the box, plus the out-of-box nodes of ways that cross its edge. */
export function overpassQuery(b: Bbox): string {
  const box = [b.south, b.west, b.north, b.east].map((v) => v.toFixed(6)).join(",");
  return `[out:json][timeout:300];
(
  nwr(${box});
  way(${box});
  >;
);
out body;`;
}

export async function fetchOsm(
  opts: { zip: string; sizeKm: number; force: boolean },
  log: (msg: string) => void,
): Promise<void> {
  const out = osmPaths(opts.zip);
  if (existsSync(out.raw) && !opts.force) {
    log(`${out.raw} already exists; pass --force to download again`);
    return;
  }

  const info = await lookupZip(opts.zip, log);
  const bbox = squareAround(info.lat, info.lon, opts.sizeKm);
  const query = overpassQuery(bbox);
  log(`zip ${info.zip}: center ${info.lat}, ${info.lon}, land area ${(info.landAreaM2 / 1e6).toFixed(1)} km²`);
  log(`fetching ${opts.sizeKm}×${opts.sizeKm} km from Overpass...`);

  const res = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: { "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ data: query }),
  });
  if (!res.ok) throw new Error(`Overpass request failed: ${res.status} ${res.statusText}\n${await res.text()}`);
  const body = Buffer.from(await res.arrayBuffer());
  const parsed = JSON.parse(body.toString("utf8")) as { osm3s?: { timestamp_osm_base?: string }; elements: unknown[]; remark?: string };
  if (parsed.remark) throw new Error(`Overpass returned a remark (likely a timeout or error): ${parsed.remark}`);

  await mkdir(path.dirname(out.raw), { recursive: true });
  await writeFile(out.raw, body);
  await writeFile(out.meta, JSON.stringify({
    zip: info.zip,
    center: { lat: info.lat, lon: info.lon },
    sizeKm: opts.sizeKm,
    bbox,
    query,
    source: OVERPASS_URL,
    osmBaseTimestamp: parsed.osm3s?.timestamp_osm_base ?? null,
    fetchedAt: new Date().toISOString(),
    elements: parsed.elements.length,
    bytes: body.length,
    sha256: createHash("sha256").update(body).digest("hex"),
  }, null, 2) + "\n");
  log(`saved ${parsed.elements.length} elements (${(body.length / 1e6).toFixed(1)} MB) to ${out.raw}`);
}
