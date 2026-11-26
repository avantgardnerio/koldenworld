//! Ground heights (decision 24), as packages/cli/src/elevation.ts: FABDEM V1-2 tiles (Copernicus GLO-30 with
//! buildings and forests removed: bare earth, ~30 m, EGM2008 heights) plus the EGM2008 geoid, giving heights above
//! the WGS84 ellipsoid (h = H + N).
//!
//! data/dem/fabdem/N39W106_FABDEM_V1-2.tif covers 39–40° N, 106–105° W (named by its southwest corner); its pixels
//! are areas, float32 in tiles, and only the tiles a box needs are read. Oceans have no tiles.
//! data/dem/us_nga_egm08_25.tif is EGM2008 for the world: a node-registered 2.5' grid from 180° W, read the same way.

use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use tiff::decoder::{Decoder, DecodingResult};
use tiff::tags::Tag;

/// Samples of a raster window: rows run south.
struct Grid {
    data: Vec<f32>,
    w: usize,
    cols: usize, // samples in the image, from the window's first (the rest is padding)
    rows: usize,
    x0: f64, // lon of the first sample
    y0: f64, // lat of the first sample
    dx: f64, // degrees per sample, east
    dy: f64, // degrees per sample (negative: rows run south)
    nodata: Option<f32>,
}

impl Grid {
    /// Bilinear between samples; None outside the window or on nodata. Within a sample past the last row or column
    /// it holds that row or column: the gap to the next tile, whose first sample is one step on.
    fn sample(&self, lat: f64, lon: f64) -> Option<f64> {
        let (fx, fy) = ((lon - self.x0) / self.dx, (lat - self.y0) / self.dy);
        let (i, j) = (fx.floor(), fy.floor());
        if i < 0.0 || j < 0.0 || i as usize >= self.cols || j as usize >= self.rows {
            return None;
        }
        let (u, v, i, j) = (fx - i, fy - j, i as usize, j as usize);
        let (i1, j1) = ((i + 1).min(self.cols - 1), (j + 1).min(self.rows - 1));
        let at = |x: usize, y: usize| self.data[y * self.w + x];
        let [a, b, c, e] = [at(i, j), at(i1, j), at(i, j1), at(i1, j1)];
        // Nodata, or padding past an image's edge tiles (NaN).
        if self.nodata.is_some_and(|n| [a, b, c, e].contains(&n))
            || [a, b, c, e].iter().any(|x| x.is_nan())
        {
            return None;
        }
        let [a, b, c, e] = [a, b, c, e].map(f64::from);
        Some((a * (1.0 - u) + b * u) * (1.0 - v) + (c * (1.0 - u) + e * u) * v)
    }
}

/// Heights for a lon/lat box: the FABDEM windows it needs and the geoid's.
pub struct Elevation {
    tiles: Vec<Grid>,
    geoid: Grid,
    pub missing: std::cell::Cell<usize>, // samples without data (fell back to 0 m)
}

impl Elevation {
    /// Loads what a box (west, south, east, north) needs from `dir` (data/dem).
    pub fn region(
        dir: &Path,
        [west, south, east, north]: [f64; 4],
    ) -> Result<Elevation, Box<dyn std::error::Error>> {
        let geoid = read_window(&dir.join("us_nga_egm08_25.tif"), [west, south, east, north])?;
        let mut tiles = Vec::new();
        for lat in south.floor() as i32..north.ceil() as i32 {
            for lon in west.floor() as i32..east.ceil() as i32 {
                let ns = if lat >= 0 { 'N' } else { 'S' };
                let ew = if lon < 0 { 'W' } else { 'E' };
                let file: PathBuf = dir.join("fabdem").join(format!(
                    "{ns}{:02}{ew}{:03}_FABDEM_V1-2.tif",
                    lat.abs(),
                    lon.abs()
                ));
                if file.exists() {
                    tiles.push(read_window(&file, [west, south, east, north])?);
                }
            }
        }
        Ok(Elevation {
            tiles,
            geoid,
            missing: Default::default(),
        })
    }

    /// Metres above the WGS84 ellipsoid at a point (0 where there's no data, counted in `missing`).
    pub fn height(&self, lat: f64, lon: f64) -> f64 {
        let h = self.tiles.iter().find_map(|g| g.sample(lat, lon));
        let n = self.geoid.sample(lat, lon);
        match (h, n) {
            (Some(h), Some(n)) => h + n,
            _ => {
                self.missing.set(self.missing.get() + 1);
                0.0
            }
        }
    }
}

type Tiff = Decoder<BufReader<File>>;

/// Where a raster sits: (lon, lat of its top-left corner, degrees per pixel east, per pixel south (negative)).
fn georef(d: &mut Tiff) -> Result<[f64; 4], Box<dyn std::error::Error>> {
    let scale = d.get_tag_f64_vec(Tag::Unknown(33550))?; // ModelPixelScale: sx, sy, sz
    let tie = d.get_tag_f64_vec(Tag::Unknown(33922))?; // ModelTiepoint: i, j, k, x, y, z
    Ok([
        tie[3] - tie[0] * scale[0],
        tie[4] + tie[1] * scale[1],
        scale[0],
        -scale[1],
    ])
}

/// GTRasterTypeGeoKey (1025) is RasterPixelIsPoint (2): GeoKeyDirectory is a 4-short header, then 4 shorts a key.
fn pixel_is_point(d: &mut Tiff) -> bool {
    let keys = d.get_tag_u32_vec(Tag::Unknown(34735)).unwrap_or_default();
    let (keys, _) = keys.as_chunks::<4>();
    keys.iter()
        .skip(1)
        .any(|&[key, location, _, value]| key == 1025 && location == 0 && value == 2)
}

fn nodata(d: &mut Tiff) -> Option<f32> {
    d.get_tag_ascii_string(Tag::Unknown(42113))
        .ok()?
        .trim()
        .trim_end_matches('\0')
        .parse()
        .ok() // GDAL_NODATA
}

fn floats(r: DecodingResult) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
    match r {
        DecodingResult::F32(v) => Ok(v),
        _ => Err("expected float32 samples".into()),
    }
}

/// The tiles of an image a box touches (plus a pixel of margin), as one window of samples.
fn read_window(
    file: &Path,
    [west, south, east, north]: [f64; 4],
) -> Result<Grid, Box<dyn std::error::Error>> {
    let mut d = Decoder::new(BufReader::new(
        File::open(file).map_err(|e| format!("{}: {e}", file.display()))?,
    ))?;
    let [ox, oy, dx, dy] = georef(&mut d)?;
    let nodata = nodata(&mut d);
    let (iw, ih) = d.dimensions()?;
    let (tw, th) = d.chunk_dimensions();
    let (tw, th) = (tw as usize, th as usize);
    let tiles_across = (iw as usize).div_ceil(tw);
    // Pixel columns and rows the box needs, then the tiles holding them.
    let c0 = (((west - ox) / dx).floor() as i64 - 1).max(0) as usize;
    let c1 = ((((east - ox) / dx).ceil() as i64 + 1) as usize).min(iw as usize - 1);
    let r0 = (((north - oy) / dy).floor() as i64 - 1).max(0) as usize;
    let r1 = ((((south - oy) / dy).ceil() as i64 + 1) as usize).min(ih as usize - 1);
    let (tx0, tx1, ty0, ty1) = (c0 / tw, c1 / tw, r0 / th, r1 / th);
    let (w, h) = ((tx1 - tx0 + 1) * tw, (ty1 - ty0 + 1) * th);
    let mut data = vec![f32::NAN; w * h];
    for ty in ty0..=ty1 {
        for tx in tx0..=tx1 {
            let tile = floats(d.read_chunk((ty * tiles_across + tx) as u32)?)?;
            let (cw, ch) = d.chunk_data_dimensions((ty * tiles_across + tx) as u32);
            for y in 0..ch as usize {
                let row = (ty - ty0) * th + y;
                let start = row * w + (tx - tx0) * tw;
                data[start..start + cw as usize]
                    .copy_from_slice(&tile[y * cw as usize..(y + 1) * cw as usize]);
            }
        }
    }
    // Area pixels: the first sample is the center of the window's first pixel. Point pixels: the tie point is a sample.
    let half = if pixel_is_point(&mut d) { 0.0 } else { 0.5 };
    Ok(Grid {
        data,
        w,
        cols: w.min(iw as usize - tx0 * tw),
        rows: h.min(ih as usize - ty0 * th),
        x0: ox + ((tx0 * tw) as f64 + half) * dx,
        y0: oy + ((ty0 * th) as f64 + half) * dy,
        dx,
        dy,
        nodata,
    })
}
