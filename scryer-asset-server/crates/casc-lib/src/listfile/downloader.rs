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
pub fn load_or_refresh(output_dir: &Path) -> Result<super::parser::Listfile> {
    let csv = cache_path(output_dir);
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
                return super::parser::Listfile::load(&csv);
            }
        }
    }

    match fetch_latest_tag() {
        Some(tag) => {
            let tag_unchanged = meta.as_ref().is_some_and(|m| m.tag == tag);
            if tag_unchanged && csv.exists() {
                tracing::info!("listfile: tag unchanged ({}) — using cache", tag);
                save_meta(&mp, &tag, now_secs);
                return super::parser::Listfile::load(&csv);
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
                return super::parser::Listfile::load(&csv);
            }
            tracing::info!("listfile: no cache and GitHub API unavailable — downloading unconditionally");
            download_listfile(output_dir)?;
            save_meta(&mp, "", now_secs);
        }
    }

    super::parser::Listfile::load(&csv)
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
}
