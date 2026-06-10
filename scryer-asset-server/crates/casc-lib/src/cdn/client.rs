use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::cdn::archive_index::CdnArchiveIndex;
use crate::error::{CascError, Result};

/// CDN client for fetching EKey-addressed blobs from Blizzard's CDN.
///
/// Only created when CDN coordinates are present in `.build.info` (Battle.net installs).
/// Steam installs omit these fields and will never produce a `CdnClient`.
///
/// Blobs are cached locally, content-addressed by EKey hex, so each blob is fetched
/// at most once across the lifetime of the cache directory.
pub struct CdnClient {
    hosts: Vec<String>,
    path: String,
    cache_dir: PathBuf,
    http: reqwest::blocking::Client,
    /// Combined lookup table built from `Data/indices/*.index` files.
    /// `None` when `indices_dir` was not provided.
    archive_index: Option<CdnArchiveIndex>,
    /// Hosts that returned a non-recoverable error (403, 5xx, network failure).
    /// Skipped on subsequent requests for the lifetime of this client.
    failed_hosts: Mutex<HashSet<String>>,
}

impl CdnClient {
    /// Build a CDN client from the CDN coordinates in `.build.info`.
    ///
    /// `indices_dir` should be `<install_dir>/Data/indices`. When `Some`, all
    /// `*.index` files there are parsed into an in-memory lookup table so that
    /// blobs absent as loose CDN files can be fetched via HTTPS Range request
    /// from the CDN archive they belong to.
    ///
    /// `cdn_archives` is the set of archive hashes from the CDN config (the current
    /// live archives). When provided, index entries pointing to archives outside this
    /// set are skipped — those archives no longer exist on the CDN and fetching their
    /// ranges would always 404. An EKey present in both a stale and a current archive
    /// resolves to the current one.
    ///
    /// Returns `None` when `hosts` is empty or `path` is empty — this is the normal
    /// case for Steam installs which do not include CDN coordinates.
    pub fn new(
        hosts: Vec<String>,
        path: String,
        cache_dir: PathBuf,
        indices_dir: Option<PathBuf>,
        cdn_archives: Option<HashSet<String>>,
    ) -> Option<Self> {
        if hosts.is_empty() || path.is_empty() {
            return None;
        }
        if let Err(e) = std::fs::create_dir_all(&cache_dir) {
            tracing::warn!("cdn: cache dir create failed — disabling CDN: {}", e);
            return None;
        }
        let http = match reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!("cdn: http client build failed — disabling CDN: {}", e);
                return None;
            }
        };

        let archive_index = indices_dir.as_ref().and_then(|dir| {
            match CdnArchiveIndex::load_all(dir, u64::MAX, cdn_archives.as_ref()) {
                Ok(idx) => Some(idx),
                Err(e) => {
                    tracing::warn!("cdn: archive index load failed — archive fallback disabled: {}", e);
                    None
                }
            }
        });

        // Probe each host before any file requests so unreachable or geo-blocked
        // hosts (e.g. level3.blizzard.com returning 403) are eliminated up front.
        // A 2xx or 404 response means the host is reachable; anything else marks
        // it failed immediately. This mirrors wow.export's host ranking step.
        let failed_hosts: HashSet<String> = hosts.iter().filter_map(|host| {
            let probe_url = format!("https://{}/{}/", host, path);
            match http.head(&probe_url).send() {
                Ok(resp) if resp.status().is_success() || resp.status().as_u16() == 404 => {
                    tracing::debug!("cdn: probe {} → reachable", host);
                    None
                }
                Ok(resp) => {
                    tracing::info!(
                        "cdn: probe {} → {} — host skipped",
                        host,
                        resp.status()
                    );
                    Some(host.clone())
                }
                Err(e) => {
                    tracing::info!("cdn: probe {} → error — host skipped: {}", host, e);
                    Some(host.clone())
                }
            }
        }).collect();

        let reachable = hosts.len() - failed_hosts.len();
        tracing::info!(
            "cdn: client ready ({}/{} host(s) reachable, path={}, archive_entries={})",
            reachable,
            hosts.len(),
            path,
            archive_index.as_ref().map(|i| i.len()).unwrap_or(0),
        );

        if reachable == 0 {
            tracing::warn!("cdn: no reachable hosts — disabling CDN");
            return None;
        }

        Some(Self {
            hosts,
            path,
            cache_dir,
            http,
            archive_index,
            failed_hosts: Mutex::new(failed_hosts),
        })
    }

    /// Fetch a blob by EKey from the CDN (or local cache).
    ///
    /// Strategy:
    /// 1. Check local disk cache.
    /// 2. Try each non-failed CDN host as a loose blob (`/data/ab/cd/<ekey_hex>`).
    /// 3. If any host returns 404, look the EKey up in the CDN archive index
    ///    and fetch via HTTPS Range request against the archive blob.
    ///
    /// Hosts that return a non-recoverable error (403, 5xx, network failure) are
    /// added to a per-client failed set and skipped for all subsequent requests.
    ///
    /// The returned bytes are raw BLTE — the caller is responsible for BLTE decoding.
    /// Successful fetches are cached atomically so subsequent calls are served from disk.
    pub fn fetch_ekey(&self, ekey: &[u8; 16]) -> Result<Vec<u8>> {
        let hex = hex::encode(ekey);
        let ab = &hex[0..2];
        let cd = &hex[2..4];

        let cache_path = self.cache_dir.join(ab).join(cd).join(&hex);
        if cache_path.exists() {
            tracing::debug!("cdn: cache hit for {}", &hex[..8]);
            return Ok(std::fs::read(&cache_path)?);
        }

        // Try loose blob on each non-failed host.
        let mut last_err: Option<CascError> = None;
        // A 404 means the content-addressed loose path doesn't exist — the blob lives
        // in a CDN archive. One 404 from any host is enough to trigger archive lookup.
        let mut got_any_404 = false;

        for host in &self.hosts {
            if self.is_failed(host) {
                continue;
            }
            let url = format!("https://{}/{}/data/{}/{}/{}", host, self.path, ab, cd, hex);
            tracing::debug!("cdn: fetch loose {}", url);
            match self.http.get(&url).send() {
                Ok(resp) if resp.status().is_success() => {
                    let bytes = resp.bytes()?;
                    self.cache_bytes(&cache_path, &bytes)?;
                    tracing::debug!("cdn: fetched loose {} ({} B)", &hex[..8], bytes.len());
                    return Ok(bytes.to_vec());
                }
                Ok(resp) if resp.status().as_u16() == 404 => {
                    got_any_404 = true;
                    tracing::debug!("cdn: loose 404 for {} on {}", &hex[..8], host);
                    last_err = Some(CascError::InvalidFormat(format!(
                        "cdn: HTTP 404 for {}",
                        url
                    )));
                }
                Ok(resp) => {
                    let status = resp.status();
                    tracing::warn!("cdn: HTTP {} for {} — marking host failed", status, host);
                    self.mark_failed(host);
                    last_err = Some(CascError::InvalidFormat(format!(
                        "cdn: HTTP {} for {}",
                        status,
                        url
                    )));
                }
                Err(e) => {
                    tracing::warn!("cdn: request failed for {} — marking host failed: {}", host, e);
                    self.mark_failed(host);
                    last_err = Some(CascError::Http(e));
                }
            }
        }

        // If any host confirmed the loose blob is absent, look the EKey up in the
        // CDN archive index and fetch via HTTPS Range request.
        if got_any_404 {
            if let Some(loc) = self.archive_index.as_ref().and_then(|idx| idx.find(ekey)) {
                let archive_hex = loc.archive_hash_hex.clone();
                let arch_ab = &archive_hex[0..2];
                let arch_cd = &archive_hex[2..4];
                let range_start = loc.offset as u64;
                let range_end = range_start + loc.size as u64 - 1;

                for host in &self.hosts {
                    if self.is_failed(host) {
                        continue;
                    }
                    let url = format!(
                        "https://{}/{}/data/{}/{}/{}",
                        host, self.path, arch_ab, arch_cd, archive_hex
                    );
                    tracing::debug!(
                        "cdn: fetch archive range {}..{} in {} for {}",
                        range_start,
                        range_end,
                        &archive_hex[..8],
                        &hex[..8]
                    );
                    match self
                        .http
                        .get(&url)
                        .header("Range", format!("bytes={}-{}", range_start, range_end))
                        .send()
                    {
                        Ok(resp) if resp.status().is_success() => {
                            let bytes = resp.bytes()?;
                            self.cache_bytes(&cache_path, &bytes)?;
                            tracing::debug!(
                                "cdn: fetched archive range {} ({} B)",
                                &hex[..8],
                                bytes.len()
                            );
                            return Ok(bytes.to_vec());
                        }
                        Ok(resp) => {
                            let status = resp.status();
                            if status.as_u16() != 404 {
                                tracing::warn!(
                                    "cdn: archive range HTTP {} for {} — marking host failed",
                                    status,
                                    host
                                );
                                self.mark_failed(host);
                            } else {
                                tracing::warn!(
                                    "cdn: archive range HTTP 404 for {} — stale index entry for {}",
                                    host,
                                    &hex[..8]
                                );
                            }
                            last_err = Some(CascError::InvalidFormat(format!(
                                "cdn: archive HTTP {} for {}",
                                status,
                                url
                            )));
                        }
                        Err(e) => {
                            tracing::warn!(
                                "cdn: archive range failed for {} — marking host failed: {}",
                                host,
                                e
                            );
                            self.mark_failed(host);
                            last_err = Some(CascError::Http(e));
                        }
                    }
                }
            } else {
                tracing::debug!(
                    "cdn: no archive index entry for {} — giving up",
                    &hex[..8]
                );
            }
        }

        Err(last_err.unwrap_or_else(|| CascError::KeyNotFound {
            key_type: "EKey (CDN)".into(),
            hash: hex,
        }))
    }

    fn is_failed(&self, host: &str) -> bool {
        self.failed_hosts
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .contains(host)
    }

    fn mark_failed(&self, host: &str) {
        self.failed_hosts
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(host.to_owned());
    }

    fn cache_bytes(&self, cache_path: &Path, bytes: &[u8]) -> Result<()> {
        if let Some(parent) = cache_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let tmp = cache_path.with_extension("partial");
        std::fs::write(&tmp, bytes)?;
        std::fs::rename(&tmp, cache_path)?;
        Ok(())
    }
}
