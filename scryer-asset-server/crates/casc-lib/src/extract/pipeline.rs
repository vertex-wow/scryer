//! Core CASC extraction pipeline.
//!
//! Provides [`CascStorage`] - a facade that bootstraps all CASC components
//! (build info, build config, index, data store, encoding, root, listfile,
//! and key store) from a WoW install directory - and the extraction functions
//! [`extract_all`], [`extract_single_file`], and [`list_files`].

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::sync::atomic::{AtomicU64, Ordering};

use rayon::ThreadPoolBuilder;
use rayon::prelude::*;

use std::collections::HashSet;

use crate::blte::decoder::decode_blte_with_keys;
use crate::blte::encryption::TactKeyStore;
use crate::cache;
use crate::cdn::CdnClient;
use crate::config::build_config::{BuildConfig, config_path, parse_build_config};
use crate::config::build_info::{BuildInfo, list_products, parse_build_info};
use crate::config::cdn_config::parse_cdn_config;
use crate::encoding::parser::{EncodingEntry, EncodingFile};
use crate::error::{CascError, Result};
use crate::listfile::downloader::load_or_refresh;
use crate::listfile::parser::Listfile;
use crate::resolve::{PathResolver, build_name_hash_index};
use crate::root::flags::LocaleFlags;
use crate::root::parser::{RootEntry, RootFile, RootFormat};
use crate::tvfs::parser::TvfsManifest;
use crate::storage::data::{DATA_HEADER_SIZE, DataStore};
use crate::storage::index::{CascIndex, IndexEntry};

use super::metadata::{ExtractionStats, MetadataEntry, MetadataWriter};

// ---------------------------------------------------------------------------
// Configuration types
// ---------------------------------------------------------------------------

/// Configuration for opening CASC storage.
pub struct OpenConfig {
    /// Path to the WoW install directory (the folder containing `.build.info`).
    pub install_dir: PathBuf,
    /// Filter by product name (e.g. "wow", "wow_classic").
    pub product: Option<String>,
    /// Optional custom keyfile path.
    pub keyfile: Option<PathBuf>,
    /// Optional custom listfile path.
    pub listfile: Option<PathBuf>,
    /// Directory for listfile cache and other output.
    pub output_dir: Option<PathBuf>,
    /// When `Some`, enable CDN fallback for CDN-only stubs.
    /// The path is used as a local blob cache (content-addressed by EKey hex).
    /// Has no effect when `.build.info` has no CDN coordinates (Steam installs).
    pub cdn_cache_dir: Option<PathBuf>,
    /// URLs to fetch the community TACT key list from, tried in order.
    /// Defaults to the wowdev/TACTKeys primary URL when empty.
    pub tact_keys_urls: Vec<String>,
}

/// Extraction configuration.
pub struct ExtractionConfig {
    /// Directory where extracted files are written.
    pub output_dir: PathBuf,
    /// Raw locale bitmask used to filter root entries (e.g. `0x2` for enUS).
    pub locale: u32,
    /// Number of rayon worker threads for parallel extraction.
    pub threads: usize,
    /// When `true`, verify extracted file checksums against their CKey.
    pub verify: bool,
    /// When `true`, skip files marked with the `ENCRYPTED` content flag.
    pub skip_encrypted: bool,
    /// List of glob patterns or exact paths to filter files by listfile path.
    pub filters: Vec<String>,
    /// When `true`, disable writing metadata files (JSONL, CSV, summary).
    pub no_metadata: bool,
}

/// High-level storage info.
pub struct StorageInfo {
    /// Build name string from the build config (e.g. `"WOW-12345patch1.2.3"`).
    pub build_name: String,
    /// Product identifier from `.build.info` (e.g. `"wow"`, `"wow_classic"`).
    pub product: String,
    /// Client version string (e.g. `"12.0.1.66192"`).
    pub version: String,
    /// Build config key hash from `.build.info` — unique per game build.
    pub build_key: String,
    /// Number of entries in the encoding table.
    pub encoding_entries: usize,
    /// Total number of root file entries across all blocks.
    pub root_entries: usize,
    /// Detected root file format as a display string (`"Legacy"`, `"MfstV1"`, `"MfstV2"`).
    pub root_format: String,
    /// Number of entries in the CASC index.
    pub index_entries: usize,
    /// Number of FDID→path mappings in the resolver (TVFS-derived only; listfile is lazy).
    pub resolver_paths: usize,
    /// Number of virtual file entries in the TVFS manifest (0 for Classic).
    pub tvfs_paths: usize,
}

// ---------------------------------------------------------------------------
// Extraction store abstraction
// ---------------------------------------------------------------------------

/// Minimal trait surface required by [`extract_all`] and the private
/// `extract_one` helper.
///
/// [`CascStorage`] implements this for production use. In `#[cfg(test)]` a
/// `MockStore` in the test module implements it with pre-configured outcomes so
/// stats counting and error-string mapping can be verified without a WoW install.
pub trait ExtractionStore {
    /// Read decoded file bytes by content key (CKey).
    fn read_by_ckey(&self, ckey: &[u8; 16]) -> Result<Vec<u8>>;
    /// Read decoded file bytes by EKey (or EKey prefix ≥ 9 bytes).
    fn read_by_ekey(&self, ekey: &[u8]) -> Result<Vec<u8>>;
    /// Look up a display path for a FileDataID.
    fn path_for_fdid(&self, fdid: u32) -> Option<&str>;
    /// Look up a FileDataID by file path (case-insensitive).
    fn fdid_for_path(&self, path: &str) -> Option<u32>;
    /// Iterate all (FileDataID, RootEntry) pairs.
    fn root_iter_all(&self) -> impl Iterator<Item = (u32, &RootEntry)> + '_;
    /// Find encoding entry by CKey — used for archive-offset sort; may return `None`.
    fn encoding_find_ekey(&self, ckey: &[u8; 16]) -> Option<&EncodingEntry>;
    /// Find index entry by EKey prefix — used for archive-offset sort; may return `None`.
    fn index_find(&self, ekey: &[u8]) -> Option<&IndexEntry>;
    /// Build name from the build config (used for the metadata writer).
    fn build_name(&self) -> &str;
    /// Product identifier (used for the metadata writer).
    fn product(&self) -> &str;
}

// ---------------------------------------------------------------------------
// CDN stub detection
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Central CASC storage facade
// ---------------------------------------------------------------------------

/// Central CASC storage facade that bootstraps all components and provides
/// file read methods.
pub struct CascStorage {
    pub build_info: BuildInfo,
    pub build_config: BuildConfig,
    pub index: CascIndex,
    pub data: DataStore,
    pub encoding: EncodingFile,
    pub root: RootFile,
    pub resolver: PathResolver,
    pub keystore: TactKeyStore,
    /// Fallback index from `Data/ecache/` — `None` when that directory is absent.
    index_ecache: Option<CascIndex>,
    /// Fallback data store from `Data/ecache/` — `None` when that directory is absent.
    data_ecache: Option<DataStore>,
    /// CDN fallback client — `None` when CDN is disabled or CDN coordinates are absent.
    cdn_client: Option<CdnClient>,
    /// Resolved output directory used for the listfile cache.
    output_dir: PathBuf,
    /// Lazily loaded community listfile.
    ///
    /// Pre-warmed in a background thread after `open()` returns. On the first
    /// TVFS miss in `fdid_for_path`, the calling thread hoists the load by
    /// blocking on `get_or_init` — either joining the in-progress prewarm or
    /// triggering an immediate load if the prewarm hasn't started yet.
    listfile_cell: Arc<OnceLock<Option<Arc<Listfile>>>>,
}

impl CascStorage {
    /// Bootstrap all CASC components from an install directory.
    ///
    /// On the first run the components are parsed from raw CASC data and the
    /// result is written to a flat binary cache under `output_dir`. On subsequent
    /// starts the cache is loaded instead, skipping the expensive BLTE decode +
    /// parse steps (~200 ms → ~50 ms cold-start improvement).
    ///
    /// See [`OpenConfig`] for configuration options.
    pub fn open(config: &OpenConfig) -> Result<Self> {
        // 1. Read .build.info from install_dir (NOT Data/)
        let build_info_path = config.install_dir.join(".build.info");
        let build_info_content = std::fs::read_to_string(&build_info_path)?;
        let all_entries = parse_build_info(&build_info_content)?;

        // 2. Filter by product or take first active entry
        let build_info = select_build_info(&all_entries, config.product.as_deref())?;

        // 3. Read build config
        let data_dir = config.install_dir.join("Data");
        let config_rel = config_path(&build_info.build_key);
        let config_file = data_dir.join(&config_rel);
        let config_content = std::fs::read_to_string(&config_file)?;
        let build_config = parse_build_config(&config_content)?;

        // 4. Open DataStore from Data/data/ — always required for file extraction.
        let data_data_dir = data_dir.join("data");
        let data_store = DataStore::open(&data_data_dir)?;

        // 4b. Open ecache DataStore (Data/ecache/) — silently skip if absent.
        let ecache_dir = data_dir.join("ecache");
        let data_ecache = DataStore::open_if_exists(&ecache_dir)?;

        // 5. Set up keystore
        let mut keystore = TactKeyStore::new();
        if let Some(ref keyfile_path) = config.keyfile {
            let custom = TactKeyStore::load_keyfile(keyfile_path)?;
            keystore.merge(&custom);
        }

        // 6. Resolve output directory (used for disk caches: lookup tables, listfile).
        let output_dir = config
            .output_dir
            .clone()
            .unwrap_or_else(|| std::env::temp_dir().join("casc-extractor"));

        // 5b. Auto-download community key list (wowdev/TACTKeys) into the cache dir.
        //     Runs after output_dir is resolved so the cache ends up next to the listfile.
        //     Only runs when CDN is enabled — reuses the user's existing network consent.
        if config.cdn_cache_dir.is_some() {
            let url_refs: Vec<&str> = config.tact_keys_urls.iter().map(|s| s.as_str()).collect();
            keystore.load_community_keys(&output_dir, &build_info.build_key, &url_refs);
        }
        let cache_path = cache::cache_file_path(&output_dir);

        // 7. Try fast path: load pre-parsed tables from the disk cache.
        let (index, index_ecache, encoding, root, tvfs) =
            if let Some(cached) = cache::try_load(&cache_path, &build_info.build_key) {
                match &cached.index_ecache {
                    Some(idx) => tracing::info!("ecache (from cache): {} entries", idx.len()),
                    None => tracing::info!("ecache absent (from cache)"),
                }
                (
                    cached.index,
                    cached.index_ecache,
                    cached.encoding,
                    cached.root,
                    cached.tvfs,
                )
            } else {
                // 8. Slow path: parse everything from raw CASC data.

                // 8a. Load CascIndex from Data/data/
                let index = CascIndex::load(&data_data_dir)?;

                // 8b. Load ecache index (Data/ecache/) — silently skip if absent
                let index_ecache = CascIndex::load_if_exists(&ecache_dir)?;
                match &index_ecache {
                    Some(idx) => tracing::info!(
                        "ecache loaded: {} entries from {}",
                        idx.len(),
                        ecache_dir.display()
                    ),
                    None => tracing::info!("ecache absent: {} not found", ecache_dir.display()),
                }

                // 8c. Bootstrap encoding, root, TVFS
                let encoding = bootstrap_encoding(&build_config, &index, &data_store, &keystore)?;
                let root =
                    bootstrap_root(&build_config, &encoding, &index, &data_store, &keystore)?;
                let tvfs =
                    bootstrap_tvfs(&build_config, &encoding, &index, &data_store, &keystore);

                // 8d. Persist cache for next cold start (non-fatal on write error).
                cache::save(
                    &cache_path,
                    &build_info.build_key,
                    &index,
                    index_ecache.as_ref(),
                    &encoding,
                    &root,
                    tvfs.as_ref(),
                );

                (index, index_ecache, encoding, root, tvfs)
            };

        // 9. Bootstrap path resolver (TVFS + name-hash only; listfile is lazy).
        //    TVFS is consumed here; it was saved to cache before this point.
        let hash_to_fdid = build_name_hash_index(&root);
        let resolver = PathResolver::new(tvfs, hash_to_fdid, None);

        // 9b. Set up the lazy listfile cell.
        //
        // Custom path → load synchronously and pre-populate the cell.
        // Auto path   → spawn a prewarm thread; the first fdid_for_path miss
        //               will hoist (block on get_or_init) if the prewarm is
        //               still in flight, or trigger an immediate load if not.
        let listfile_cell: Arc<OnceLock<Option<Arc<Listfile>>>> = Arc::new(OnceLock::new());
        if let Some(ref custom_path) = config.listfile {
            match Listfile::load(custom_path) {
                Ok(lf) => { let _ = listfile_cell.set(Some(Arc::new(lf))); }
                Err(e) => {
                    tracing::warn!("custom listfile load failed {:?}: {}", custom_path, e);
                    let _ = listfile_cell.set(None);
                }
            }
        } else {
            let cell = Arc::clone(&listfile_cell);
            let out = output_dir.clone();
            std::thread::spawn(move || {
                cell.get_or_init(|| match load_or_refresh(&out) {
                    Ok(lf) => Some(Arc::new(lf)),
                    Err(e) => {
                        tracing::warn!("listfile prewarm failed: {}", e);
                        None
                    }
                });
            });
        }

        // 10. Set up CDN client (only when cdn_cache_dir is configured and build.info has CDN coords)
        let cdn_client = config.cdn_cache_dir.as_ref().and_then(|cache_dir| {
            let indices_dir = data_dir.join("indices");
            // Load the CDN config to get the current list of live archive hashes.
            // Entries in local Data/indices/ that point to archives no longer in the CDN
            // config are stale — the blob moved to a new archive. We skip those entries so
            // an EKey with both a stale and a current mapping resolves to the current one.
            let cdn_archives: Option<std::collections::HashSet<String>> =
                (!build_info.cdn_key.is_empty())
                    .then(|| {
                        let cfg_path = data_dir
                            .join("config")
                            .join(&build_info.cdn_key[..2])
                            .join(&build_info.cdn_key[2..4])
                            .join(&build_info.cdn_key);
                        std::fs::read_to_string(&cfg_path)
                            .ok()
                            .and_then(|s| parse_cdn_config(&s).ok())
                            .map(|c| c.archives.into_iter().collect())
                    })
                    .flatten();
            CdnClient::new(
                build_info.cdn_hosts.clone(),
                build_info.cdn_path.clone(),
                cache_dir.clone(),
                Some(indices_dir),
                cdn_archives,
                &build_info.build_key,
            )
        });

        Ok(Self {
            build_info,
            build_config,
            index,
            data: data_store,
            output_dir,
            listfile_cell,
            encoding,
            root,
            resolver,
            keystore,
            index_ecache,
            data_ecache,
            cdn_client,
        })
    }

    /// Read a file by its content key (CKey).
    ///
    /// Resolves CKey → EKey via the encoding table, then delegates to
    /// [`read_by_ekey`].
    pub fn read_by_ckey(&self, ckey: &[u8; 16]) -> Result<Vec<u8>> {
        let enc_entry = self
            .encoding
            .find_ekey(ckey)
            .ok_or_else(|| CascError::KeyNotFound {
                key_type: "CKey".into(),
                hash: hex::encode(ckey),
            })?;

        self.read_by_ekey(&enc_entry.ekeys[0])
    }

    /// Read a file by EKey (or EKey prefix ≥ 9 bytes).
    ///
    /// Tries the primary `Data/data/` index, then the `Data/ecache/` fallback,
    /// then the CDN client (when configured). CDN-only stubs are detected via
    /// [`CascError::InvalidMagic`] on the primary path and skipped gracefully.
    ///
    /// Used directly by the TVFS extraction path (which has a 9-byte EKey from
    /// the CFT table) and internally by [`read_by_ckey`].
    pub fn read_by_ekey(&self, ekey: &[u8]) -> Result<Vec<u8>> {
        // Try primary index (Data/data/). Content files: BLTE sits directly at the IDX
        // offset. CDN stubs: non-BLTE bytes → InvalidMagic → fall through to ecache.
        if let Some(idx_entry) = self.index.find(ekey) {
            let raw = self.data.read_raw(
                idx_entry.archive_number,
                idx_entry.archive_offset,
                idx_entry.size,
            )?;
            match decode_blte_with_keys(raw, Some(&self.keystore)) {
                Ok(data) => return Ok(data),
                Err(CascError::InvalidMagic { .. }) => {
                    tracing::debug!(
                        "cdn stub in primary for ekey {} — trying ecache",
                        hex::encode(&ekey[..4.min(ekey.len())])
                    );
                    // Fall through to ecache.
                }
                Err(e) => return Err(e),
            }
        }

        // Try ecache fallback (Data/ecache/). Ecache entries are stored with a 30-byte
        // data header at the IDX offset; use read_entry to skip it. Entries with
        // size == DATA_HEADER_SIZE have no BLTE payload (ecache stubs) — skip them.
        if let (Some(ecache_index), Some(ecache_data)) = (&self.index_ecache, &self.data_ecache) {
            if let Some(idx_entry) = ecache_index.find(ekey) {
                if idx_entry.size > DATA_HEADER_SIZE as u32 {
                    let payload = ecache_data.read_entry(
                        idx_entry.archive_number,
                        idx_entry.archive_offset,
                        idx_entry.size,
                    )?;
                    return decode_blte_with_keys(payload, Some(&self.keystore));
                }
                tracing::debug!(
                    "ecache stub (size={}) for ekey {} — reporting cdn-only",
                    idx_entry.size,
                    hex::encode(&ekey[..4.min(ekey.len())])
                );
            }
        }

        // Try CDN fallback if enabled, the user has consented, and we have a full 16-byte
        // EKey (TVFS supplies only 9-byte prefixes, which are not enough for CDN URL
        // construction).
        if let (Some(cdn), Some(full_key)) = (&self.cdn_client, ekey.get(..16)) {
            let key16: &[u8; 16] = full_key.try_into().unwrap();
            match cdn.fetch_ekey(key16) {
                Ok(raw) => return decode_blte_with_keys(&raw, Some(&self.keystore)),
                Err(e) => tracing::debug!(
                    "cdn fallback failed for ekey {}: {}",
                    hex::encode(&ekey[..4.min(ekey.len())]),
                    e
                ),
            }
        }

        // File absent from all stores.
        Err(CascError::KeyNotFound {
            key_type: "EKey".into(),
            hash: hex::encode(ekey),
        })
    }

    /// Read a file by FileDataID and locale.
    pub fn read_by_fdid(&self, fdid: u32, locale: LocaleFlags) -> Result<Vec<u8>> {
        let root_entry =
            self.root
                .find_by_fdid(fdid, locale)
                .ok_or_else(|| CascError::KeyNotFound {
                    key_type: "FDID".into(),
                    hash: format!("{} (locale {})", fdid, locale),
                })?;

        self.read_by_ckey(&root_entry.ckey)
    }

    /// Resolve a virtual path to a FileDataID using TVFS first, listfile on miss.
    ///
    /// If the TVFS name-hash index has no entry, blocks until the background
    /// prewarm completes (or triggers an immediate load if not yet started).
    fn lookup_fdid(&self, path: &str) -> Option<u32> {
        if let Some(fdid) = self.resolver.fdid_for_path(path) {
            return Some(fdid);
        }
        let out = &self.output_dir;
        self.listfile_cell
            .get_or_init(|| match load_or_refresh(out) {
                Ok(lf) => Some(Arc::new(lf)),
                Err(e) => {
                    tracing::warn!("listfile load failed: {}", e);
                    None
                }
            })
            .as_deref()?
            .fdid(path)
    }

    /// Return high-level statistics about the loaded storage.
    pub fn info(&self) -> StorageInfo {
        let root_format = match self.root.format() {
            RootFormat::Legacy => "Legacy",
            RootFormat::MfstV1 => "MfstV1",
            RootFormat::MfstV2 => "MfstV2",
        };

        StorageInfo {
            build_name: self.build_config.build_name.clone(),
            product: self.build_info.product.clone(),
            version: self.build_info.version.clone(),
            build_key: self.build_info.build_key.clone(),
            encoding_entries: self.encoding.len(),
            root_entries: self.root.len(),
            root_format: root_format.to_string(),
            index_entries: self.index.len(),
            resolver_paths: self.resolver.len(),
            tvfs_paths: self.resolver.tvfs_len(),
        }
    }
}

impl ExtractionStore for CascStorage {
    fn read_by_ckey(&self, ckey: &[u8; 16]) -> Result<Vec<u8>> {
        self.read_by_ckey(ckey)
    }
    fn read_by_ekey(&self, ekey: &[u8]) -> Result<Vec<u8>> {
        self.read_by_ekey(ekey)
    }
    fn path_for_fdid(&self, fdid: u32) -> Option<&str> {
        if let Some(p) = self.resolver.path_for_fdid(fdid) {
            return Some(p);
        }
        let out = &self.output_dir;
        self.listfile_cell
            .get_or_init(|| match load_or_refresh(out) {
                Ok(lf) => Some(Arc::new(lf)),
                Err(e) => {
                    tracing::warn!("listfile load failed: {}", e);
                    None
                }
            })
            .as_deref()?
            .path(fdid)
    }
    fn fdid_for_path(&self, path: &str) -> Option<u32> {
        self.lookup_fdid(path)
    }
    fn root_iter_all(&self) -> impl Iterator<Item = (u32, &RootEntry)> + '_ {
        self.root.iter_all()
    }
    fn encoding_find_ekey(&self, ckey: &[u8; 16]) -> Option<&EncodingEntry> {
        self.encoding.find_ekey(ckey)
    }
    fn index_find(&self, ekey: &[u8]) -> Option<&IndexEntry> {
        self.index.find(ekey)
    }
    fn build_name(&self) -> &str {
        &self.build_config.build_name
    }
    fn product(&self) -> &str {
        &self.build_info.product
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Select the appropriate BuildInfo entry by product filter or auto-select.
///
/// When no product is specified:
/// - If there is exactly one entry, auto-select it.
/// - If there are multiple entries, return an error listing available products.
///
/// When a product is specified but not found, the error lists available products.
fn select_build_info(entries: &[BuildInfo], product: Option<&str>) -> Result<BuildInfo> {
    if entries.is_empty() {
        return Err(CascError::InvalidFormat("no entries in .build.info".into()));
    }

    let selected = match product {
        Some(p) => entries
            .iter()
            .find(|e| e.active && e.product == p)
            .or_else(|| entries.iter().find(|e| e.product == p)),
        None => {
            if entries.len() == 1 {
                Some(&entries[0])
            } else {
                entries.iter().find(|e| e.active)
            }
        }
    };

    selected.cloned().ok_or_else(|| {
        let available: Vec<String> = list_products(entries)
            .iter()
            .map(|(name, _)| (*name).to_string())
            .collect();
        let available_str = available.join(", ");
        match product {
            Some(p) => CascError::InvalidFormat(format!(
                "product '{}' not found. Available products: {}",
                p, available_str
            )),
            None => CascError::InvalidFormat(format!(
                "multiple products found and no product specified. Available products: {}. \
                 Use -p <product> to select one.",
                available_str
            )),
        }
    })
}

/// Bootstrap the encoding file from the build config.
fn bootstrap_encoding(
    build_config: &BuildConfig,
    index: &CascIndex,
    data: &DataStore,
    keystore: &TactKeyStore,
) -> Result<EncodingFile> {
    let ekey_bytes = hex_to_bytes(&build_config.encoding_ekey)?;

    let idx_entry = index
        .find(&ekey_bytes)
        .ok_or_else(|| CascError::KeyNotFound {
            key_type: "encoding EKey".into(),
            hash: build_config.encoding_ekey.clone(),
        })?;

    let blte_data = data.read_entry(
        idx_entry.archive_number,
        idx_entry.archive_offset,
        idx_entry.size,
    )?;

    let raw_data = decode_blte_with_keys(blte_data, Some(keystore))?;
    EncodingFile::parse(&raw_data)
}

/// Bootstrap the root file via encoding lookup.
fn bootstrap_root(
    build_config: &BuildConfig,
    encoding: &EncodingFile,
    index: &CascIndex,
    data: &DataStore,
    keystore: &TactKeyStore,
) -> Result<RootFile> {
    let root_ckey = hex_to_16(&build_config.root_ckey)?;

    let enc_entry = encoding
        .find_ekey(&root_ckey)
        .ok_or_else(|| CascError::KeyNotFound {
            key_type: "root CKey".into(),
            hash: build_config.root_ckey.clone(),
        })?;

    let ekey = &enc_entry.ekeys[0];
    let idx_entry = index.find(ekey).ok_or_else(|| CascError::KeyNotFound {
        key_type: "root EKey".into(),
        hash: hex::encode(ekey),
    })?;

    let blte_data = data.read_entry(
        idx_entry.archive_number,
        idx_entry.archive_offset,
        idx_entry.size,
    )?;

    let raw_data = decode_blte_with_keys(blte_data, Some(keystore))?;
    RootFile::parse(&raw_data)
}

/// Try to bootstrap the TVFS manifest by loading all `vfs-*` manifest segments
/// from the build config and merging them.
///
/// WoW's build config lists multiple VFS segments (`vfs-root`, `vfs-1`,
/// `vfs-2`, …`vfs-N`), each a separate TVFS blob. The full virtual file catalog
/// is the union of all segments. Returns `None` when no `vfs-*` keys are
/// present (Classic / pre-8.2 installs). Individual segment failures are
/// logged as warnings and skipped so one bad segment doesn't abort the rest.
fn bootstrap_tvfs(
    build_config: &BuildConfig,
    encoding: &EncodingFile,
    index: &CascIndex,
    data: &DataStore,
    keystore: &TactKeyStore,
) -> Option<TvfsManifest> {
    // Collect all vfs-* CKeys from the build config, excluding the *-size entries.
    let mut segments: Vec<(String, [u8; 16])> = build_config
        .raw
        .iter()
        .filter(|(k, _)| k.starts_with("vfs-") && !k.ends_with("-size"))
        .filter_map(|(k, v)| {
            let ckey_hex = v.split_whitespace().next()?;
            let ckey = hex_to_16(ckey_hex)
                .map_err(|e| tracing::warn!("TVFS: invalid CKey for {}: {}", k, e))
                .ok()?;
            Some((k.clone(), ckey))
        })
        .collect();

    if segments.is_empty() {
        return None;
    }

    // Deduplicate: vfs-root and vfs-1 often share the same CKey.
    let mut seen: HashSet<[u8; 16]> = HashSet::new();
    segments.retain(|(_, ckey)| seen.insert(*ckey));

    let total = segments.len();
    let mut merged: Option<TvfsManifest> = None;
    let mut loaded = 0usize;

    for (key_name, ckey) in &segments {
        match load_tvfs_segment(&ckey, encoding, index, data, keystore) {
            Ok(m) => {
                loaded += 1;
                match merged {
                    None => merged = Some(m),
                    Some(ref mut acc) => acc.extend(m),
                }
            }
            Err(e) => tracing::warn!("TVFS: skipping {} ({}): {}", key_name, hex::encode(&ckey[..4]), e),
        }
    }

    match merged {
        Some(ref m) => tracing::info!(
            "TVFS: loaded {} virtual paths from {}/{} segment(s)",
            m.len(), loaded, total
        ),
        None => tracing::warn!("TVFS: all {} segment(s) failed to load", total),
    }
    merged
}

/// Load and parse a single TVFS manifest segment identified by its CKey.
fn load_tvfs_segment(
    ckey: &[u8; 16],
    encoding: &EncodingFile,
    index: &CascIndex,
    data: &DataStore,
    keystore: &TactKeyStore,
) -> Result<TvfsManifest> {
    let enc_entry = encoding
        .find_ekey(ckey)
        .ok_or_else(|| CascError::KeyNotFound {
            key_type: "TVFS CKey".into(),
            hash: hex::encode(ckey),
        })?;

    let ekey = &enc_entry.ekeys[0];
    let idx_entry = index.find(ekey).ok_or_else(|| CascError::KeyNotFound {
        key_type: "TVFS EKey".into(),
        hash: hex::encode(&ekey[..4]),
    })?;

    let blte_data = data.read_entry(
        idx_entry.archive_number,
        idx_entry.archive_offset,
        idx_entry.size,
    )?;
    let raw = decode_blte_with_keys(blte_data, Some(keystore))?;
    TvfsManifest::parse(&raw)
}

/// Decode a hex string to a `Vec<u8>`.
fn hex_to_bytes(hex_str: &str) -> Result<Vec<u8>> {
    hex::decode(hex_str)
        .map_err(|e| CascError::InvalidFormat(format!("invalid hex string '{}': {}", hex_str, e)))
}

/// Decode a hex string to a `[u8; 16]` array.
fn hex_to_16(hex_str: &str) -> Result<[u8; 16]> {
    let bytes = hex_to_bytes(hex_str)?;
    if bytes.len() < 16 {
        return Err(CascError::InvalidFormat(format!(
            "hex string too short for 16-byte key: '{}'",
            hex_str
        )));
    }
    let mut arr = [0u8; 16];
    arr.copy_from_slice(&bytes[..16]);
    Ok(arr)
}

/// Compute the output path for a FileDataID using the path resolver for naming.
///
/// If the resolver has a path for the FDID, the path is normalized
/// (backslashes replaced with forward slashes) and sanitized against
/// path traversal. Unknown files go to `output_dir/unknown/<fdid>.dat`.
pub fn output_path(output_dir: &Path, fdid: u32, resolver: &PathResolver) -> PathBuf {
    match resolver.path_for_fdid(fdid) {
        Some(path) => {
            let normalized = path.replace('\\', "/");
            // Prevent path traversal
            let safe = normalized.trim_start_matches('/').trim_start_matches("../");
            output_dir.join(safe)
        }
        None => output_dir.join("unknown").join(format!("{}.dat", fdid)),
    }
}

// ---------------------------------------------------------------------------
// Extraction functions
// ---------------------------------------------------------------------------

/// Extract all matching files from CASC storage into the output directory.
///
/// Files are filtered by locale and an optional glob pattern, deduplicated by
/// FDID, sorted by archive/offset for sequential I/O, then extracted in
/// parallel via a rayon thread pool.
pub fn extract_all<S: ExtractionStore + Sync>(
    storage: &S,
    config: &ExtractionConfig,
    progress_cb: Option<&(dyn Fn(u64, u64) + Sync)>,
) -> Result<ExtractionStats> {
    // 1. Collect entries: iterate root, filter by locale
    let locale_filter = LocaleFlags(config.locale);
    let mut entries: Vec<(u32, &RootEntry)> = storage
        .root_iter_all()
        .filter(|(_, entry)| entry.locale_flags.matches(locale_filter))
        .collect();

    // 2. Deduplicate by FDID (keep first matching entry per FDID)
    let mut seen = std::collections::HashSet::new();
    entries.retain(|(fdid, _)| seen.insert(*fdid));

    // 3. Apply glob filter if present
    if !config.filters.is_empty() {
        let mut exact_fdids = std::collections::HashSet::new();
        let mut glob_patterns = Vec::new();
        for f in &config.filters {
            if f.contains('*') {
                glob_patterns.push(f.clone());
            } else if let Some(fdid) = storage.fdid_for_path(f) {
                exact_fdids.insert(fdid);
            } else {
                tracing::debug!("filter: exact path not in listfile — {:?}", f);
            }
        }

        entries.retain(|(fdid, _)| {
            if exact_fdids.contains(fdid) {
                return true;
            }
            if !glob_patterns.is_empty() {
                if let Some(path) = storage.path_for_fdid(*fdid) {
                    return glob_patterns.iter().any(|pattern| glob_matches(pattern, path));
                }
            }
            false
        });

        if tracing::enabled!(tracing::Level::DEBUG) {
            tracing::debug!(
                "filter: {} entries matched ({} exact + {} globs)",
                entries.len(),
                exact_fdids.len(),
                glob_patterns.len()
            );
        }
    }

    let total = entries.len() as u64;

    // 4. Sort by archive+offset for sequential I/O
    let mut sortable: Vec<(u32, &RootEntry, u32, u64)> = entries
        .iter()
        .map(|(fdid, re)| {
            let (archive, offset) = storage
                .encoding_find_ekey(&re.ckey)
                .and_then(|ee| storage.index_find(&ee.ekeys[0]))
                .map(|ie| (ie.archive_number, ie.archive_offset))
                .unwrap_or((u32::MAX, u64::MAX));
            (*fdid, *re, archive, offset)
        })
        .collect();
    sortable.sort_by_key(|&(_, _, archive, offset)| (archive, offset));

    // 5. Create output directory
    std::fs::create_dir_all(&config.output_dir)?;

    // 6. Create metadata writer (unless disabled)
    let metadata = if !config.no_metadata {
        Some(MetadataWriter::new(
            &config.output_dir,
            storage.build_name(),
            storage.product(),
        )?)
    } else {
        None
    };

    // 7. Set up thread pool
    let pool = ThreadPoolBuilder::new()
        .num_threads(config.threads)
        .build()
        .map_err(|e| CascError::InvalidFormat(format!("failed to create thread pool: {}", e)))?;

    // 8. Parallel extraction — track stats regardless of metadata mode.
    let completed = AtomicU64::new(0);
    let stat_success = AtomicU64::new(0);
    let stat_errors = AtomicU64::new(0);
    let stat_unavailable = AtomicU64::new(0);
    let stat_bytes = AtomicU64::new(0);

    pool.install(|| {
        sortable.par_iter().for_each(|(fdid, root_entry, _, _)| {
            let result = extract_one(storage, config, *fdid, root_entry);

            match &result {
                Ok(bytes) => {
                    stat_success.fetch_add(1, Ordering::Relaxed);
                    stat_bytes.fetch_add(*bytes, Ordering::Relaxed);
                }
                Err(e) if e == "skipped:cached" => {
                    // already on disk — don't count in any bucket
                }
                Err(e) if e.starts_with("skipped:") => {
                    stat_unavailable.fetch_add(1, Ordering::Relaxed);
                    if tracing::enabled!(tracing::Level::DEBUG) {
                        let path = storage.path_for_fdid(*fdid).unwrap_or("unknown");
                        tracing::debug!(
                            "    unavailable: {} (fdid={}) — {}",
                            path,
                            fdid,
                            e.trim_start_matches("skipped:")
                        );
                    }
                }
                Err(e) => {
                    stat_errors.fetch_add(1, Ordering::Relaxed);
                    let path = storage.path_for_fdid(*fdid).unwrap_or("unknown");
                    tracing::warn!(
                        "    extract error: {} (fdid={}) — {}",
                        path,
                        fdid,
                        e.trim_start_matches("error:")
                    );
                }
            }

            if let Some(ref meta) = metadata {
                if !matches!(&result, Err(e) if e == "skipped:cached") {
                    let meta_path = storage
                        .path_for_fdid(*fdid)
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| format!("unknown/{}.dat", fdid));
                    let entry = make_metadata_entry(*fdid, root_entry, &result, &meta_path);
                    let _ = meta.record(&entry);
                }
            }

            let done = completed.fetch_add(1, Ordering::Relaxed) + 1;
            if let Some(cb) = progress_cb {
                cb(done, total);
            }
        });
    });

    let inline_stats = ExtractionStats {
        total,
        success: stat_success.load(Ordering::Relaxed),
        errors: stat_errors.load(Ordering::Relaxed),
        unavailable: stat_unavailable.load(Ordering::Relaxed),
        bytes_written: stat_bytes.load(Ordering::Relaxed),
    };

    // 9. Finish metadata
    if let Some(meta) = metadata {
        meta.finish()
    } else {
        Ok(inline_stats)
    }
}

/// List all files in the root that match the given locale and optional glob
/// filter. Returns `(FileDataID, path)` pairs sorted by FDID.
pub fn list_files(storage: &CascStorage, locale: u32, filter: Option<&str>) -> Vec<(u32, String)> {
    let locale_filter = LocaleFlags(locale);
    let mut seen = std::collections::HashSet::new();

    let mut result: Vec<(u32, String)> = storage
        .root
        .iter_all()
        .filter(|(_, entry)| entry.locale_flags.matches(locale_filter))
        .filter(|(fdid, _)| seen.insert(*fdid))
        .filter(|(fdid, _)| match filter {
            Some(pat) => match <CascStorage as ExtractionStore>::path_for_fdid(storage, *fdid) {
                Some(path) => glob_matches(pat, path),
                None => false,
            },
            None => true,
        })
        .map(|(fdid, _)| {
            let path = <CascStorage as ExtractionStore>::path_for_fdid(storage, fdid)
                .unwrap_or("unknown")
                .to_string();
            (fdid, path)
        })
        .collect();

    result.sort_by_key(|(fdid, _)| *fdid);
    result
}

/// Read a single file by FDID or path string, returning the raw bytes without
/// writing to disk. The `target` parameter is parsed as a numeric FDID first;
/// if that fails it is treated as a listfile path lookup.
pub fn read_file_bytes(storage: &CascStorage, target: &str, locale: u32) -> Result<Vec<u8>> {
    if let Ok(fdid) = target.parse::<u32>() {
        storage.read_by_fdid(fdid, LocaleFlags(locale))
    } else {
        let fdid = storage
            .lookup_fdid(target)
            .ok_or_else(|| CascError::KeyNotFound {
                key_type: "path".into(),
                hash: target.into(),
            })?;
        storage.read_by_fdid(fdid, LocaleFlags(locale))
    }
}

/// Extract a single file by FDID or path string to the given output location.
///
/// The `target` parameter is parsed as a numeric FDID first; if that fails it
/// is treated as a listfile path lookup (case-insensitive).
pub fn extract_single_file(
    storage: &CascStorage,
    target: &str,
    output: &Path,
    locale: u32,
) -> Result<u64> {
    let data = if let Ok(fdid) = target.parse::<u32>() {
        storage.read_by_fdid(fdid, LocaleFlags(locale))?
    } else {
        let fdid = storage
            .lookup_fdid(target)
            .ok_or_else(|| CascError::KeyNotFound {
                key_type: "path".into(),
                hash: target.into(),
            })?;
        storage.read_by_fdid(fdid, LocaleFlags(locale))?
    };

    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let size = data.len() as u64;
    std::fs::write(output, &data)?;
    Ok(size)
}

// ---------------------------------------------------------------------------
// Extraction helpers (private)
// ---------------------------------------------------------------------------

/// Extract a single file from storage, returning the bytes written or an
/// error string for metadata recording.
fn extract_one<S: ExtractionStore>(
    storage: &S,
    config: &ExtractionConfig,
    fdid: u32,
    root_entry: &RootEntry,
) -> std::result::Result<u64, String> {
    // Check if encrypted and skip if configured
    if root_entry.content_flags.0 & 0x8000000 != 0 && config.skip_encrypted {
        return Err("skipped:encrypted".into());
    }

    // Resolve output path early so we can skip the expensive BLTE decode for
    // files already on disk.
    let out_path = match storage.path_for_fdid(fdid) {
        Some(path) => {
            let normalized = path.replace('\\', "/");
            let safe = normalized.trim_start_matches('/').trim_start_matches("../");
            config.output_dir.join(safe)
        }
        None => config.output_dir.join("unknown").join(format!("{}.dat", fdid)),
    };

    if out_path.exists() && !config.verify {
        return Err("skipped:cached".into());
    }

    // Read the file data. If the archive slot exists but doesn't contain valid BLTE data, the
    // Battle.net client hasn't downloaded this file — it's a CDN-only stub. Report it as
    // skipped rather than an error so it doesn't pollute the error count.
    let data = match storage.read_by_ckey(&root_entry.ckey) {
        Ok(d) => d,
        Err(CascError::InvalidMagic { ref expected, .. }) if expected == "BLTE" => {
            return Err("skipped:cdn-only".into());
        }
        Err(CascError::KeyNotFound { ref key_type, .. }) if key_type == "EKey" => {
            return Err("skipped:cdn-only".into());
        }
        Err(e) => return Err(format!("error:{}", e)),
    };

    // Optional: verify MD5
    if config.verify {
        use md5::{Digest, Md5};
        let mut hasher = Md5::new();
        hasher.update(&data);
        let hash = hasher.finalize();
        if hash.as_slice() != root_entry.ckey {
            return Err(format!("error:checksum mismatch for FDID {}", fdid));
        }
    }

    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("error:mkdir: {}", e))?;
    }

    std::fs::write(&out_path, &data).map_err(|e| format!("error:write: {}", e))?;

    Ok(data.len() as u64)
}

/// Build a [`MetadataEntry`] from extraction results for metadata recording.
fn make_metadata_entry(
    fdid: u32,
    root_entry: &RootEntry,
    result: &std::result::Result<u64, String>,
    path: &str,
) -> MetadataEntry {
    let ckey_hex = hex::encode(root_entry.ckey);

    match result {
        Ok(size) => MetadataEntry {
            fdid,
            path: path.to_string(),
            size: *size,
            ckey: ckey_hex,
            locale_flags: root_entry.locale_flags.0,
            content_flags: root_entry.content_flags.0,
            status: "ok".into(),
        },
        Err(status) => MetadataEntry {
            fdid,
            path: path.to_string(),
            size: 0,
            ckey: ckey_hex,
            locale_flags: root_entry.locale_flags.0,
            content_flags: root_entry.content_flags.0,
            status: status.clone(),
        },
    }
}

/// Simple glob matching for WoW file paths.
///
/// Supported patterns:
/// - `dir/**` - matches all files recursively under `dir/`
/// - `*.ext` - matches any file ending with `.ext`
/// - `dir/*` - matches files directly inside `dir/` (not recursive)
/// - `prefix*` or `dir/prefix*` - matches files starting with prefix
/// - exact path - literal match
///
/// All matching is case-insensitive with forward-slash normalization.
fn glob_matches(pattern: &str, path: &str) -> bool {
    let pattern = pattern.to_lowercase().replace('\\', "/");
    let path = path.to_lowercase().replace('\\', "/");

    if pattern.ends_with("/**") {
        let prefix = &pattern[..pattern.len() - 3];
        return path.starts_with(&format!("{}/", prefix)) || path == *prefix;
    }
    if pattern.starts_with("*.") {
        let suffix = &pattern[1..]; // e.g. ".m2"
        return path.ends_with(suffix);
    }
    if pattern.ends_with("/*") {
        let prefix = &pattern[..pattern.len() - 2];
        return path.starts_with(&format!("{}/", prefix))
            && !path[prefix.len() + 1..].contains('/');
    }
    // Trailing wildcard: "some/prefix*" matches anything starting with "some/prefix"
    if pattern.ends_with('*') {
        let prefix = &pattern[..pattern.len() - 1];
        return path.starts_with(prefix);
    }
    // Exact match fallback
    path == pattern
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn resolver_from_listfile(content: &str) -> PathResolver {
        let lf = Listfile::parse(content);
        PathResolver::new(None, std::collections::HashMap::new(), Some(lf))
    }

    #[test]
    fn output_path_from_listfile_hit() {
        let resolver = resolver_from_listfile("53;Cameras/FlyBy.m2");
        let out = PathBuf::from("/output");
        let result = output_path(&out, 53, &resolver);
        assert!(result.to_string_lossy().contains("Cameras"));
        assert!(result.to_string_lossy().contains("FlyBy.m2"));
    }

    #[test]
    fn output_path_from_listfile_miss() {
        let resolver = resolver_from_listfile("");
        let out = PathBuf::from("/output");
        let result = output_path(&out, 99999, &resolver);
        assert!(result.to_string_lossy().contains("unknown"));
        assert!(result.to_string_lossy().contains("99999.dat"));
    }

    #[test]
    fn output_path_normalizes_backslashes() {
        let resolver = resolver_from_listfile("100;World\\Maps\\Test.adt");
        let out = PathBuf::from("/output");
        let result = output_path(&out, 100, &resolver);
        let s = result.to_string_lossy().replace('\\', "/");
        assert!(s.contains("World/Maps/Test.adt") || s.contains("world/maps/test.adt"));
    }

    #[test]
    fn output_path_prevents_traversal() {
        let resolver = resolver_from_listfile("200;../../../etc/passwd");
        let out = PathBuf::from("/output");
        let result = output_path(&out, 200, &resolver);
        assert!(result.starts_with("/output"));
    }

    #[test]
    fn extraction_config_defaults() {
        let config = ExtractionConfig {
            output_dir: PathBuf::from("/out"),
            locale: 0x2, // enUS
            threads: 4,
            verify: false,
            skip_encrypted: true,
            filters: vec![],
            no_metadata: false,
        };
        assert_eq!(config.locale, 0x2);
        assert!(config.skip_encrypted);
    }

    #[test]
    fn open_config_minimal() {
        let config = OpenConfig {
            install_dir: PathBuf::from("E:\\World of Warcraft"),
            product: Some("wow".into()),
            keyfile: None,
            listfile: None,
            output_dir: None,
            cdn_cache_dir: None,
            tact_keys_urls: vec![],
        };
        assert_eq!(config.product, Some("wow".into()));
    }

    #[test]
    fn storage_info_fields() {
        let info = StorageInfo {
            build_name: "WOW-12345".into(),
            product: "wow".into(),
            version: "12.0.1.66192".into(),
            build_key: "abcdef1234567890".into(),
            encoding_entries: 100000,
            root_entries: 500000,
            root_format: "MfstV2".into(),
            index_entries: 200000,
            resolver_paths: 400000,
            tvfs_paths: 0,
        };
        assert_eq!(info.build_name, "WOW-12345");
        assert_eq!(info.root_entries, 500000);
    }

    #[test]
    fn hex_to_bytes_16() {
        let hex_str = "0ff1247849a5cd6049624d3a105811f8";
        let bytes = hex::decode(hex_str).unwrap();
        assert_eq!(bytes.len(), 16);
        assert_eq!(bytes[0], 0x0f);
        assert_eq!(bytes[1], 0xf1);
    }

    #[test]
    fn hex_to_16_valid() {
        let arr = hex_to_16("0ff1247849a5cd6049624d3a105811f8").unwrap();
        assert_eq!(arr[0], 0x0f);
        assert_eq!(arr[15], 0xf8);
    }

    #[test]
    fn hex_to_16_too_short() {
        assert!(hex_to_16("aabb").is_err());
    }

    #[test]
    fn hex_to_16_invalid_hex() {
        assert!(hex_to_16("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz").is_err());
    }

    #[test]
    fn select_build_info_by_product() {
        let entries = vec![
            BuildInfo {
                branch: "eu".into(),
                active: true,
                build_key: "abc".into(),
                cdn_key: "def".into(),
                cdn_path: "".into(),
                cdn_hosts: vec![],
                version: "1.0".into(),
                product: "wow".into(),
                tags: "".into(),
                keyring: "".into(),
            },
            BuildInfo {
                branch: "eu".into(),
                active: true,
                build_key: "xyz".into(),
                cdn_key: "uvw".into(),
                cdn_path: "".into(),
                cdn_hosts: vec![],
                version: "2.0".into(),
                product: "wow_classic".into(),
                tags: "".into(),
                keyring: "".into(),
            },
        ];

        let selected = select_build_info(&entries, Some("wow_classic")).unwrap();
        assert_eq!(selected.product, "wow_classic");
        assert_eq!(selected.build_key, "xyz");
    }

    #[test]
    fn select_build_info_first_active() {
        let entries = vec![
            BuildInfo {
                branch: "eu".into(),
                active: false,
                build_key: "inactive".into(),
                cdn_key: "".into(),
                cdn_path: "".into(),
                cdn_hosts: vec![],
                version: "".into(),
                product: "wow".into(),
                tags: "".into(),
                keyring: "".into(),
            },
            BuildInfo {
                branch: "eu".into(),
                active: true,
                build_key: "active".into(),
                cdn_key: "".into(),
                cdn_path: "".into(),
                cdn_hosts: vec![],
                version: "1.0".into(),
                product: "wow".into(),
                tags: "".into(),
                keyring: "".into(),
            },
        ];

        let selected = select_build_info(&entries, None).unwrap();
        assert_eq!(selected.build_key, "active");
    }

    #[test]
    fn select_build_info_empty() {
        let result = select_build_info(&[], Some("wow"));
        assert!(result.is_err());
    }

    #[test]
    fn select_build_info_no_match() {
        let entries = vec![BuildInfo {
            branch: "eu".into(),
            active: true,
            build_key: "abc".into(),
            cdn_key: "".into(),
            cdn_path: "".into(),
            cdn_hosts: vec![],
            version: "".into(),
            product: "wow".into(),
            tags: "".into(),
            keyring: "".into(),
        }];

        let result = select_build_info(&entries, Some("nonexistent"));
        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("nonexistent"),
            "Error should mention the requested product"
        );
        assert!(
            err_msg.contains("wow"),
            "Error should list available products"
        );
    }

    #[test]
    fn select_build_info_auto_select_single() {
        let entries = vec![BuildInfo {
            branch: "eu".into(),
            active: true,
            build_key: "abc".into(),
            cdn_key: "".into(),
            cdn_path: "".into(),
            cdn_hosts: vec![],
            version: "1.0".into(),
            product: "wow_classic_era".into(),
            tags: "".into(),
            keyring: "".into(),
        }];

        // No product specified, single entry -> auto-select
        let selected = select_build_info(&entries, None).unwrap();
        assert_eq!(selected.product, "wow_classic_era");
    }

    #[test]
    fn select_build_info_error_lists_products() {
        let entries = vec![
            BuildInfo {
                branch: "eu".into(),
                active: true,
                build_key: "abc".into(),
                cdn_key: "".into(),
                cdn_path: "".into(),
                cdn_hosts: vec![],
                version: "1.0".into(),
                product: "wow".into(),
                tags: "".into(),
                keyring: "".into(),
            },
            BuildInfo {
                branch: "eu".into(),
                active: true,
                build_key: "xyz".into(),
                cdn_key: "".into(),
                cdn_path: "".into(),
                cdn_hosts: vec![],
                version: "2.0".into(),
                product: "wow_classic".into(),
                tags: "".into(),
                keyring: "".into(),
            },
        ];

        // Product not found -> error lists available products
        let result = select_build_info(&entries, Some("wow_classicera"));
        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("wow_classicera"),
            "Error should mention the requested product"
        );
        assert!(err_msg.contains("wow"), "Error should list 'wow'");
        assert!(
            err_msg.contains("wow_classic"),
            "Error should list 'wow_classic'"
        );
    }

    // Integration tests - only run with real WoW install
    fn wow_dir() -> PathBuf {
        std::env::var("WOW_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(r"E:\World of Warcraft"))
    }

    #[test]
    #[ignore]
    fn open_real_casc_storage() {
        let config = OpenConfig {
            install_dir: wow_dir(),
            product: Some("wow".into()),
            keyfile: None,
            listfile: None,
            output_dir: Some(std::env::temp_dir().join("casc_test_open")),
            cdn_cache_dir: None,
            tact_keys_urls: vec![],
        };
        let storage = CascStorage::open(&config).unwrap();
        let info = storage.info();
        assert!(info.encoding_entries > 0);
        assert!(info.root_entries > 100000);
        println!("Build: {}", info.build_name);
        println!("Encoding entries: {}", info.encoding_entries);
        println!("Root entries: {}", info.root_entries);
    }

    #[test]
    #[ignore]
    fn read_known_file_by_fdid() {
        let config = OpenConfig {
            install_dir: wow_dir(),
            product: Some("wow".into()),
            keyfile: None,
            listfile: None,
            output_dir: Some(std::env::temp_dir().join("casc_test_read")),
            cdn_cache_dir: None,
            tact_keys_urls: vec![],
        };
        let storage = CascStorage::open(&config).unwrap();
        // FDID 1 should exist in virtually every WoW build
        let data = storage.read_by_fdid(1, LocaleFlags::EN_US);
        // It might fail for various reasons, but shouldn't panic
        println!("FDID 1 result: {:?}", data.is_ok());
        if let Ok(bytes) = data {
            println!("FDID 1 size: {} bytes", bytes.len());
        }
    }

    // -----------------------------------------------------------------------
    // Glob matching tests
    // -----------------------------------------------------------------------

    #[test]
    fn glob_matches_double_star() {
        assert!(glob_matches(
            "world/maps/**",
            "world/maps/azeroth/azeroth_25_25.adt"
        ));
        assert!(glob_matches("world/maps/**", "world/maps/test.wdt"));
        assert!(!glob_matches("world/maps/**", "interface/icons/test.blp"));
    }

    #[test]
    fn glob_matches_extension() {
        assert!(glob_matches("*.m2", "creature/bear/bear.m2"));
        assert!(glob_matches("*.M2", "Creature/Bear/Bear.m2")); // case insensitive
        assert!(!glob_matches("*.m2", "creature/bear/bear.skin"));
    }

    #[test]
    fn glob_matches_single_star() {
        assert!(glob_matches(
            "interface/icons/*",
            "interface/icons/test.blp"
        ));
        assert!(!glob_matches(
            "interface/icons/*",
            "interface/icons/subdir/test.blp"
        ));
    }

    #[test]
    fn glob_matches_exact() {
        assert!(glob_matches("test.txt", "test.txt"));
        assert!(!glob_matches("test.txt", "other.txt"));
    }

    // -----------------------------------------------------------------------
    // Extraction helper tests
    // -----------------------------------------------------------------------

    #[test]
    fn extract_single_file_parses_fdid() {
        // Verify the parsing logic: numeric strings are treated as FDIDs
        let target = "12345";
        assert!(target.parse::<u32>().is_ok());

        let target_path = "world/maps/test.adt";
        assert!(target_path.parse::<u32>().is_err());
    }

    #[test]
    fn make_metadata_entry_ok() {
        let root_entry = RootEntry {
            ckey: [0xAA; 16],
            content_flags: crate::root::flags::ContentFlags(0),
            locale_flags: LocaleFlags(0x2),
            name_hash: None,
        };
        let result: std::result::Result<u64, String> = Ok(1024);
        let meta = make_metadata_entry(42, &root_entry, &result, "World/Test.adt");
        assert_eq!(meta.fdid, 42);
        assert_eq!(meta.path, "World/Test.adt");
        assert_eq!(meta.size, 1024);
        assert_eq!(meta.status, "ok");
        assert_eq!(meta.ckey, hex::encode([0xAA; 16]));
    }

    #[test]
    fn make_metadata_entry_error() {
        let root_entry = RootEntry {
            ckey: [0xBB; 16],
            content_flags: crate::root::flags::ContentFlags(0x8000000),
            locale_flags: LocaleFlags(0x2),
            name_hash: None,
        };
        let result: std::result::Result<u64, String> = Err("skipped:encrypted".into());
        let meta = make_metadata_entry(99, &root_entry, &result, "unknown/99.dat");
        assert_eq!(meta.fdid, 99);
        assert_eq!(meta.path, "unknown/99.dat");
        assert_eq!(meta.size, 0);
        assert_eq!(meta.status, "skipped:encrypted");
    }

    // -----------------------------------------------------------------------
    // Integration tests - require real WoW install
    // -----------------------------------------------------------------------

    #[test]
    #[ignore]
    fn extract_all_small_filter() {
        let open_config = OpenConfig {
            install_dir: wow_dir(),
            product: Some("wow".into()),
            keyfile: None,
            listfile: None,
            output_dir: Some(std::env::temp_dir().join("casc_extract_test")),
            cdn_cache_dir: None,
            tact_keys_urls: vec![],
        };
        let storage = CascStorage::open(&open_config).unwrap();

        let extract_config = ExtractionConfig {
            output_dir: std::env::temp_dir().join("casc_extract_test_out"),
            locale: 0x2, // enUS
            threads: 4,
            verify: false,
            skip_encrypted: true,
            filters: vec!["*.wdt".into()],
            no_metadata: false,
        };

        let stats = extract_all(&storage, &extract_config, None).unwrap();
        println!(
            "Extracted: {} success, {} errors, {} unavailable",
            stats.success, stats.errors, stats.unavailable
        );
        assert!(stats.total > 0);
    }
}

// ---------------------------------------------------------------------------
// Tier-2 mock tests — stats counting and error-string mapping
// ---------------------------------------------------------------------------

#[cfg(test)]
mod mock_tests {
    use super::*;
    use crate::root::flags::{ContentFlags, LocaleFlags};
    use std::collections::HashMap;

    /// Pre-configured outcome for a single CKey in [`MockStore`].
    enum MockOutcome {
        /// `read_by_ckey` returns `Ok(bytes)`.
        Success(Vec<u8>),
        /// `read_by_ckey` returns `InvalidMagic { expected: "BLTE" }` — maps to `skipped:cdn-only`.
        CdnOnly,
        /// `read_by_ckey` returns `KeyNotFound { key_type: "EKey" }` — maps to `skipped:cdn-only`.
        EKeyMissing,
        /// `read_by_ckey` returns a generic `InvalidFormat` error — maps to `error:...`.
        Error(String),
    }

    /// Minimal [`ExtractionStore`] backed by pre-configured outcomes.
    struct MockStore {
        entries: Vec<(u32, RootEntry)>,
        outcomes: HashMap<[u8; 16], MockOutcome>,
    }

    impl ExtractionStore for MockStore {
        fn read_by_ckey(&self, ckey: &[u8; 16]) -> crate::error::Result<Vec<u8>> {
            match self.outcomes.get(ckey) {
                Some(MockOutcome::Success(data)) => Ok(data.clone()),
                Some(MockOutcome::CdnOnly) => Err(CascError::InvalidMagic {
                    expected: "BLTE".into(),
                    found: "0000".into(),
                }),
                Some(MockOutcome::EKeyMissing) => Err(CascError::KeyNotFound {
                    key_type: "EKey".into(),
                    hash: "".into(),
                }),
                Some(MockOutcome::Error(msg)) => Err(CascError::InvalidFormat(msg.clone())),
                None => Err(CascError::KeyNotFound {
                    key_type: "CKey".into(),
                    hash: hex::encode(ckey),
                }),
            }
        }
        fn read_by_ekey(&self, ekey: &[u8]) -> crate::error::Result<Vec<u8>> {
            Err(CascError::KeyNotFound {
                key_type: "EKey".into(),
                hash: hex::encode(&ekey[..4.min(ekey.len())]),
            })
        }
        fn path_for_fdid(&self, _fdid: u32) -> Option<&str> {
            None
        }
        fn fdid_for_path(&self, _path: &str) -> Option<u32> {
            None
        }
        fn root_iter_all(&self) -> impl Iterator<Item = (u32, &RootEntry)> + '_ {
            self.entries.iter().map(|(fdid, e)| (*fdid, e))
        }
        fn encoding_find_ekey(&self, _ckey: &[u8; 16]) -> Option<&EncodingEntry> {
            None
        }
        fn index_find(&self, _ekey: &[u8]) -> Option<&IndexEntry> {
            None
        }
        fn build_name(&self) -> &str {
            "mock-build"
        }
        fn product(&self) -> &str {
            "mock"
        }
    }

    fn any_locale(ckey: [u8; 16]) -> RootEntry {
        RootEntry {
            ckey,
            content_flags: ContentFlags(0),
            locale_flags: LocaleFlags(0xFFFF_FFFF),
            name_hash: None,
        }
    }

    fn encrypted_entry(ckey: [u8; 16]) -> RootEntry {
        RootEntry {
            ckey,
            content_flags: ContentFlags(0x800_0000), // ENCRYPTED flag
            locale_flags: LocaleFlags(0xFFFF_FFFF),
            name_hash: None,
        }
    }

    fn base_config(output_dir: PathBuf) -> ExtractionConfig {
        ExtractionConfig {
            output_dir,
            locale: 0xFFFF_FFFF,
            threads: 1,
            verify: false,
            skip_encrypted: true,
            filters: vec![],
            no_metadata: true,
        }
    }

    fn temp_out(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("casc_mock_{}", name));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn stats_all_success() {
        let ck1 = [0x01u8; 16];
        let ck2 = [0x02u8; 16];
        let store = MockStore {
            entries: vec![(1, any_locale(ck1)), (2, any_locale(ck2))],
            outcomes: HashMap::from([
                (ck1, MockOutcome::Success(vec![0xAA; 10])),
                (ck2, MockOutcome::Success(vec![0xBB; 20])),
            ]),
        };
        let outdir = temp_out("all_success");
        let stats = extract_all(&store, &base_config(outdir.clone()), None).unwrap();
        assert_eq!(stats.total, 2);
        assert_eq!(stats.success, 2);
        assert_eq!(stats.errors, 0);
        assert_eq!(stats.unavailable, 0);
        assert_eq!(stats.bytes_written, 30);
        let _ = std::fs::remove_dir_all(&outdir);
    }

    #[test]
    fn stats_mixed_outcomes() {
        let ck_ok = [0x10u8; 16];
        let ck_err = [0x11u8; 16];
        let ck_cdn = [0x12u8; 16];
        let ck_enc = [0x13u8; 16];
        let store = MockStore {
            entries: vec![
                (1, any_locale(ck_ok)),
                (2, any_locale(ck_err)),
                (3, any_locale(ck_cdn)),
                (4, encrypted_entry(ck_enc)),
            ],
            outcomes: HashMap::from([
                (ck_ok, MockOutcome::Success(vec![0; 5])),
                (ck_err, MockOutcome::Error("bad BLTE chunk".into())),
                (ck_cdn, MockOutcome::CdnOnly),
                // ck_enc is skipped before read_by_ckey is ever called
            ]),
        };
        let outdir = temp_out("mixed");
        let stats = extract_all(&store, &base_config(outdir.clone()), None).unwrap();
        assert_eq!(stats.total, 4);
        assert_eq!(stats.success, 1);
        assert_eq!(stats.errors, 1);
        assert_eq!(stats.unavailable, 2); // cdn-only + encrypted = both unavailable locally
        assert_eq!(stats.bytes_written, 5);
        let _ = std::fs::remove_dir_all(&outdir);
    }

    #[test]
    fn cdn_only_maps_to_unavailable_not_error() {
        let ck = [0x20u8; 16];
        let store = MockStore {
            entries: vec![(10, any_locale(ck))],
            outcomes: HashMap::from([(ck, MockOutcome::CdnOnly)]),
        };
        let outdir = temp_out("cdn_only");
        let stats = extract_all(&store, &base_config(outdir.clone()), None).unwrap();
        assert_eq!(stats.unavailable, 1);
        assert_eq!(stats.errors, 0);
        assert_eq!(stats.success, 0);
        let _ = std::fs::remove_dir_all(&outdir);
    }

    #[test]
    fn encrypted_with_skip_maps_to_unavailable() {
        let ck = [0x30u8; 16];
        let store = MockStore {
            entries: vec![(20, encrypted_entry(ck))],
            outcomes: HashMap::new(), // read_by_ckey never called
        };
        let outdir = temp_out("encrypted_skip");
        let mut config = base_config(outdir.clone());
        config.skip_encrypted = true;
        let stats = extract_all(&store, &config, None).unwrap();
        assert_eq!(stats.unavailable, 1);
        assert_eq!(stats.success, 0);
        assert_eq!(stats.errors, 0);
        let _ = std::fs::remove_dir_all(&outdir);
    }

    #[test]
    fn general_error_maps_to_error_count() {
        let ck = [0x40u8; 16];
        let store = MockStore {
            entries: vec![(30, any_locale(ck))],
            outcomes: HashMap::from([(ck, MockOutcome::Error("corrupted data".into()))]),
        };
        let outdir = temp_out("gen_error");
        let stats = extract_all(&store, &base_config(outdir.clone()), None).unwrap();
        assert_eq!(stats.errors, 1);
        assert_eq!(stats.success, 0);
        assert_eq!(stats.unavailable, 0);
        let _ = std::fs::remove_dir_all(&outdir);
    }

    #[test]
    fn ekey_not_found_maps_to_unavailable() {
        // KeyNotFound { key_type: "EKey" } should map to skipped:cdn-only, not error.
        // This covers the case where neither Data/data/ nor Data/ecache/ has the EKey.
        let ck = [0x60u8; 16];
        let store = MockStore {
            entries: vec![(50, any_locale(ck))],
            outcomes: HashMap::from([(ck, MockOutcome::EKeyMissing)]),
        };
        let outdir = temp_out("ekey_missing");
        let stats = extract_all(&store, &base_config(outdir.clone()), None).unwrap();
        assert_eq!(stats.unavailable, 1);
        assert_eq!(stats.errors, 0);
        assert_eq!(stats.success, 0);
        let _ = std::fs::remove_dir_all(&outdir);
    }

    #[test]
    fn stats_empty_store() {
        let store = MockStore {
            entries: vec![],
            outcomes: HashMap::new(),
        };
        let outdir = temp_out("empty");
        let stats = extract_all(&store, &base_config(outdir.clone()), None).unwrap();
        assert_eq!(stats.total, 0);
        assert_eq!(stats.success, 0);
        assert_eq!(stats.errors, 0);
        assert_eq!(stats.unavailable, 0);
        assert_eq!(stats.bytes_written, 0);
        let _ = std::fs::remove_dir_all(&outdir);
    }

    #[test]
    fn progress_callback_receives_correct_counts() {
        let ck1 = [0x50u8; 16];
        let ck2 = [0x51u8; 16];
        let ck3 = [0x52u8; 16];
        let store = MockStore {
            entries: vec![
                (1, any_locale(ck1)),
                (2, any_locale(ck2)),
                (3, any_locale(ck3)),
            ],
            outcomes: HashMap::from([
                (ck1, MockOutcome::Success(vec![0; 1])),
                (ck2, MockOutcome::Success(vec![0; 1])),
                (ck3, MockOutcome::Success(vec![0; 1])),
            ]),
        };
        let outdir = temp_out("progress_cb");
        let calls = std::sync::atomic::AtomicU64::new(0);
        let cb = |done: u64, total: u64| {
            assert!(done <= total);
            assert_eq!(total, 3);
            calls.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        };
        let stats = extract_all(&store, &base_config(outdir.clone()), Some(&cb)).unwrap();
        assert_eq!(stats.total, 3);
        assert_eq!(calls.load(std::sync::atomic::Ordering::Relaxed), 3);
        let _ = std::fs::remove_dir_all(&outdir);
    }
}
