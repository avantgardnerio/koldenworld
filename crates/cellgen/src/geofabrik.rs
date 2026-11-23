//! Geofabrik's regional OSM extracts (download.geofabrik.de): continents, countries, US states and smaller, each a
//! PBF file updated daily. Their index (every region's outline, parent and file) is downloaded once; for a point, the
//! region is the deepest one holding it (a state rather than its country), and its file is downloaded once into
//! data/osm/pbf/ under Geofabrik's own path (a file of the same name directly in data/osm/pbf/ counts too).

use std::path::{Path, PathBuf};
use std::time::Duration;

const INDEX_URL: &str = "https://download.geofabrik.de/index-v1.json";
const USER_AGENT: &str = "game-osm-fetch/0.2 (hobby project; regional extracts, downloaded once)";

/// Every region: its id ("us/colorado"), parent, PBF URL, and outline (polygons' rings, lon/lat; CSR).
pub struct Index {
    pub id: Vec<String>,
    pub parent: Vec<Option<usize>>,
    pub pbf: Vec<String>,
    ring_of: Vec<u32>,    // regions + 1 offsets into ring_start
    ring_start: Vec<u32>, // rings + 1 offsets into lonlat
    lonlat: Vec<[f64; 2]>,
}

/// The index, downloaded once into data/osm/geofabrik/.
pub async fn index(data: &Path) -> Result<Index, Box<dyn std::error::Error + Send + Sync>> {
    let file = data.join("osm").join("geofabrik").join("index-v1.json");
    let body = match tokio::fs::read(&file).await {
        Ok(body) => body,
        Err(_) => {
            let body = client()?
                .get(INDEX_URL)
                .send()
                .await?
                .error_for_status()?
                .bytes()
                .await?
                .to_vec();
            tokio::fs::create_dir_all(file.parent().ok_or("no directory")?).await?;
            write_atomic(&file, &body).await?;
            body
        }
    };
    parse_index(&body)
}

impl Index {
    /// The deepest region holding a point, if any.
    pub fn region(&self, lat: f64, lon: f64) -> Option<usize> {
        (0..self.id.len())
            .filter(|&r| self.contains(r, lon, lat))
            .max_by_key(|&r| self.depth(r))
    }

    fn depth(&self, mut r: usize) -> usize {
        let mut d = 0;
        while let Some(p) = self.parent[r] {
            (r, d) = (p, d + 1);
        }
        d
    }

    /// Even-odd across all the region's rings (outer and inner alike).
    fn contains(&self, r: usize, x: f64, y: f64) -> bool {
        let mut inside = false;
        for ring in self.ring_of[r] as usize..self.ring_of[r + 1] as usize {
            let pts =
                &self.lonlat[self.ring_start[ring] as usize..self.ring_start[ring + 1] as usize];
            let mut j = pts.len() - 1;
            for i in 0..pts.len() {
                let ([xi, yi], [xj, yj]) = (pts[i], pts[j]);
                if (yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi {
                    inside = !inside;
                }
                j = i;
            }
        }
        inside
    }
}

/// A region's PBF: where it is (downloaded first if it isn't there yet).
pub async fn pbf(
    data: &Path,
    index: &Index,
    r: usize,
    log: impl Fn(&str),
) -> Result<PathBuf, Box<dyn std::error::Error + Send + Sync>> {
    let url = &index.pbf[r];
    let rel = url
        .strip_prefix("https://download.geofabrik.de/")
        .ok_or("not a Geofabrik URL")?;
    let dir = data.join("osm").join("pbf");
    let path = dir.join(rel);
    let name = Path::new(rel).file_name().ok_or("no file name")?;
    for existing in [path.clone(), dir.join(name)] {
        if tokio::fs::metadata(&existing).await.is_ok() {
            return Ok(existing);
        }
    }
    log(&format!("region {}: downloading {url}", index.id[r]));
    let started = std::time::Instant::now();
    tokio::fs::create_dir_all(path.parent().ok_or("no directory")?).await?;
    let tmp = path.with_extension("tmp");
    let mut file = tokio::fs::File::create(&tmp).await?;
    let mut res = latest(url, &log).await?;
    let (mut got, mut reported) = (0u64, 0u64);
    while let Some(chunk) = res.chunk().await? {
        tokio::io::AsyncWriteExt::write_all(&mut file, &chunk).await?;
        got += chunk.len() as u64;
        if got - reported >= 100_000_000 {
            log(&format!("region {}: {} MB", index.id[r], got / 1_000_000));
            reported = got;
        }
    }
    tokio::io::AsyncWriteExt::flush(&mut file).await?;
    tokio::fs::rename(&tmp, &path).await?;
    log(&format!(
        "region {}: {} MB in {:.0?}",
        index.id[r],
        got / 1_000_000,
        started.elapsed()
    ));
    Ok(path)
}

/// A region's latest extract. "-latest" redirects to a dated file ("washington-261122.osm.pbf"), which can be missing
/// while the day's is still being published: then the days before, back three.
async fn latest(
    url: &str,
    log: &impl Fn(&str),
) -> Result<reqwest::Response, Box<dyn std::error::Error + Send + Sync>> {
    let client = client()?;
    let res = client.get(url).send().await?;
    if res.status() != reqwest::StatusCode::NOT_FOUND {
        return Ok(res.error_for_status()?);
    }
    let dated = res.url().to_string();
    let date = dated
        .rsplit('-')
        .next()
        .and_then(|d| d.strip_suffix(".osm.pbf"))
        .ok_or("no date in the redirect")?;
    let day = days_from_yymmdd(date).ok_or("a date that isn't YYMMDD")?;
    for back in 1..=3 {
        let earlier = dated.replace(
            &format!("-{date}.osm.pbf"),
            &format!("-{}.osm.pbf", yymmdd(day - back)),
        );
        log(&format!("{dated} isn't there yet; trying {earlier}"));
        let res = client.get(&earlier).send().await?;
        if res.status().is_success() {
            return Ok(res);
        }
    }
    Err(format!("no extract at {dated} or the three days before").into())
}

/// Days since 2000-01-01 for a YYMMDD date (20YY), and back (civil calendar, Howard Hinnant's algorithm).
fn days_from_yymmdd(d: &str) -> Option<i64> {
    let (y, m, day): (i64, i64, i64) = (
        2000 + d.get(0..2)?.parse::<i64>().ok()?,
        d.get(2..4)?.parse().ok()?,
        d.get(4..6)?.parse().ok()?,
    );
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + day - 1;
    Some(era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 730_425)
}

fn yymmdd(days: i64) -> String {
    let z = days + 730_425;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{:02}{m:02}{d:02}", y - 2000)
}

fn parse_index(body: &[u8]) -> Result<Index, Box<dyn std::error::Error + Send + Sync>> {
    let json: serde_json::Value = serde_json::from_slice(body)?;
    let features = json["features"].as_array().ok_or("no features")?;
    let mut index = Index {
        id: Vec::new(),
        parent: Vec::new(),
        pbf: Vec::new(),
        ring_of: vec![0],
        ring_start: vec![0],
        lonlat: Vec::new(),
    };
    let mut parents = Vec::new();
    for f in features {
        let p = &f["properties"];
        let (Some(id), Some(pbf)) = (p["id"].as_str(), p["urls"]["pbf"].as_str()) else {
            continue;
        };
        index.id.push(id.to_string());
        index.pbf.push(pbf.to_string());
        parents.push(p["parent"].as_str().map(String::from));
        // MultiPolygon: polygons → rings → [lon, lat].
        for polygon in f["geometry"]["coordinates"]
            .as_array()
            .into_iter()
            .flatten()
        {
            for ring in polygon.as_array().into_iter().flatten() {
                for pt in ring.as_array().into_iter().flatten() {
                    index
                        .lonlat
                        .push([pt[0].as_f64().unwrap_or(0.0), pt[1].as_f64().unwrap_or(0.0)]);
                }
                index.ring_start.push(index.lonlat.len() as u32);
            }
        }
        index.ring_of.push(index.ring_start.len() as u32 - 1);
    }
    index.parent = parents
        .iter()
        .map(|p| {
            p.as_ref()
                .and_then(|p| index.id.iter().position(|i| i == p))
        })
        .collect();
    Ok(index)
}

fn client() -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(3600))
        .build()
}

async fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    tokio::fs::write(&tmp, bytes).await?;
    tokio::fs::rename(&tmp, path).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steps_back_a_day_across_months_and_years() {
        let back = |d: &str| yymmdd(days_from_yymmdd(d).unwrap() - 1);
        assert_eq!(back("261122"), "261121");
        assert_eq!(back("260301"), "260228");
        assert_eq!(back("240301"), "240229"); // a leap year
        assert_eq!(back("270101"), "261231");
    }
}
