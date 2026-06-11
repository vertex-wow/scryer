//! Path resolution: maps virtual file paths to EKeys and FileDataIDs.
//!
//! [`PathResolver`] is the single authority for "what is the EKey for this
//! path?" and "what is the display path for this FDID?". It layers three
//! sources in priority order:
//!
//! 1. **TVFS manifest** — maps virtual paths directly to 9-byte EKeys.
//!    Zero network I/O; loaded from the local CASC archive in ~200 ms.
//! 2. **Name-hash reverse index** — built from the root file's Jenkins96
//!    hashes, used to translate a TVFS path string into its FDID.
//! 3. **Listfile supplement** — community CSV (`FileDataID;FilePath`).
//!    Provides FDID→path names for files not covered by TVFS, and acts as
//!    the sole source when TVFS is absent (Classic / pre-8.2 installs).

use std::collections::HashMap;

use crate::listfile::parser::Listfile;
use crate::root::parser::RootFile;
use crate::tvfs::parser::TvfsManifest;
use crate::util::hash::hashpath;

// ---------------------------------------------------------------------------
// Name-hash reverse index
// ---------------------------------------------------------------------------

/// Build a `Jenkins96_hash → FileDataID` reverse index from the root file.
///
/// Each root entry may carry a `name_hash: Option<u64>` — the Jenkins96 hash
/// of the original file path. When multiple FDIDs collide on the same hash
/// (rare duplicate locale entries), the first FDID encountered wins.
pub fn build_name_hash_index(root: &RootFile) -> HashMap<u64, u32> {
    let mut map: HashMap<u64, u32> = HashMap::new();
    for (fdid, entry) in root.iter_all() {
        if let Some(hash) = entry.name_hash {
            map.entry(hash).or_insert(fdid);
        }
    }
    map
}

// ---------------------------------------------------------------------------
// PathResolver
// ---------------------------------------------------------------------------

/// Layered path resolver that maps virtual paths ↔ FileDataIDs ↔ EKey9s.
///
/// Build with [`PathResolver::new`]; supply at least one of `tvfs` or
/// `listfile` — an empty resolver is valid but returns `None` for all
/// lookups.
pub struct PathResolver {
    tvfs: Option<TvfsManifest>,
    /// Jenkins96 hash → FDID (from root file's name_hash fields).
    hash_to_fdid: HashMap<u64, u32>,
    /// FDID → canonical display path (TVFS-derived, supplemented by listfile).
    fdid_to_path: HashMap<u32, String>,
    listfile: Option<Listfile>,
}

impl PathResolver {
    /// Construct a resolver from its components.
    ///
    /// `fdid_to_path` is built automatically:
    /// 1. Listfile entries seed the map first.
    /// 2. TVFS-derived paths (hashed → FDID) override listfile entries so
    ///    that TVFS paths take priority for display names.
    pub fn new(
        tvfs: Option<TvfsManifest>,
        hash_to_fdid: HashMap<u64, u32>,
        listfile: Option<Listfile>,
    ) -> Self {
        let fdid_to_path = build_fdid_to_path(tvfs.as_ref(), &hash_to_fdid, listfile.as_ref());
        Self {
            tvfs,
            hash_to_fdid,
            fdid_to_path,
            listfile,
        }
    }

    /// Look up the 9-byte EKey for a virtual path via the TVFS manifest.
    ///
    /// Returns `None` when TVFS is absent or the path is not in the manifest.
    pub fn ekey_for_path(&self, path: &str) -> Option<[u8; 9]> {
        self.tvfs.as_ref()?.get(path).map(|e| e.ekey9)
    }

    /// Look up the FDID for a virtual path.
    ///
    /// Tries the name-hash index first (fast), then falls back to the
    /// listfile's case-insensitive lookup (if present).
    pub fn fdid_for_path(&self, path: &str) -> Option<u32> {
        let hash = hashpath(path);
        if let Some(&fdid) = self.hash_to_fdid.get(&hash) {
            return Some(fdid);
        }
        self.listfile.as_ref()?.fdid(path)
    }

    /// Look up the display path for a FDID.
    ///
    /// Returns the TVFS-derived / listfile-seeded path from the internal map,
    /// or the listfile's own lookup as a fallback.
    pub fn path_for_fdid(&self, fdid: u32) -> Option<&str> {
        if let Some(p) = self.fdid_to_path.get(&fdid) {
            return Some(p.as_str());
        }
        self.listfile.as_ref()?.path(fdid)
    }

    /// Total number of FDID→path mappings known to this resolver.
    pub fn len(&self) -> usize {
        self.fdid_to_path.len()
    }

    /// Returns `true` when no paths are known from any source.
    pub fn is_empty(&self) -> bool {
        self.fdid_to_path.is_empty()
    }

    /// Returns `true` when a TVFS manifest is loaded.
    pub fn has_tvfs(&self) -> bool {
        self.tvfs.is_some()
    }

    /// Number of entries in the TVFS manifest (0 when absent).
    pub fn tvfs_len(&self) -> usize {
        self.tvfs.as_ref().map(|t| t.len()).unwrap_or(0)
    }
}

/// Build the FDID→path map from listfile (seeded first) then TVFS overrides.
fn build_fdid_to_path(
    tvfs: Option<&TvfsManifest>,
    hash_to_fdid: &HashMap<u64, u32>,
    listfile: Option<&Listfile>,
) -> HashMap<u32, String> {
    let tvfs_cap = tvfs.map(|t| t.len()).unwrap_or(0);
    let lf_cap = listfile.map(|lf| lf.len()).unwrap_or(0);
    let mut map: HashMap<u32, String> = HashMap::with_capacity(tvfs_cap.max(lf_cap));

    // Seed with listfile so TVFS entries can override with authoritative paths.
    if let Some(lf) = listfile {
        for (fdid, path) in lf.iter() {
            map.insert(fdid, path.to_owned());
        }
    }

    // TVFS-derived paths override listfile entries for any FDID we can resolve.
    if let Some(manifest) = tvfs {
        for (path, _entry) in manifest.iter() {
            let hash = hashpath(path);
            if let Some(&fdid) = hash_to_fdid.get(&hash) {
                map.insert(fdid, path.clone());
            }
        }
    }

    map
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_name_hash_index_empty_root() {
        let root = RootFile::empty_for_tests();
        let index = build_name_hash_index(&root);
        assert!(index.is_empty());
    }

    #[test]
    fn build_name_hash_index_populates_from_root() {
        use crate::root::flags::{ContentFlags, LocaleFlags};
        use crate::root::parser::RootEntry;

        let path = "interface/buttons/ui-checkbox.blp";
        let hash = hashpath(path);

        let entry = RootEntry {
            ckey: [0u8; 16],
            content_flags: ContentFlags::NONE,
            locale_flags: LocaleFlags::EN_US,
            name_hash: Some(hash),
        };
        let root = RootFile::with_entries_for_tests(vec![(136235, entry)]);
        let index = build_name_hash_index(&root);

        assert_eq!(index.get(&hash), Some(&136235_u32));
    }

    #[test]
    fn build_name_hash_index_skips_no_name_hash() {
        use crate::root::flags::{ContentFlags, LocaleFlags};
        use crate::root::parser::RootEntry;

        let entry = RootEntry {
            ckey: [0u8; 16],
            content_flags: ContentFlags::NONE,
            locale_flags: LocaleFlags::EN_US,
            name_hash: None,
        };
        let root = RootFile::with_entries_for_tests(vec![(99999, entry)]);
        let index = build_name_hash_index(&root);
        assert!(index.is_empty());
    }

    #[test]
    fn build_name_hash_index_first_wins_on_collision() {
        use crate::root::flags::{ContentFlags, LocaleFlags};
        use crate::root::parser::RootEntry;

        let hash = 0xDEAD_BEEF_u64;
        let make = |fdid: u32| {
            (
                fdid,
                RootEntry {
                    ckey: [0u8; 16],
                    content_flags: ContentFlags::NONE,
                    locale_flags: LocaleFlags::EN_US,
                    name_hash: Some(hash),
                },
            )
        };
        // Both FDIDs map to the same hash — only the first one seen should win.
        let root = RootFile::with_entries_for_tests(vec![make(100), make(200)]);
        let index = build_name_hash_index(&root);
        assert_eq!(index.len(), 1);
        let &winner = index.get(&hash).unwrap();
        assert!(winner == 100 || winner == 200, "winner must be one of the two FDIDs");
    }

    #[test]
    fn resolver_no_sources_is_empty() {
        let resolver = PathResolver::new(None, HashMap::new(), None);
        assert!(resolver.is_empty());
        assert_eq!(resolver.ekey_for_path("interface/buttons/test.blp"), None);
        assert_eq!(resolver.fdid_for_path("interface/buttons/test.blp"), None);
        assert_eq!(resolver.path_for_fdid(12345), None);
    }

    #[test]
    fn resolver_ekey_for_path_tvfs_hit() {
        let ekey9 = [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09];
        let manifest = TvfsManifest::single_entry_for_tests(
            "interface/buttons/ui-checkbox.blp",
            ekey9,
            1024,
        );

        let resolver = PathResolver::new(Some(manifest), HashMap::new(), None);
        assert_eq!(
            resolver.ekey_for_path("interface/buttons/ui-checkbox.blp"),
            Some(ekey9)
        );
        assert_eq!(resolver.ekey_for_path("interface/buttons/missing.blp"), None);
    }

    #[test]
    fn resolver_fdid_for_path_hash_lookup() {
        let path = "interface/buttons/ui-checkbox.blp";
        let hash = hashpath(path);
        let mut hash_to_fdid = HashMap::new();
        hash_to_fdid.insert(hash, 136235_u32);

        let resolver = PathResolver::new(None, hash_to_fdid, None);
        assert_eq!(resolver.fdid_for_path(path), Some(136235));
        assert_eq!(resolver.fdid_for_path("interface/missing.blp"), None);
    }

    #[test]
    fn resolver_path_for_fdid_from_listfile() {
        let lf = Listfile::parse("136235;Interface/Buttons/UI-CheckBox.blp\n");
        let resolver = PathResolver::new(None, HashMap::new(), Some(lf));
        assert_eq!(
            resolver.path_for_fdid(136235),
            Some("Interface/Buttons/UI-CheckBox.blp")
        );
        assert_eq!(resolver.path_for_fdid(99999), None);
    }

    #[test]
    fn resolver_tvfs_path_overrides_listfile() {
        // Listfile has a path; TVFS has the authoritative version for same FDID.
        let path = "interface/buttons/ui-checkbox.blp";
        let hash = hashpath(path);
        let mut hash_to_fdid = HashMap::new();
        hash_to_fdid.insert(hash, 136235_u32);

        let ekey9 = [0xAA; 9];
        let manifest = TvfsManifest::single_entry_for_tests(path, ekey9, 512);
        let lf = Listfile::parse("136235;Interface/Buttons/UI-CheckBox.blp\n");

        let resolver = PathResolver::new(Some(manifest), hash_to_fdid, Some(lf));
        // TVFS path (lowercase) should win over listfile path.
        assert_eq!(resolver.path_for_fdid(136235), Some(path));
        assert_eq!(resolver.ekey_for_path(path), Some(ekey9));
    }
}
