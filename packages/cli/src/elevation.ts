// Ground heights for the cell server (decision 24): FABDEM V1-2 tiles
// (Copernicus GLO-30 with buildings and forests removed: bare earth, ~30 m,
// EGM2008 heights) plus the EGM2008 geoid, giving heights above the WGS84
// ellipsoid (h = H + N).
//
// data/dem/fabdem/N39W106_FABDEM_V1-2.tif covers 39–40° N, 106–105° W (named
// by its southwest corner). Oceans have no tiles.
// data/dem/us_nga_egm08_25.tif is EGM2008 for the world (node-registered 2.5'
// grid from 180° W), read in blocks like the tiles.
//
// A tile missing on disk is fetched first from CELLGEN_DEM_S3 (default below;
// empty turns it off) with the AWS CLI, as cellgen does, so the usual
// credentials apply. A tile S3 doesn't have (the oceans) leaves a `.none` file
// beside where it would be, so it's asked for once.
//
// region(bbox) reads just the windows a box needs and returns a synchronous
// sampler for that box: bilinear between pixel centers. Points without data
// (no tile, or nodata) fall back to sea level (the geoid) and are counted.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { threadId } from "node:worker_threads";
import type { Bbox } from "@game/db";
import type { HeightFn } from "@game/world";
import { fromFile, type GeoTIFFImage } from "geotiff";
import { DATA_DIR } from "./paths.ts";

const DEM_S3 = process.env.CELLGEN_DEM_S3 ?? "s3://koldenworld-data-2/dem/fabdem-v1-2/tiles/";

interface Grid {
  data: Float32Array;
  w: number;
  h: number;
  x0: number;     // lon of the first pixel's center
  y0: number;     // lat of the first pixel's center
  dx: number;     // degrees per pixel (east)
  dy: number;     // degrees per pixel (negative: rows run south)
  nodata: number | null;
}

/** Bilinear sample between pixel centers; NaN outside the grid or on nodata. */
function sample(g: Grid, lat: number, lon: number): number {
  const fx = (lon - g.x0) / g.dx, fy = (lat - g.y0) / g.dy;
  const i = Math.floor(fx), j = Math.floor(fy);
  if (i < 0 || j < 0 || i + 1 >= g.w || j + 1 >= g.h) return NaN;
  const u = fx - i, v = fy - j, d = g.data;
  const a = d[j * g.w + i]!, b = d[j * g.w + i + 1]!, c = d[(j + 1) * g.w + i]!, e = d[(j + 1) * g.w + i + 1]!;
  if (g.nodata !== null && (a === g.nodata || b === g.nodata || c === g.nodata || e === g.nodata)) return NaN;
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + e * u) * v;
}

/** Pixels per cached block (the files' own tile size), read with one extra row and column so bilinear works across blocks. */
const BLOCK = 512;
const MAX_BLOCKS = 512;  // ~1 MB each

/** Block (bx, by) of an image, as a Grid. */
async function readBlock(image: GeoTIFFImage, bx: number, by: number): Promise<Grid> {
  const [ox, oy] = image.getOrigin() as number[];
  const [rx, ry] = image.getResolution() as number[];
  const c0 = bx * BLOCK, r0 = by * BLOCK;
  const c1 = Math.min(image.getWidth(), c0 + BLOCK + 1), r1 = Math.min(image.getHeight(), r0 + BLOCK + 1);
  // Area pixels: the first sample is a pixel's center. Point pixels (RasterPixelIsPoint): the tie point is a sample.
  const half = image.getGeoKeys()?.GTRasterTypeGeoKey === 2 ? 0 : 0.5;
  const raw = (await image.readRasters({ window: [c0, r0, c1, r1], interleave: true })) as unknown as Float32Array;
  // At the image's east or south edge, repeat the last column or row: that covers the gap to the next tile, whose
  // first sample is one step on.
  const pw = c1 - c0, ph = r1 - r0, w = pw + (c1 === image.getWidth() ? 1 : 0), h = ph + (r1 === image.getHeight() ? 1 : 0);
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const from = Math.min(y, ph - 1) * pw;
    data.set(raw.subarray(from, from + pw), y * w);
    if (w > pw) data[y * w + pw] = raw[from + pw - 1]!;
  }
  return {
    data, w, h,
    x0: ox! + (c0 + half) * rx!, y0: oy! + (r0 + half) * ry!, dx: rx!, dy: ry!,
    nodata: image.getGDALNoData(),
  };
}

/** The blocks of an image a lat/lon box touches (plus a pixel of margin). */
function blocksFor(image: GeoTIFFImage, b: Bbox): [number, number][] {
  const [ox, oy] = image.getOrigin() as number[];
  const [rx, ry] = image.getResolution() as number[];
  const W = image.getWidth(), H = image.getHeight();
  const c0 = Math.max(0, Math.floor((b.west - ox!) / rx!) - 1), c1 = Math.min(W - 1, Math.ceil((b.east - ox!) / rx!) + 1);
  const r0 = Math.max(0, Math.floor((b.north - oy!) / ry!) - 1), r1 = Math.min(H - 1, Math.ceil((b.south - oy!) / ry!) + 1);
  if (c1 <= c0 || r1 <= r0) return [];
  const out: [number, number][] = [];
  for (let by = Math.floor(r0 / BLOCK); by <= Math.floor(r1 / BLOCK); by++) {
    for (let bx = Math.floor(c0 / BLOCK); bx <= Math.floor(c1 / BLOCK); bx++) out.push([bx, by]);
  }
  return out;
}

export class Elevation {
  private dir = path.join(DATA_DIR, "dem");
  private images = new Map<string, Promise<GeoTIFFImage | null>>();
  private blocks = new Map<string, Promise<Grid>>();  // LRU by insertion order
  private maxBlocks: number;

  constructor(maxBlocks = MAX_BLOCKS) {
    this.maxBlocks = maxBlocks;
  }

  private block(file: string, image: GeoTIFFImage, bx: number, by: number): Promise<Grid> {
    const key = `${file}:${bx}:${by}`;
    let p = this.blocks.get(key);
    if (p) this.blocks.delete(key);
    else p = readBlock(image, bx, by);
    this.blocks.set(key, p);
    if (this.blocks.size > this.maxBlocks) this.blocks.delete(this.blocks.keys().next().value!);
    return p;
  }
  missing = 0;  // samples without data, since start

  private image(file: string): Promise<GeoTIFFImage | null> {
    let p = this.images.get(file);
    if (!p) {
      p = existsSync(file) ? fromFile(file).then((t) => t.getImage()) : Promise.resolve(null);
      this.images.set(file, p);
    }
    return p;
  }

  /** A FABDEM tile, fetched from S3 first if it isn't on disk; null where there's no tile (or the fetch failed, which is logged and tried again next time). */
  private tile(name: string): Promise<GeoTIFFImage | null> {
    const file = path.join(this.dir, "fabdem", name), none = file.replace(/\.tif$/, ".none");
    if (existsSync(file) || existsSync(none) || !DEM_S3) return this.image(file);
    let p = this.images.get(file);
    if (!p) {
      p = fetchTile(`${DEM_S3}${name}`, file, none).then((got) => {
        if (got) return fromFile(file).then((t) => t.getImage());
        if (!existsSync(none)) this.images.delete(file);
        return null;
      });
      this.images.set(file, p);
    }
    return p;
  }

  /** Loads what a box needs and returns a sampler for points in it: meters above the WGS84 ellipsoid. */
  async region(b: Bbox): Promise<HeightFn> {
    const geoidFile = path.join(this.dir, "us_nga_egm08_25.tif");
    const geoidImage = await this.image(geoidFile);
    if (!geoidImage) throw new Error("EGM2008 grid missing: data/dem/us_nga_egm08_25.tif (https://cdn.proj.org/us_nga_egm08_25.tif)");
    const geoid = await Promise.all(blocksFor(geoidImage, b).map(([bx, by]) => this.block(geoidFile, geoidImage, bx, by)));
    const grids: Grid[] = [];
    for (let lat = Math.floor(b.south); lat < b.north; lat++) {
      for (let lon = Math.floor(b.west); lon < b.east; lon++) {
        const name = `${lat >= 0 ? "N" : "S"}${String(Math.abs(lat)).padStart(2, "0")}${lon < 0 ? "W" : "E"}${String(Math.abs(lon)).padStart(3, "0")}_FABDEM_V1-2.tif`;
        const file = path.join(this.dir, "fabdem", name);
        const im = await this.tile(name);
        if (!im) continue;
        grids.push(...await Promise.all(blocksFor(im, b).map(([bx, by]) => this.block(file, im, bx, by))));
      }
    }
    const first = (gs: Grid[], lat: number, lon: number) => {
      for (const g of gs) {
        const v = sample(g, lat, lon);
        if (!Number.isNaN(v)) return v;
      }
      return NaN;
    };
    return (lat, lon) => {
      const H = first(grids, lat, lon), N = first(geoid, lat, lon);
      if (Number.isNaN(H)) this.missing++;
      // No tile (the sea) is sea level: the geoid.
      return (Number.isNaN(H) ? 0 : H) + (Number.isNaN(N) ? 0 : N);
    };
  }
}

/** Copies an S3 object to `file` (by way of a temporary name): true when it's there, false when S3 has no such tile (marked with `none`) or the copy failed. */
function fetchTile(source: string, file: string, none: string): Promise<boolean> {
  mkdirSync(path.dirname(file), { recursive: true });
  const part = `${file}.part${process.pid}-${threadId}`;
  return new Promise((resolve) => {
    execFile("aws", ["s3", "cp", "--only-show-errors", source, part], (err, _out, stderr) => {
      if (!err) {
        renameSync(part, file);
        console.log(`elevation: fetched ${path.basename(file)}`);
        return resolve(true);
      }
      rmSync(part, { force: true });
      if (stderr.includes("(404)")) writeFileSync(none, "");
      else console.error(`elevation: ${source}: ${stderr.trim() || err.message}`);
      resolve(false);
    });
  });
}
