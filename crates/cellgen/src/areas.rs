//! OSM data on demand: before a cell is built, every download area (a level-FETCH_LEVEL S2 cell, about 4.5 km) it
//! draws from is fetched (Overpass, cached in data/osm/s2/) and imported into Postgres, once. Downloads run one at a
//! time (Overpass is a shared server); asking for an area being imported waits for that import. What's imported is
//! known from osm_fetches (area "s2:<token>"), read once at the start.

use crate::cell::Cell;
use crate::{extract, fetch, import, osm, s2};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

type Error = Box<dyn std::error::Error + Send + Sync>;

pub struct Areas {
    data: PathBuf,
    pool: deadpool_postgres::Pool,
    imported: Mutex<HashSet<String>>,
    importing: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>, // a lock per area being asked for
    download: tokio::sync::Mutex<()>,                               // one download at a time
}

impl Areas {
    /// The areas already imported, from osm_fetches.
    pub async fn new(data: PathBuf, pool: deadpool_postgres::Pool) -> Result<Areas, Error> {
        let rows = pool
            .get()
            .await?
            .query(
                "SELECT DISTINCT substr(area, 4) FROM osm_fetches WHERE area LIKE 's2:%'",
                &[],
            )
            .await?;
        Ok(Areas {
            data,
            pool,
            imported: Mutex::new(rows.iter().map(|r| r.get(0)).collect()),
            importing: Mutex::default(),
            download: tokio::sync::Mutex::new(()),
        })
    }

    pub fn imported(&self) -> usize {
        self.imported.lock().unwrap().len()
    }

    /// Every area a cell draws from imported: those its load box (its square and a quarter of it around) touches.
    pub async fn ensure_cell(&self, c: &Cell) -> Result<(), Error> {
        for token in areas_for(c) {
            self.ensure(&token).await?;
        }
        Ok(())
    }

    /// An area imported: fetched (if it isn't cached) and imported, once.
    pub async fn ensure(&self, token: &str) -> Result<(), Error> {
        if self.imported.lock().unwrap().contains(token) {
            return Ok(());
        }
        let lock = self
            .importing
            .lock()
            .unwrap()
            .entry(token.to_string())
            .or_default()
            .clone();
        let _held = lock.lock().await;
        if self.imported.lock().unwrap().contains(token) {
            return Ok(());
        }
        let c = Cell::from_token(token).ok_or_else(|| format!("{token} isn't a cell token"))?;
        if c.level != fetch::FETCH_LEVEL {
            return Err(format!(
                "{token} isn't a download area (level {})",
                fetch::FETCH_LEVEL
            )
            .into());
        }
        let started = std::time::Instant::now();
        let raw = {
            let _one = self.download.lock().await;
            fetch::fetch(&self.data, &c, |m| println!("{m}")).await?
        };
        let fetched = started.elapsed();
        let raw2 = raw.clone();
        let (osm, x) = tokio::task::spawn_blocking(move || -> Result<_, Error> {
            let osm = osm::parse(&raw2)?;
            let x = extract::extract(&osm);
            Ok((osm, x))
        })
        .await??;
        let area = format!("s2:{token}");
        let snapshot = import::Snapshot {
            area: &area,
            bbox: fetch::padded_box(&c),
            source: fetch::OVERPASS_URL,
            raw: &raw,
        };
        let mut db = self.pool.get().await?;
        let counts = import::import(&mut db, &snapshot, &osm, &x).await?;
        let upserted: u64 = counts.upserted.iter().map(|(_, n)| n).sum();
        println!(
            "area {token}: {upserted} rows imported in {:.1?} (fetched in {fetched:.1?})",
            started.elapsed()
        );
        self.imported.lock().unwrap().insert(token.to_string());
        Ok(())
    }
}

/// The download areas a cell's load box touches: its corners and points every ~500 m across it.
fn areas_for(c: &Cell) -> Vec<String> {
    let [west, south, east, north] = c.load_box();
    let step_lat = 500.0 / 111_320.0;
    let step_lon = step_lat / ((south + north) / 2.0).to_radians().cos().max(0.01);
    let mut tokens = Vec::new();
    let mut seen = HashSet::new();
    let (nx, ny) = (
        ((east - west) / step_lon).ceil() as usize,
        ((north - south) / step_lat).ceil() as usize,
    );
    for j in 0..=ny {
        for i in 0..=nx {
            let lat = (south + j as f64 * step_lat).min(north);
            let lon = (west + i as f64 * step_lon).min(east);
            let (face, st) = s2::lat_lon_to_face_st(lat, lon);
            let token = s2::token(s2::cell_id(face, st, fetch::FETCH_LEVEL));
            if seen.insert(token.clone()) {
                tokens.push(token);
            }
        }
    }
    tokens
}
