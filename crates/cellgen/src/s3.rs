//! Local copies of S3 objects, fetched on first use with the AWS SDK, so the usual credentials apply (AWS_PROFILE and
//! its SSO session locally, the function's role on Lambda). The region is the bucket's, BUCKET_REGION (or
//! CELLGEN_S3_REGION), whatever the profile's is: S3 answers a request to another region with a redirect. An object S3 doesn't have leaves a `.none` file beside where its copy would be, so it's asked for
//! once; a fetch that fails otherwise (credentials, network) is logged and tried again next time.
//!
//! Callers are synchronous (cell builds run on blocking threads): each request runs on this module's own runtime, from
//! a thread of its own, so it works with or without a Tokio runtime around the caller.

use aws_config::BehaviorVersion;
use std::collections::HashMap;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use tokio::runtime::Runtime;

/// Where the data's bucket is, unless CELLGEN_S3_REGION says otherwise.
const BUCKET_REGION: &str = "us-east-2";

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
