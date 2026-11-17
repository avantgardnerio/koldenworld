// Zip code → point, from the US Census ZCTA Gazetteer file (public domain).
// Downloaded once into data/census/ and read locally after that.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "./paths.ts";

const GAZETTEER_URL =
  "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_Gaz_zcta_national.zip";
const DIR = path.join(DATA_DIR, "census");
const TXT = path.join(DIR, "2024_Gaz_zcta_national.txt");

export interface ZipInfo {
  zip: string;
  lat: number;          // Census "internal point", near the centroid
  lon: number;
  landAreaM2: number;
}

async function ensureGazetteer(log: (msg: string) => void): Promise<void> {
  if (existsSync(TXT)) return;
  await mkdir(DIR, { recursive: true });
  log(`downloading ${GAZETTEER_URL}`);
  const res = await fetch(GAZETTEER_URL);
  if (!res.ok) throw new Error(`gazetteer download failed: ${res.status} ${res.statusText}`);
  const zipPath = path.join(DIR, "2024_Gaz_zcta_national.zip");
  await writeFile(zipPath, Buffer.from(await res.arrayBuffer()));
  execFileSync("unzip", ["-o", "-q", zipPath, "-d", DIR]);
  if (!existsSync(TXT)) throw new Error(`expected ${TXT} inside ${zipPath}`);
}

export async function lookupZip(zip: string, log: (msg: string) => void = () => {}): Promise<ZipInfo> {
  await ensureGazetteer(log);
  const [header, ...lines] = (await readFile(TXT, "utf8")).split(/\r?\n/);
  const cols = header!.split("\t").map((c) => c.trim());
  const col = (name: string) => {
    const i = cols.indexOf(name);
    if (i < 0) throw new Error(`gazetteer has no ${name} column`);
    return i;
  };
  const [iZip, iLat, iLon, iLand] = [col("GEOID"), col("INTPTLAT"), col("INTPTLONG"), col("ALAND")];
  for (const line of lines) {
    const f = line.split("\t");
    if (f[iZip]?.trim() === zip) {
      return { zip, lat: Number(f[iLat]), lon: Number(f[iLon]), landAreaM2: Number(f[iLand]) };
    }
  }
  throw new Error(`zip code ${zip} not found in the Census ZCTA gazetteer`);
}
