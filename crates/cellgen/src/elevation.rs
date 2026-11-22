//! Ground heights (decision 24), as packages/cli/src/elevation.ts: USGS 3DEP 1/3 arc-second tiles (bare earth,
//! ~10 m, NAVD88 heights) plus the GEOID18 model, giving heights above the WGS84 ellipsoid (h = H + N).
//!
//! data/dem/usgs13/USGS_13_n40w106.tif covers 39–40° N, 105–106° W (named by its northwest corner) with a 6-pixel
//! overlap on each side; its pixels are areas, LZW float32 in 512-pixel tiles, and only the tiles a box needs are read.
//! data/dem/us_noaa_g2018u0.tif is GEOID18 for the conterminous US: a node-registered 1' grid, longitudes 230–300°.

use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use tiff::decoder::{Decoder, DecodingResult};
use tiff::tags::Tag;

/// Samples of a raster window: rows run south.
struct Grid {
    data: Vec<f32>,
    w: usize,
    h: usize,
    x0: f64, // lon of the first sample
    y0: f64, // lat of the first sample
    dx: f64, // degrees per sample, east
    dy: f64, // degrees per sample (negative: rows run south)
    nodata: Option<f32>,
}

impl Grid {
    /// Bilinear between samples; None outside the window or on nodata.
    fn sample(&self, lat: f64, lon: f64) -> Option<f64> {
        let (fx, fy) = ((lon - self.x0) / self.dx, (lat - self.y0) / self.dy);
        let (i, j) = (fx.floor(), fy.floor());
        if i < 0.0 || j < 0.0 || i as usize + 1 >= self.w || j as usize + 1 >= self.h {
            return None;
        }
        let (u, v, i, j) = (fx - i, fy - j, i as usize, j as usize);
        let at = |x: usize, y: usize| self.data[y * self.w + x];
        let [a, b, c, e] = [at(i, j), at(i + 1, j), at(i, j + 1), at(i + 1, j + 1)];
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

/// Heights for a lon/lat box: the USGS windows it needs and the geoid.
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
        let geoid = read_whole(&dir.join("us_noaa_g2018u0.tif"))?;
        let mut tiles = Vec::new();
        for lat in south.floor() as i32..north.ceil() as i32 {
            for lon in west.floor() as i32..east.ceil() as i32 {
                let ns = if lat + 1 >= 0 { 'n' } else { 's' };
                let ew = if lon < 0 { 'w' } else { 'e' };
                let file: PathBuf = dir.join("usgs13").join(format!(
                    "USGS_13_{ns}{:02}{ew}{:03}.tif",
                    (lat + 1).abs(),
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
        let n = self.geoid.sample(lat, lon + 360.0);
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

/// The geoid: the whole grid, node-registered (its first sample is the tie point itself).
fn read_whole(file: &Path) -> Result<Grid, Box<dyn std::error::Error>> {
    let mut d = Decoder::new(BufReader::new(
        File::open(file).map_err(|e| format!("{}: {e}", file.display()))?,
    ))?;
    let [x0, y0, dx, dy] = georef(&mut d)?;
    let (w, h) = d.dimensions()?;
    let data = floats(d.read_image()?)?;
    Ok(Grid {
        data,
        w: w as usize,
        h: h as usize,
        x0,
        y0,
        dx,
        dy,
        nodata: None,
    })
}

/// The tiles of a USGS image a box touches (plus a pixel of margin), as one window of pixel centers.
fn read_window(
    file: &Path,
    [west, south, east, north]: [f64; 4],
) -> Result<Grid, Box<dyn std::error::Error>> {
    let mut d = Decoder::new(BufReader::new(File::open(file)?))?;
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
    // Pixels are areas: the first sample is the center of the window's first pixel.
    Ok(Grid {
        data,
        w,
        h,
        x0: ox + ((tx0 * tw) as f64 + 0.5) * dx,
        y0: oy + ((ty0 * th) as f64 + 0.5) * dy,
        dx,
        dy,
        nodata,
    })
}
