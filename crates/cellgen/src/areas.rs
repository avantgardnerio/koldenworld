//! OSM data on demand: before a cell is built, every download area (a level-FETCH_LEVEL S2 cell, about 4.5 km) it
//! draws from is fetched (Overpass, cached in data/osm/s2/) and imported into Postgres, once. Downloads run one at a
//! time (Overpass is a shared server); asking for an area being imported waits for that import. What's imported is
//! known from osm_fetches (area "s2:<token>"), read once at the start.
//!
//! An area whose level-6 cell has local cell files (data/osm/cells/, see local.rs) is loaded from them instead of
//! Overpass: no download, no waiting on other areas.

use crate::cell::Cell;
use crate::{extract, fetch, import, local, osm};
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
        let cells = local::cells_dir(&self.data);
        let c2 = Cell::from_token(token).ok_or_else(|| format!("{token} isn't a cell token"))?;
        let loaded = tokio::task::spawn_blocking(move || local::load(&cells, &c2)).await??;
        let (raw, source, osm) = match loaded {
            Some(loaded) => (loaded.identity, loaded.source, Some(loaded.osm)),
            None => {
                let _one = self.download.lock().await;
                let raw = fetch::fetch(&self.data, &c, |m| println!("{m}")).await?;
                (raw, fetch::OVERPASS_URL.to_string(), None)
            }
        };
        let fetched = started.elapsed();
        let raw2 = raw.clone();
        let (osm, x) = tokio::task::spawn_blocking(move || -> Result<_, Error> {
            let osm = match osm {
                Some(osm) => osm,
                None => osm::parse(&raw2)?,
            };
            let x = extract::extract(&osm);
            Ok((osm, x))
        })
        .await??;
        let area = format!("s2:{token}");
        let snapshot = import::Snapshot {
            area: &area,
            bbox: fetch::padded_box(&c),
            source: &source,
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
