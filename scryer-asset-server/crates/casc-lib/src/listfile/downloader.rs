//! Listfile download and caching.
//!
//! Downloads the community listfile from the `wowdev/wow-listfile` GitHub
//! release (primary) or the Wago Tools API (fallback), and caches it on disk
//! inside a `.casc-meta/` directory.
//!
//! Change-detection: a sidecar `listfile-meta.json` records the GitHub release
//! tag and the last-check timestamp. On subsequent runs the GitHub Releases API
//! is queried at most once per 24 h; if the tag is unchanged the cached CSV is
//! reused without re-downloading.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use crate::error::Result;
use super::parser::Listfile;

const LISTFILE_URL_PRIMARY: &str =
    "https://github.com/wowdev/wow-listfile/releases/latest/download/community-listfile.csv";
const LISTFILE_URL_FALLBACK: &str = "https://wago.tools/api/casc/listfile";
const GITHUB_RELEASES_API: &str =
    "https://api.github.com/repos/wowdev/wow-listfile/releases/latest";
const MAX_AGE_SECS: u64 = 24 * 60 * 60;

/// Persisted change-detection metadata for the cached listfile.
#[derive(Serialize, Deserialize)]
struct ListfileMeta {
    /// GitHub release tag at the time of the last successful check.
    tag: String,
    /// Unix timestamp (seconds) of the last tag verification.
    checked_at_secs: u64,
}

/// Cache path for the listfile CSV.
pub fn cache_path(output_dir: &Path) -> PathBuf {
    output_dir.join(".casc-meta").join("listfile.csv")
}

fn meta_path(output_dir: &Path) -> PathBuf {
    output_dir.join(".casc-meta").join("listfile-meta.json")
}

fn load_meta(mp: &Path) -> Option<ListfileMeta> {
    let content = std::fs::read_to_string(mp).ok()?;
    serde_json::from_str(&content).ok()
}

fn save_meta(mp: &Path, tag: &str, checked_at_secs: u64) {
    if let Some(parent) = mp.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let meta = ListfileMeta {
        tag: tag.to_owned(),
        checked_at_secs,
    };
    if let Ok(json) = serde_json::to_string(&meta) {
        let _ = std::fs::write(mp, json);
    }
}

/// Query the GitHub Releases API for the latest listfile release tag.
///
/// Returns `None` if the API is unreachable or returns an unexpected response.
/// This is a best-effort check — callers must handle `None` gracefully.
fn fetch_latest_tag() -> Option<String> {
    let client = reqwest::blocking::Client::new();
    let resp = client
        .get(GITHUB_RELEASES_API)
        .header("User-Agent", "scryer-asset-server/0.1")
        .send()
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let text = resp.text().ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    json.get("tag_name")?.as_str().map(|s| s.to_owned())
}

/// Download the community listfile, trying the primary URL first then the
/// fallback. The file is stored at [`cache_path`] inside `output_dir`.
pub fn download_listfile(output_dir: &Path) -> Result<PathBuf> {
    let dest = cache_path(output_dir);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let body = match reqwest::blocking::get(LISTFILE_URL_PRIMARY) {
        Ok(resp) if resp.status().is_success() => resp.text()?,
        _ => {
            tracing::warn!(
                "Primary listfile URL failed, trying fallback: {}",
                LISTFILE_URL_FALLBACK,
            );
            reqwest::blocking::get(LISTFILE_URL_FALLBACK)?.text()?
        }
    };

    std::fs::write(&dest, &body)?;
    tracing::info!("Downloaded listfile to {}", dest.display());
    Ok(dest)
}

/// Cache path for the binary sidecar (postcard-encoded).
pub fn bin_cache_path(output_dir: &Path) -> PathBuf {
    output_dir.join(".casc-meta").join("listfile.bin")
}

fn file_mtime(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).ok()?.modified().ok()
}

/// Try to load `Listfile` from the binary cache if it is at least as fresh as
/// the CSV. Returns `None` on any failure (missing, stale, corrupt, schema
/// change) so the caller can fall back to CSV parsing.
fn try_load_bin(bin_path: &Path, csv_path: &Path) -> Option<Listfile> {
    let bin_mtime = file_mtime(bin_path)?;
    let csv_mtime = file_mtime(csv_path)?;
    if bin_mtime < csv_mtime {
        tracing::debug!("listfile: binary cache is stale — will re-parse CSV");
        return None;
    }
    let bytes = std::fs::read(bin_path).ok()?;
    match postcard::from_bytes::<Listfile>(&bytes) {
        Ok(lf) => {
            tracing::info!(
                "listfile: loaded {} entries from binary cache",
                lf.len()
            );
            Some(lf)
        }
        Err(e) => {
            tracing::warn!("listfile: binary cache corrupt ({e}) — re-parsing CSV");
            None
        }
    }
}

/// Serialize `Listfile` to the binary sidecar. Errors are logged and swallowed
/// — a missing binary cache only costs one extra CSV parse on the next start.
fn save_bin(bin_path: &Path, lf: &Listfile) {
    match postcard::to_allocvec(lf) {
        Ok(bytes) => match std::fs::write(bin_path, &bytes) {
            Ok(()) => tracing::info!(
                "listfile: wrote binary cache ({} bytes) to {}",
                bytes.len(),
                bin_path.display()
            ),
            Err(e) => tracing::warn!("listfile: failed to write binary cache: {e}"),
        },
        Err(e) => tracing::warn!("listfile: failed to serialize binary cache: {e}"),
    }
}

/// Load from binary cache if fresh, otherwise parse the CSV and write the
/// binary cache for next time.
fn load_with_bin_cache(csv_path: &Path, bin_path: &Path) -> Result<Listfile> {
    if let Some(lf) = try_load_bin(bin_path, csv_path) {
        return Ok(lf);
    }
    let lf = Listfile::load(csv_path)?;
    save_bin(bin_path, &lf);
    Ok(lf)
}

/// Load a fresh, valid listfile — using the disk cache whenever possible.
///
/// Decision logic:
/// 1. Cache exists and was verified within 24 h → reuse it (no network).
/// 2. Otherwise query the GitHub Releases API for the latest tag.
///    - Same tag as cached → bump `checked_at`, reuse cache; no re-download.
///    - New tag (or no cache) → download fresh CSV, update metadata, parse.
/// 3. If the Releases API is unreachable:
///    - Cache present → warn and reuse; bump `checked_at` to avoid hammering.
///    - No cache at all → fall back to an unconditional download.
pub fn load_or_refresh(output_dir: &Path) -> Result<Listfile> {
    let csv = cache_path(output_dir);
    let bin = bin_cache_path(output_dir);
    let mp = meta_path(output_dir);

    let now_secs = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let meta = load_meta(&mp);

    // Fast path: cache exists and was checked within 24 h.
    if csv.exists() {
        if let Some(ref m) = meta {
            if now_secs.saturating_sub(m.checked_at_secs) < MAX_AGE_SECS {
                tracing::info!(
                    "listfile: cache fresh (tag={}, age={}s)",
                    m.tag,
                    now_secs.saturating_sub(m.checked_at_secs),
                );
                return load_with_bin_cache(&csv, &bin);
            }
        }
    }

    match fetch_latest_tag() {
        Some(tag) => {
            let tag_unchanged = meta.as_ref().is_some_and(|m| m.tag == tag);
            if tag_unchanged && csv.exists() {
                tracing::info!("listfile: tag unchanged ({}) — using cache", tag);
                save_meta(&mp, &tag, now_secs);
                return load_with_bin_cache(&csv, &bin);
            }
            tracing::info!("listfile: new release ({}) — downloading", tag);
            download_listfile(output_dir)?;
            save_meta(&mp, &tag, now_secs);
        }
        None => {
            if csv.exists() {
                tracing::warn!("listfile: GitHub API unavailable — reusing cached file");
                let tag = meta.as_ref().map(|m| m.tag.as_str()).unwrap_or("");
                save_meta(&mp, tag, now_secs);
                return load_with_bin_cache(&csv, &bin);
            }
            tracing::info!("listfile: no cache and GitHub API unavailable — downloading unconditionally");
            download_listfile(output_dir)?;
            save_meta(&mp, "", now_secs);
        }
    }

    load_with_bin_cache(&csv, &bin)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_path_construction() {
        let base = PathBuf::from("some_output");
        let path = cache_path(&base);
        assert_eq!(path, base.join(".casc-meta").join("listfile.csv"));
    }

    #[test]
    fn meta_path_construction() {
        let base = PathBuf::from("some_output");
        let path = meta_path(&base);
        assert_eq!(path, base.join(".casc-meta").join("listfile-meta.json"));
    }

    #[test]
    fn load_meta_missing_returns_none() {
        let path = Path::new("nonexistent_dir/listfile-meta.json");
        assert!(load_meta(path).is_none());
    }

    #[test]
    fn save_and_load_meta_roundtrip() {
        let dir = std::env::temp_dir().join(format!("casc-test-meta-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mp = meta_path(&dir);
        save_meta(&mp, "20260610", 1234567890);
        let loaded = load_meta(&mp).expect("meta should round-trip");
        assert_eq!(loaded.tag, "20260610");
        assert_eq!(loaded.checked_at_secs, 1234567890);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn bin_cache_path_construction() {
        let base = PathBuf::from("some_output");
        let path = bin_cache_path(&base);
        assert_eq!(path, base.join(".casc-meta").join("listfile.bin"));
    }

    #[test]
    fn load_with_bin_cache_writes_and_reads_sidecar() {
        let dir = std::env::temp_dir()
            .join(format!("casc-test-bincache-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let csv_path = dir.join("listfile.csv");
        let bin_path = dir.join("listfile.bin");
        let content = "53;Cameras/FlyBy.m2\n69;Creature/Bear/bear.m2\n";
        std::fs::write(&csv_path, content).unwrap();

        // First call: no binary cache → CSV parse → binary written.
        let lf1 = load_with_bin_cache(&csv_path, &bin_path).expect("first load");
        assert!(bin_path.exists(), "binary cache should have been written");
        assert_eq!(lf1.len(), 2);

        // Second call: binary cache exists and is fresh → deserialize from binary.
        let lf2 = load_with_bin_cache(&csv_path, &bin_path).expect("second load");
        assert_eq!(lf2.len(), lf1.len());
        assert_eq!(lf2.path(53), lf1.path(53));
        assert_eq!(lf2.path(69), lf1.path(69));

        // Stale binary: touch the CSV so it's newer than the binary.
        std::thread::sleep(std::time::Duration::from_millis(10));
        std::fs::write(&csv_path, content).unwrap(); // bumps mtime
        let lf3 = load_with_bin_cache(&csv_path, &bin_path).expect("stale binary load");
        assert_eq!(lf3.len(), 2, "should re-parse CSV and still find 2 entries");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn try_load_bin_falls_back_on_corrupt_data() {
        let dir = std::env::temp_dir()
            .join(format!("casc-test-corrupt-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let csv_path = dir.join("listfile.csv");
        let bin_path = dir.join("listfile.bin");
        std::fs::write(&csv_path, "53;Path.m2\n").unwrap();
        // Write corrupt bytes with a newer mtime than the CSV.
        std::thread::sleep(std::time::Duration::from_millis(10));
        std::fs::write(&bin_path, b"not valid postcard data").unwrap();

        let result = try_load_bin(&bin_path, &csv_path);
        assert!(result.is_none(), "corrupt binary should yield None");

        std::fs::remove_dir_all(&dir).ok();
    }
}
