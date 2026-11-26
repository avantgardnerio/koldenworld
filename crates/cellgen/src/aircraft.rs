//! Live aircraft for the viewer (decision 31): GET /aircraft?lat=&lon=&nm=
//! answers with readsb-style JSON from adsb.fi's open data API (no key; personal, non-commercial use, credited with a
//! link in the viewer). Sources rate-limit (adsb.fi: 1 request/s, errors count; adsb.lol: 500 a day), so the source
//! sees one request per gap however many tabs ask or wherever they are: at least MIN_GAP, widened to spread any quota
//! it reports is left over the rest of its window, and nothing at all while it has asked us to back off. In between,
//! a request gets the freshest answer for a nearby circle, up to STALE (or two gaps) old; the viewer extrapolates
//! positions anyway. The viewer parses it (parseAircraft in @game/world).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// The source's circle query; AIRCRAFT_SOURCE overrides it (e.g. https://api.adsb.lol/v2/point/{lat}/{lon}/{nm}).
const SOURCE: &str = "https://opendata.adsb.fi/api/v3/lat/{lat}/lon/{lon}/dist/{nm}";
const TTL: Duration = Duration::from_secs(5); // an answer this fresh is reused as is
const MIN_GAP: Duration = Duration::from_secs(5); // between any two requests to the source
const STALE: Duration = Duration::from_secs(120); // the oldest answer served while waiting or blocked
const NEAR_DEG: f64 = 0.5; // how far away a stale answer's center may be
const BACKOFF_S: [u64; 5] = [10, 30, 60, 120, 300]; // after successive 429s without Retry-After
const MAX_NM: f64 = 250.0; // the source's limit

struct Answer {
    at: Instant,
    lat: f64,
    lon: f64,
    body: String,
}

struct State {
    cache: HashMap<String, Answer>,
    inflight: bool,
    last_fetch: Option<Instant>,
    gap: Duration, // between requests to the source; wider when its quota runs low
    blocked_until: Option<Instant>,
    strikes: usize,
}

pub struct Aircraft {
    state: Mutex<State>,
    client: reqwest::Client,
    source: String,
}

impl Aircraft {
    pub fn new() -> Result<Aircraft, reqwest::Error> {
        Ok(Aircraft {
            state: Mutex::new(State {
                cache: HashMap::new(),
                inflight: false,
                last_fetch: None,
                gap: MIN_GAP,
                blocked_until: None,
                strikes: 0,
            }),
            client: reqwest::Client::builder()
                .user_agent("game-viewer (personal project)")
                .timeout(Duration::from_secs(20))
                .build()?,
            source: std::env::var("AIRCRAFT_SOURCE").unwrap_or_else(|_| SOURCE.to_string()),
        })
    }

    /// The JSON for a circle; requests within 0.1° of each other share an answer.
    pub async fn around(&self, lat: f64, lon: f64, nm: f64) -> Result<String, String> {
        // As JS Math.round: halves round up.
        let tenth = |v: f64| (v * 10.0 + 0.5).floor() / 10.0;
        let (la, lo, r) = (
            tenth(lat),
            tenth(lon),
            (nm + 0.5).floor().clamp(1.0, MAX_NM),
        );
        let key = format!("{la}/{lo}/{r}");
        {
            let mut s = self.state.lock().unwrap();
            let now = Instant::now();
            if let Some(hit) = s.cache.get(&key)
                && now - hit.at < TTL
            {
                return Ok(hit.body.clone());
            }
            let max_age = STALE.max(2 * s.gap);
            s.cache.retain(|_, a| now - a.at <= max_age);
            let waiting = s.last_fetch.is_some_and(|t| now - t < s.gap);
            if s.inflight || s.blocked_until.is_some_and(|b| now < b) || waiting {
                return stale(&s, la, lo);
            }
            s.last_fetch = Some(now);
            s.inflight = true;
        }
        let result = self.fetch(&key, la, lo, r).await;
        let mut s = self.state.lock().unwrap();
        s.inflight = false;
        match result {
            Ok(body) => Ok(body),
            Err(e) => {
                eprintln!("aircraft {key}: {e}");
                stale(&s, la, lo)
            }
        }
    }

    async fn fetch(&self, key: &str, lat: f64, lon: f64, r: f64) -> Result<String, String> {
        let url = self
            .source
            .replace("{lat}", &lat.to_string())
            .replace("{lon}", &lon.to_string())
            .replace("{nm}", &r.to_string());
        let res = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let header = |name: &str| -> Option<f64> {
            res.headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.trim().parse().ok())
        };
        let (remaining, reset, retry) = (
            header("x-ratelimit-remaining"),
            header("x-ratelimit-reset"),
            header("retry-after"),
        );
        let status = res.status();
        {
            let mut s = self.state.lock().unwrap();
            // A daily quota (adsb.lol's x-ratelimit-limit: 500;w=86400): spread what is left over the window.
            if let (Some(remaining), Some(reset)) = (remaining, reset)
                && reset > 0.0
            {
                s.gap = MIN_GAP.max(Duration::from_secs_f64(reset / remaining.max(1.0)));
            }
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                let wait = match (retry, reset) {
                    (Some(r), _) if r > 0.0 => Duration::from_secs_f64(r),
                    (_, Some(r)) if r > 0.0 => Duration::from_secs_f64(r),
                    _ => Duration::from_secs(BACKOFF_S[s.strikes.min(BACKOFF_S.len() - 1)]),
                };
                s.strikes += 1;
                s.blocked_until = Some(Instant::now() + wait);
                return Err(format!(
                    "aircraft source: HTTP 429, backing off {} s",
                    wait.as_secs()
                ));
            }
        }
        if !status.is_success() {
            return Err(format!("aircraft source: HTTP {}", status.as_u16()));
        }
        let body = res.text().await.map_err(|e| e.to_string())?;
        let mut s = self.state.lock().unwrap();
        s.strikes = 0;
        s.cache.insert(
            key.to_string(),
            Answer {
                at: Instant::now(),
                lat,
                lon,
                body: body.clone(),
            },
        );
        Ok(body)
    }
}

/// The freshest answer for a circle centered within NEAR_DEG, or why there is none.
fn stale(s: &State, lat: f64, lon: f64) -> Result<String, String> {
    let best = s
        .cache
        .values()
        .filter(|a| (a.lat - lat).abs() <= NEAR_DEG && (a.lon - lon).abs() <= NEAR_DEG)
        .max_by_key(|a| a.at);
    if let Some(a) = best {
        return Ok(a.body.clone());
    }
    let now = Instant::now();
    let next = [s.blocked_until, s.last_fetch.map(|t| t + MIN_GAP)]
        .into_iter()
        .flatten()
        .max()
        .unwrap_or(now);
    Err(format!(
        "aircraft source: rate-limited, next request in {} s",
        next.saturating_duration_since(now).as_secs().max(1)
    ))
}
