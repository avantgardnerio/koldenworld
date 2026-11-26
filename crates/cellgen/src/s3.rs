//! Local copies of S3 objects, fetched on first use with the AWS SDK, so the usual credentials apply (AWS_PROFILE and
//! its SSO session locally, the function's role on Lambda). The region is the bucket's, BUCKET_REGION (or
//! CELLGEN_S3_REGION), whatever the profile's is: S3 answers a request to another region with a redirect. An object S3 doesn't have leaves a `.none` file beside where its copy would be, so it's asked for
//! once; a fetch that fails otherwise (credentials, network) is logged and tried again next time.
//!
//! Callers are synchronous (cell builds run on blocking threads): each request runs on this module's own runtime, from
//! a thread of its own, so it works with or without a Tokio runtime around the caller.
//!
//! Ranged: `open` gives a Read + Seek over an object that fetches it PAGE bytes at a time as they're read, kept in a
//! cache shared by the process (CELLGEN_PAGE_CACHE_MB, default PAGE_CACHE_MB; the oldest pages go first), so a
//! tiled GeoTIFF costs its header and the blocks a box needs, and the next cell in the same tile reuses them.

use aws_config::BehaviorVersion;
use std::collections::HashMap;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use tokio::runtime::Runtime;

/// Where the data's bucket is, unless CELLGEN_S3_REGION says otherwise.
const BUCKET_REGION: &str = "us-east-2";

/// Bytes fetched at a time by an `open` reader.
const PAGE: u64 = 256 * 1024;
/// The page cache's size, MB, unless CELLGEN_PAGE_CACHE_MB says otherwise.
const PAGE_CACHE_MB: u64 = 256;

/// Fetched pages, by (object, page), oldest first in `order`; `bytes` in all.
#[derive(Default)]
struct Pages {
    page: HashMap<(Arc<str>, u64), Arc<[u8]>>,
    order: std::collections::VecDeque<(Arc<str>, u64)>,
    bytes: u64,
}
static PAGES: LazyLock<Mutex<Pages>> = LazyLock::new(Default::default);
/// Ranged requests made, and bytes they brought, since the process started.
static FETCHED: [std::sync::atomic::AtomicU64; 2] =
    [const { std::sync::atomic::AtomicU64::new(0) }; 2];

/// Ranged requests made and bytes fetched so far (pages, not cache hits).
pub fn fetched() -> (u64, u64) {
    let load = |i: usize| FETCHED[i].load(std::sync::atomic::Ordering::Relaxed);
    (load(0), load(1))
}

/// Each object's size once known; None for one S3 doesn't have.
static SIZES: LazyLock<Mutex<HashMap<Arc<str>, Option<u64>>>> = LazyLock::new(Default::default);

/// Copies being fetched, by file: callers side by side wait for one fetch rather than each making their own.
static FETCHES: LazyLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = LazyLock::new(Default::default);

static RUNTIME: LazyLock<Runtime> = LazyLock::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("a Tokio runtime for S3")
});

static CLIENT: LazyLock<aws_sdk_s3::Client> = LazyLock::new(|| {
    let region = std::env::var("CELLGEN_S3_REGION").unwrap_or_else(|_| BUCKET_REGION.into());
    let config = run(aws_config::defaults(BehaviorVersion::latest())
        .region(aws_config::Region::new(region))
        .load());
    aws_sdk_s3::Client::new(&config)
});

/// `file`, fetched from `url` (`s3://bucket/key`) first if it isn't there; None where S3 has no such object, or the
/// fetch failed.
pub fn local_copy(url: &str, file: &Path) -> Option<PathBuf> {
    let none = file.with_extension("none");
    let known =
        || (file.exists() || none.exists()).then(|| file.exists().then(|| file.to_path_buf()));
    if let Some(found) = known() {
        return found;
    }
    let lock = FETCHES
        .lock()
        .unwrap()
        .entry(file.to_path_buf())
        .or_default()
        .clone();
    let _fetching = lock.lock().unwrap();
    if let Some(found) = known() {
        return found; // fetched while we waited
    }
    let Some((bucket, key)) = split(url) else {
        eprintln!("s3: {url} isn't an s3://bucket/key URL");
        return None;
    };
    let part = file.with_extension(format!("part{}", std::process::id()));
    if let Err(e) = std::fs::create_dir_all(file.parent()?) {
        eprintln!("s3: {}: {e}", file.display());
        return None;
    }
    match run(download(bucket, key, &part)) {
        Ok(true) => match std::fs::rename(&part, file) {
            Ok(()) => {
                eprintln!("s3: fetched {url}");
                Some(file.to_path_buf())
            }
            Err(e) => {
                eprintln!("s3: {}: {e}", file.display());
                None
            }
        },
        Ok(false) => {
            File::create(&none).ok();
            None
        }
        Err(e) => {
            eprintln!("s3: {url}: {e}");
            std::fs::remove_file(&part).ok();
            None
        }
    }
}

/// An object's bytes, or None where S3 has no such object. For async callers (on any runtime: the request runs on
/// this module's).
pub async fn get(url: &str) -> Result<Option<Vec<u8>>, String> {
    let (bucket, key) = split(url).ok_or(format!("{url} isn't an s3://bucket/key URL"))?;
    let (bucket, key) = (bucket.to_string(), key.to_string());
    RUNTIME
        .spawn(async move {
            match CLIENT.get_object().bucket(bucket).key(key).send().await {
                Ok(o) => o
                    .body
                    .collect()
                    .await
                    .map(|b| Some(b.into_bytes().to_vec()))
                    .map_err(|e| e.to_string()),
                Err(e) if e.raw_response().is_some_and(|r| r.status().as_u16() == 404) => Ok(None),
                Err(e) => Err(aws_sdk_s3::error::DisplayErrorContext(e).to_string()),
            }
        })
        .await
        .map_err(|e| e.to_string())?
}

/// Writes an object (whole: a reader sees the old one or the new one, never part).
pub async fn put(url: &str, bytes: Vec<u8>, content_type: &str) -> Result<(), String> {
    let (bucket, key) = split(url).ok_or(format!("{url} isn't an s3://bucket/key URL"))?;
    let request = CLIENT
        .put_object()
        .bucket(bucket)
        .key(key)
        .content_type(content_type)
        .body(bytes.into());
    RUNTIME
        .spawn(async move { request.send().await.map(|_| ()) })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| aws_sdk_s3::error::DisplayErrorContext(e).to_string())
}

/// A reader over an object, fetched in pages as it's read (see the module's notes); None where S3 has no such object.
pub fn open(url: &str) -> Result<Option<Reader>, String> {
    let url: Arc<str> = url.into();
    let known = SIZES.lock().unwrap().get(&url).copied();
    let size = match known {
        Some(size) => size,
        None => {
            // The first page tells the size (Content-Range), or that there's no such object.
            let size = page(&url, 0)?.map(|(_, size)| size);
            SIZES.lock().unwrap().insert(url.clone(), size);
            size
        }
    };
    Ok(size.map(|size| Reader { url, size, pos: 0 }))
}

/// An object read in cached pages: see `open`.
pub struct Reader {
    url: Arc<str>,
    size: u64,
    pos: u64,
}

impl std::io::Read for Reader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.pos >= self.size || buf.is_empty() {
            return Ok(0);
        }
        let (index, within) = (self.pos / PAGE, (self.pos % PAGE) as usize);
        let (bytes, _) = page(&self.url, index)
            .map_err(std::io::Error::other)?
            .ok_or_else(|| std::io::Error::other(format!("{}: gone", self.url)))?;
        let n = buf.len().min(bytes.len() - within);
        buf[..n].copy_from_slice(&bytes[within..within + n]);
        self.pos += n as u64;
        Ok(n)
    }
}

impl std::io::Seek for Reader {
    fn seek(&mut self, to: std::io::SeekFrom) -> std::io::Result<u64> {
        let pos = match to {
            std::io::SeekFrom::Start(p) => p as i128,
            std::io::SeekFrom::End(d) => self.size as i128 + d as i128,
            std::io::SeekFrom::Current(d) => self.pos as i128 + d as i128,
        };
        if pos < 0 {
            return Err(std::io::Error::other("seek before the start"));
        }
        self.pos = pos as u64;
        Ok(self.pos)
    }
}

/// A page's bytes, and the size of the object it's from.
type Page = (Arc<[u8]>, u64);

/// Page `index` of an object, from the cache or S3, with the object's size; None where S3 has no such object.
fn page(url: &Arc<str>, index: u64) -> Result<Option<Page>, String> {
    let key = (url.clone(), index);
    let cached = PAGES.lock().unwrap().page.get(&key).cloned();
    let size = SIZES.lock().unwrap().get(url).copied().flatten();
    if let (Some(bytes), Some(size)) = (cached, size) {
        return Ok(Some((bytes, size)));
    }
    let (bucket, k) = split(url).ok_or(format!("{url} isn't an s3://bucket/key URL"))?;
    let range = format!("bytes={}-{}", index * PAGE, (index + 1) * PAGE - 1);
    let fetched = run(async {
        match CLIENT
            .get_object()
            .bucket(bucket)
            .key(k)
            .range(range)
            .send()
            .await
        {
            Ok(o) => {
                // Content-Range: bytes <first>-<last>/<size>.
                let size = o
                    .content_range()
                    .and_then(|r| r.rsplit_once('/'))
                    .and_then(|(_, n)| n.parse::<u64>().ok());
                let body = o.body.collect().await.map_err(|e| e.to_string())?;
                Ok(Some((body.into_bytes(), size)))
            }
            Err(e) if e.raw_response().is_some_and(|r| r.status().as_u16() == 404) => Ok(None),
            Err(e) => Err(aws_sdk_s3::error::DisplayErrorContext(e).to_string()),
        }
    })?;
    let Some((body, size)) = fetched else {
        return Ok(None);
    };
    let size = size.ok_or(format!("{url}: no Content-Range"))?;
    let bytes: Arc<[u8]> = body.to_vec().into();
    FETCHED[0].fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    FETCHED[1].fetch_add(bytes.len() as u64, std::sync::atomic::Ordering::Relaxed);
    let limit = std::env::var("CELLGEN_PAGE_CACHE_MB")
        .ok()
        .and_then(|m| m.parse().ok())
        .unwrap_or(PAGE_CACHE_MB)
        << 20;
    let mut pages = PAGES.lock().unwrap();
    if pages.page.insert(key.clone(), bytes.clone()).is_none() {
        pages.order.push_back(key);
        pages.bytes += bytes.len() as u64;
    }
    while pages.bytes > limit
        && let Some(old) = pages.order.pop_front()
    {
        if let Some(b) = pages.page.remove(&old) {
            pages.bytes -= b.len() as u64;
        }
    }
    Ok(Some((bytes, size)))
}

/// Where `url` (`s3://bucket/prefix`) is mirrored under `dir`: `dir/bucket/prefix`.
pub fn mirror(dir: &Path, url: &str) -> PathBuf {
    dir.join(url.trim_start_matches("s3://").trim_end_matches('/'))
}

/// An object into `file`: true, or false where S3 has no such object.
async fn download(bucket: &str, key: &str, file: &Path) -> Result<bool, String> {
    let object = match CLIENT.get_object().bucket(bucket).key(key).send().await {
        Ok(o) => o,
        Err(e) if e.raw_response().is_some_and(|r| r.status().as_u16() == 404) => return Ok(false),
        Err(e) => return Err(aws_sdk_s3::error::DisplayErrorContext(e).to_string()),
    };
    let mut body = object.body.into_async_read();
    let mut out = tokio::fs::File::create(file)
        .await
        .map_err(|e| e.to_string())?;
    tokio::io::copy(&mut body, &mut out)
        .await
        .map_err(|e| e.to_string())?;
    Ok(true)
}

/// `s3://bucket/key` → (bucket, key).
fn split(url: &str) -> Option<(&str, &str)> {
    url.strip_prefix("s3://")?
        .split_once('/')
        .filter(|(b, k)| !b.is_empty() && !k.is_empty())
}

/// A future run to completion on this module's runtime, from a thread of its own (so a caller already inside a Tokio
/// runtime, as the server's blocking threads are, can wait on it).
fn run<F: Future + Send>(f: F) -> F::Output
where
    F::Output: Send,
{
    std::thread::scope(|s| s.spawn(|| RUNTIME.block_on(f)).join().unwrap())
}
