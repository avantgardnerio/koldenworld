// Ground heights for the cell server (decision 24): USGS 3DEP 1/3 arc-second
// tiles (bare earth, ~10 m, NAVD88 heights) plus the GEOID18 model, giving
// heights above the WGS84 ellipsoid (h = H + N).
//
// data/dem/usgs13/USGS_13_n40w106.tif covers 39–40° N, 105–106° W (named by
// its northwest corner) with a 6-pixel overlap on each side.
// data/dem/us_noaa_g2018u0.tif is GEOID18 for the conterminous US (1' grid,
// longitudes 230–300°).
//
// region(bbox) reads just the windows a box needs and returns a synchronous
// sampler for that box: bilinear between pixel centers. Points without data
// (no tile, or nodata) fall back to 0 m and are counted.

import { existsSync } from "node:fs";
import path from "node:path";
import type { Bbox } from "@game/db";
import type { HeightFn } from "@game/world";
import { fromFile, type GeoTIFFImage } from "geotiff";
import { DATA_DIR } from "./paths.ts";

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
  const data = (await image.readRasters({ window: [c0, r0, c1, r1], interleave: true })) as unknown as Float32Array;
  return {
    data: Float32Array.from(data), w: c1 - c0, h: r1 - r0,
    x0: ox! + (c0 + 0.5) * rx!, y0: oy! + (r0 + 0.5) * ry!, dx: rx!, dy: ry!,
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
  private geoid?: Promise<Grid>;
  private blocks = new Map<string, Promise<Grid>>();  // LRU by insertion order

  private block(file: string, image: GeoTIFFImage, bx: number, by: number): Promise<Grid> {
    const key = `${file}:${bx}:${by}`;
    let p = this.blocks.get(key);
    if (p) this.blocks.delete(key);
    else p = readBlock(image, bx, by);
    this.blocks.set(key, p);
    if (this.blocks.size > MAX_BLOCKS) this.blocks.delete(this.blocks.keys().next().value!);
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

  private loadGeoid(): Promise<Grid> {
    this.geoid ??= (async () => {
      const im = await this.image(path.join(this.dir, "us_noaa_g2018u0.tif"));
      if (!im) throw new Error("GEOID18 grid missing: data/dem/us_noaa_g2018u0.tif (https://cdn.proj.org/us_noaa_g2018u0.tif)");
      const [ox, oy] = im.getOrigin() as number[];
      const [rx, ry] = im.getResolution() as number[];
      const data = (await im.readRasters({ interleave: true })) as unknown as Float32Array;
      // A node-registered grid: the origin is the first node, not a pixel corner.
      return { data: Float32Array.from(data), w: im.getWidth(), h: im.getHeight(), x0: ox!, y0: oy!, dx: rx!, dy: ry!, nodata: null };
    })();
    return this.geoid;
  }

  /** Loads what a box needs and returns a sampler for points in it: meters above the WGS84 ellipsoid. */
  async region(b: Bbox): Promise<HeightFn> {
    const geoid = await this.loadGeoid();
    const grids: Grid[] = [];
    for (let lat = Math.floor(b.south); lat < b.north; lat++) {
      for (let lon = Math.floor(b.west); lon < b.east; lon++) {
        const name = `${lat + 1 >= 0 ? "n" : "s"}${String(Math.abs(lat + 1)).padStart(2, "0")}${lon < 0 ? "w" : "e"}${String(Math.abs(lon)).padStart(3, "0")}`;
        const file = path.join(this.dir, "usgs13", `USGS_13_${name}.tif`);
        const im = await this.image(file);
        if (!im) continue;
        grids.push(...await Promise.all(blocksFor(im, b).map(([bx, by]) => this.block(file, im, bx, by))));
      }
    }
    return (lat, lon) => {
      let H = NaN;
      for (const g of grids) {
        H = sample(g, lat, lon);
        if (!Number.isNaN(H)) break;
      }
      const N = sample(geoid, lat, lon + 360);
      if (Number.isNaN(H) || Number.isNaN(N)) {
        this.missing++;
        return 0;
      }
      return H + N;
    };
  }
}
