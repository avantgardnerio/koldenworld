//! Local copies of S3 objects, fetched on first use with the AWS CLI, so the usual credentials apply (AWS_PROFILE, or
//! an instance's role). An object S3 doesn't have leaves a `.none` file beside where its copy would be, so it's asked
//! for once; a fetch that fails otherwise (credentials, network) is logged and tried again next time.

use std::collections::HashMap;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, LazyLock, Mutex};

/// Copies being fetched, by file: callers side by side wait for one fetch rather than each making their own.
static FETCHES: LazyLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = LazyLock::new(Default::default);

/// `file`, fetched from `url` first if it isn't there; None where S3 has no such object, or the fetch failed.
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
    let part = file.with_extension(format!("part{}", std::process::id()));
    let fetched = std::fs::create_dir_all(file.parent()?)
        .map_err(|e| e.to_string())
        .and_then(|_| {
            Command::new("aws")
                .args(["s3", "cp", "--only-show-errors", url])
                .arg(&part)
                .output()
                .map_err(|e| format!("aws: {e}"))
        });
    match fetched {
        Ok(out) if out.status.success() => match std::fs::rename(&part, file) {
            Ok(()) => {
                eprintln!("s3: fetched {url}");
                Some(file.to_path_buf())
            }
            Err(e) => {
                eprintln!("s3: {}: {e}", file.display());
                None
            }
        },
        Ok(out) if String::from_utf8_lossy(&out.stderr).contains("(404)") => {
            File::create(&none).ok();
            None
        }
        Ok(out) => {
            eprintln!("s3: {url}: {}", String::from_utf8_lossy(&out.stderr).trim());
            std::fs::remove_file(&part).ok();
            None
        }
        Err(e) => {
            eprintln!("s3: {url}: {e}");
            None
        }
    }
}

/// Where `url` (`s3://bucket/prefix`) is mirrored under `dir`: `dir/bucket/prefix`.
pub fn mirror(dir: &Path, url: &str) -> PathBuf {
    dir.join(url.trim_start_matches("s3://").trim_end_matches('/'))
}
