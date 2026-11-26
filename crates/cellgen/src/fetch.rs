//! Raw OSM downloads from the Overpass API, one level-FETCH_LEVEL S2 cell (about 4.5 km) at a time: everything in the
//! cell's lon/lat box (padded 50 m: cell edges are great-circle arcs), plus the outside nodes of ways crossing its edge.
//! Cached under data/osm/s2/<token>.json with a <token>.meta.json beside it, so an
//! area is downloaded once.

use crate::cell::Cell;
use crate::s2;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// The level of the cells OSM data is fetched by.
pub const FETCH_LEVEL: u32 = 12;
pub const OVERPASS_URL: &str = "https://overpass-api.de/api/interpreter";
const USER_AGENT: &str = "game-osm-fetch/0.2 (hobby project; one-time area download)";
/// Padding around a cell's box, m.
const PAD: f64 = 50.0;

/// The fetch cell (level FETCH_LEVEL) holding a point.
pub fn fetch_cell(lat: f64, lon: f64) -> Cell {
    let (face, st) = s2::lat_lon_to_face_st(lat, lon);
    Cell::from_token(&s2::token(s2::cell_id(face, st, FETCH_LEVEL))).expect("a cell's own token")
}

/// A fetch cell's raw data: from the cache, or downloaded (and cached) when it isn't there.
pub async fn fetch(
    data: &Path,
    c: &Cell,
    log: impl Fn(&str),
) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
    let (raw, meta) = paths(data, &c.token);
    if let Ok(body) = tokio::fs::read(&raw).await {
        return Ok(body);
    }
    let [west, south, east, north] = padded_box(c);
    let query = format!(
        "[out:json][timeout:300];\n(\n  nwr({south:.6},{west:.6},{north:.6},{east:.6});\n  way({south:.6},{west:.6},{north:.6},{east:.6});\n  >;\n);\nout body;"
    );
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(600))
        .build()?;
    let started = std::time::Instant::now();
    let mut attempt = 1;
    let body = loop {
        log(&format!("fetch {}: downloading from Overpass", c.token));
        let res = client
            .post(OVERPASS_URL)
            .form(&[("data", query.as_str())])
            .send()
            .await?;
        let status = res.status().as_u16();
        // Busy: wait longer each time.
        if [429, 502, 503, 504].contains(&status) && attempt < 6 {
            log(&format!(
                "fetch {}: Overpass busy ({status}); retrying in {} s",
                c.token,
                15 * attempt
            ));
            tokio::time::sleep(Duration::from_secs(15 * attempt)).await;
            attempt += 1;
            continue;
        }
        if !res.status().is_success() {
            return Err(format!(
                "Overpass: {status} {}",
                res.text().await.unwrap_or_default()
            )
            .into());
        }
        break res.bytes().await?.to_vec();
    };
    let osm = crate::osm::parse(&body)?; // a remark (timeout, error) fails here, before anything is cached
    tokio::fs::create_dir_all(raw.parent().ok_or("no cache directory")?).await?;
    write_atomic(&raw, &body).await?;
    let meta_json = serde_json::json!({
        "cell": c.token, "level": FETCH_LEVEL,
        "bbox": { "south": south, "north": north, "west": west, "east": east },
        "query": query, "source": OVERPASS_URL, "osmBaseTimestamp": osm.timestamp,
        "elements": osm.nodes() + osm.ways() + osm.relations(), "bytes": body.len(),
        "seconds": started.elapsed().as_secs_f64(),
    });
    write_atomic(&meta, serde_json::to_string_pretty(&meta_json)?.as_bytes()).await?;
    Ok(body)
}

/// The cache files: the raw response and what it was.
fn paths(data: &Path, token: &str) -> (PathBuf, PathBuf) {
    let dir = data.join("osm").join("s2");
    (
        dir.join(format!("{token}.json")),
        dir.join(format!("{token}.meta.json")),
    )
}

/// A cell's lon/lat box (west, south, east, north), PAD m wider each way.
pub fn padded_box(c: &Cell) -> [f64; 4] {
    let [west, south, east, north] = s2::lat_lon_bounds(c.face, c.square, 0.0);
    let dlat = PAD / 111_320.0;
    let dlon = PAD / (111_320.0 * ((south + north) / 2.0).to_radians().cos());
    [west - dlon, south - dlat, east + dlon, north + dlat]
}

/// Writes to a temporary name, then renames, so a reader never sees half a file.
async fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    tokio::fs::write(&tmp, bytes).await?;
    tokio::fs::rename(&tmp, path).await
}
