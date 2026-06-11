//! Disk-cached lookup tables for CASC storage components.
//!
//! Serializes the parsed lookup tables ([`CascIndex`], [`EncodingFile`],
//! [`RootFile`], [`TvfsManifest`]) to a flat binary file after the first parse.
//! On subsequent server starts, loading from this cache skips the expensive
//! BLTE decode + parse steps, reducing cold-start time from ~200 ms to ~50 ms.
//!
//! Cache invalidation is automatic: the build key from `.build.info` is stored
//! in the cache header and compared on each load. A game patch changes the build
//! key, causing a cache miss and triggering a fresh parse + overwrite.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::encoding::parser::{EncodingEntry, EncodingFile};
use crate::root::flags::{ContentFlags, LocaleFlags};
use crate::root::parser::{RootEntry, RootFile, RootFormat};
use crate::storage::index::{CascIndex, IndexEntry};
use crate::tvfs::parser::{TvfsEntry, TvfsManifest};

const MAGIC: &[u8; 8] = b"CASCACHE";
const FORMAT_VERSION: u32 = 1;

/// All pre-parsed lookup tables, ready for direct use in [`CascStorage`].
pub struct LookupCache {
    pub index: CascIndex,
    pub index_ecache: Option<CascIndex>,
    pub encoding: EncodingFile,
    pub root: RootFile,
    pub tvfs: Option<TvfsManifest>,
}

/// Derive the cache file path from the output directory.
pub fn cache_file_path(output_dir: &Path) -> PathBuf {
    output_dir.join(".casc-lookup-cache").join("lookup-cache.bin")
}

/// Try to load the lookup cache. Returns `None` when the cache is absent,
/// corrupt, or stale (build key mismatch). Errors are logged at debug level.
pub fn try_load(cache_path: &Path, build_key: &str) -> Option<LookupCache> {
    let data = std::fs::read(cache_path).ok()?;
    match deserialize(&data, build_key) {
        Ok(cache) => {
            tracing::info!(
                "lookup cache hit ({} bytes) — skipping CASC parse",
                data.len()
            );
            Some(cache)
        }
        Err(e) => {
            tracing::debug!("lookup cache miss ({}), falling through to parse", e);
            None
        }
    }
}

/// Save the lookup cache to disk. Write errors are non-fatal and logged as warnings.
pub fn save(
    cache_path: &Path,
    build_key: &str,
    index: &CascIndex,
    index_ecache: Option<&CascIndex>,
    encoding: &EncodingFile,
    root: &RootFile,
    tvfs: Option<&TvfsManifest>,
) {
    if let Some(parent) = cache_path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            tracing::warn!("lookup cache: failed to create cache dir: {}", e);
            return;
        }
    }

    let data = serialize(build_key, index, index_ecache, encoding, root, tvfs);

    // Atomic write: write to .tmp, then rename — avoids leaving a corrupt file on crash.
    let tmp = cache_path.with_extension("tmp");
    if let Err(e) = std::fs::write(&tmp, &data) {
        tracing::warn!("lookup cache: write failed: {}", e);
        return;
    }
    if let Err(e) = std::fs::rename(&tmp, cache_path) {
        tracing::warn!("lookup cache: rename failed: {}", e);
        let _ = std::fs::remove_file(&tmp);
        return;
    }

    tracing::info!("lookup cache saved ({} bytes)", data.len());
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

fn serialize(
    build_key: &str,
    index: &CascIndex,
    index_ecache: Option<&CascIndex>,
    encoding: &EncodingFile,
    root: &RootFile,
    tvfs: Option<&TvfsManifest>,
) -> Vec<u8> {
    // Pre-allocate a generous buffer to minimise reallocations.
    let mut buf = Vec::with_capacity(64 * 1024 * 1024);

    buf.extend_from_slice(MAGIC);
    write_u32(&mut buf, FORMAT_VERSION);
    write_str(&mut buf, build_key);

    // CascIndex (main)
    write_index(&mut buf, index);

    // CascIndex (ecache, optional)
    write_u8(&mut buf, if index_ecache.is_some() { 1 } else { 0 });
    if let Some(ec) = index_ecache {
        write_index(&mut buf, ec);
    }

    // EncodingFile
    write_encoding(&mut buf, encoding);

    // RootFile
    write_root(&mut buf, root);

    // TvfsManifest (optional)
    write_u8(&mut buf, if tvfs.is_some() { 1 } else { 0 });
    if let Some(t) = tvfs {
        write_tvfs(&mut buf, t);
    }

    buf
}

fn write_index(buf: &mut Vec<u8>, index: &CascIndex) {
    write_u32(buf, index.len() as u32);
    for (key, entry) in index.iter() {
        buf.extend_from_slice(key);
        write_u32(buf, entry.archive_number);
        write_u64(buf, entry.archive_offset);
        write_u32(buf, entry.size);
    }
}

fn write_encoding(buf: &mut Vec<u8>, encoding: &EncodingFile) {
    write_u32(buf, encoding.len() as u32);
    for (_ckey, entry) in encoding.iter() {
        buf.extend_from_slice(&entry.ckey);
        write_u64(buf, entry.file_size);
        write_u8(buf, entry.ekeys.len() as u8);
        for ekey in &entry.ekeys {
            buf.extend_from_slice(ekey);
        }
    }
}

fn write_root(buf: &mut Vec<u8>, root: &RootFile) {
    let fmt: u8 = match root.format() {
        RootFormat::Legacy => 0,
        RootFormat::MfstV1 => 1,
        RootFormat::MfstV2 => 2,
    };
    write_u8(buf, fmt);
    write_u32(buf, root.fdid_count() as u32);
    write_u32(buf, root.len() as u32);
    for (fdid, entries) in root.iter_fdid_groups() {
        write_u32(buf, fdid);
        write_u16(buf, entries.len() as u16);
        for entry in entries {
            buf.extend_from_slice(&entry.ckey);
            write_u32(buf, entry.content_flags.0);
            write_u32(buf, entry.locale_flags.0);
            match entry.name_hash {
                None => write_u8(buf, 0),
                Some(h) => {
                    write_u8(buf, 1);
                    write_u64(buf, h);
                }
            }
        }
    }
}

fn write_tvfs(buf: &mut Vec<u8>, tvfs: &TvfsManifest) {
    write_u32(buf, tvfs.len() as u32);
    for (path, entry) in tvfs.iter() {
        write_str(buf, path);
        buf.extend_from_slice(&entry.ekey9);
        write_u32(buf, entry.content_size);
    }
}

// ---------------------------------------------------------------------------
// Deserialization
// ---------------------------------------------------------------------------

fn deserialize(data: &[u8], expected_build_key: &str) -> Result<LookupCache, String> {
    let mut r = Reader::new(data);

    let magic = r.read_bytes(8).map_err(|e| format!("header: {}", e))?;
    if magic != MAGIC {
        return Err("wrong magic".into());
    }

    let version = r.read_u32().map_err(|e| format!("version: {}", e))?;
    if version != FORMAT_VERSION {
        return Err(format!("unsupported cache version {}", version));
    }

    let cached_key = r.read_str().map_err(|e| format!("build_key: {}", e))?;
    if cached_key != expected_build_key {
        let cached_prefix = &cached_key[..cached_key.len().min(8)];
        let current_prefix = &expected_build_key[..expected_build_key.len().min(8)];
        return Err(format!(
            "stale (cached={}, current={})",
            cached_prefix, current_prefix
        ));
    }

    let index = read_index(&mut r).map_err(|e| format!("index: {}", e))?;

    let has_ecache = r.read_u8().map_err(|e| format!("has_ecache: {}", e))?;
    let index_ecache = if has_ecache == 1 {
        Some(read_index(&mut r).map_err(|e| format!("ecache: {}", e))?)
    } else {
        None
    };

    let encoding = read_encoding(&mut r).map_err(|e| format!("encoding: {}", e))?;
    let root = read_root(&mut r).map_err(|e| format!("root: {}", e))?;

    let has_tvfs = r.read_u8().map_err(|e| format!("has_tvfs: {}", e))?;
    let tvfs = if has_tvfs == 1 {
        Some(read_tvfs(&mut r).map_err(|e| format!("tvfs: {}", e))?)
    } else {
        None
    };

    Ok(LookupCache { index, index_ecache, encoding, root, tvfs })
}

fn read_index(r: &mut Reader) -> Result<CascIndex, String> {
    let count = r.read_u32()? as usize;
    let mut entries = HashMap::with_capacity(count);
    for _ in 0..count {
        let key_bytes = r.read_bytes(9)?;
        let mut key = [0u8; 9];
        key.copy_from_slice(key_bytes);
        let archive_number = r.read_u32()?;
        let archive_offset = r.read_u64()?;
        let size = r.read_u32()?;
        entries.insert(key, IndexEntry { key, archive_number, archive_offset, size });
    }
    Ok(CascIndex::from_entries(entries))
}

fn read_encoding(r: &mut Reader) -> Result<EncodingFile, String> {
    let count = r.read_u32()? as usize;
    let mut entries = HashMap::with_capacity(count);
    for _ in 0..count {
        let ckey_bytes = r.read_bytes(16)?;
        let mut ckey = [0u8; 16];
        ckey.copy_from_slice(ckey_bytes);
        let file_size = r.read_u64()?;
        let ekey_count = r.read_u8()? as usize;
        let mut ekeys = Vec::with_capacity(ekey_count);
        for _ in 0..ekey_count {
            let eb = r.read_bytes(16)?;
            let mut ekey = [0u8; 16];
            ekey.copy_from_slice(eb);
            ekeys.push(ekey);
        }
        entries.insert(ckey, EncodingEntry { ckey, ekeys, file_size });
    }
    Ok(EncodingFile::from_raw(entries))
}

fn read_root(r: &mut Reader) -> Result<RootFile, String> {
    let fmt = match r.read_u8()? {
        0 => RootFormat::Legacy,
        1 => RootFormat::MfstV1,
        2 => RootFormat::MfstV2,
        b => return Err(format!("unknown root format byte {}", b)),
    };
    let fdid_count = r.read_u32()? as usize;
    let total_entries = r.read_u32()? as usize;
    let mut entries: HashMap<u32, Vec<RootEntry>> = HashMap::with_capacity(fdid_count);
    for _ in 0..fdid_count {
        let fdid = r.read_u32()?;
        let entry_count = r.read_u16()? as usize;
        let mut group = Vec::with_capacity(entry_count);
        for _ in 0..entry_count {
            let cb = r.read_bytes(16)?;
            let mut ckey = [0u8; 16];
            ckey.copy_from_slice(cb);
            let content_flags = ContentFlags(r.read_u32()?);
            let locale_flags = LocaleFlags(r.read_u32()?);
            let name_hash = if r.read_u8()? == 1 {
                Some(r.read_u64()?)
            } else {
                None
            };
            group.push(RootEntry { ckey, content_flags, locale_flags, name_hash });
        }
        entries.insert(fdid, group);
    }
    Ok(RootFile::from_raw(fmt, entries, total_entries))
}

fn read_tvfs(r: &mut Reader) -> Result<TvfsManifest, String> {
    let count = r.read_u32()? as usize;
    let mut entries = HashMap::with_capacity(count);
    for _ in 0..count {
        let path = r.read_str()?.to_string();
        let eb = r.read_bytes(9)?;
        let mut ekey9 = [0u8; 9];
        ekey9.copy_from_slice(eb);
        let content_size = r.read_u32()?;
        entries.insert(path, TvfsEntry { ekey9, content_size });
    }
    Ok(TvfsManifest::from_entries(entries))
}

// ---------------------------------------------------------------------------
// Low-level binary primitives
// ---------------------------------------------------------------------------

#[inline]
fn write_u8(buf: &mut Vec<u8>, v: u8) {
    buf.push(v);
}

#[inline]
fn write_u16(buf: &mut Vec<u8>, v: u16) {
    buf.extend_from_slice(&v.to_le_bytes());
}

#[inline]
fn write_u32(buf: &mut Vec<u8>, v: u32) {
    buf.extend_from_slice(&v.to_le_bytes());
}

#[inline]
fn write_u64(buf: &mut Vec<u8>, v: u64) {
    buf.extend_from_slice(&v.to_le_bytes());
}

fn write_str(buf: &mut Vec<u8>, s: &str) {
    let bytes = s.as_bytes();
    write_u16(buf, bytes.len() as u16);
    buf.extend_from_slice(bytes);
}

struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    fn read_bytes(&mut self, n: usize) -> Result<&'a [u8], String> {
        let end = self.pos + n;
        if end > self.data.len() {
            return Err(format!(
                "unexpected EOF at offset {} (need {} bytes, {} remaining)",
                self.pos,
                n,
                self.data.len().saturating_sub(self.pos)
            ));
        }
        let slice = &self.data[self.pos..end];
        self.pos = end;
        Ok(slice)
    }

    fn read_u8(&mut self) -> Result<u8, String> {
        Ok(self.read_bytes(1)?[0])
    }

    fn read_u16(&mut self) -> Result<u16, String> {
        let b = self.read_bytes(2)?;
        Ok(u16::from_le_bytes([b[0], b[1]]))
    }

    fn read_u32(&mut self) -> Result<u32, String> {
        let b = self.read_bytes(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn read_u64(&mut self) -> Result<u64, String> {
        let b = self.read_bytes(8)?;
        Ok(u64::from_le_bytes(
            b.try_into().expect("read_bytes(8) guarantees length 8"),
        ))
    }

    fn read_str(&mut self) -> Result<&'a str, String> {
        let len = self.read_u16()? as usize;
        let bytes = self.read_bytes(len)?;
        std::str::from_utf8(bytes).map_err(|e| format!("invalid UTF-8: {}", e))
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::root::flags::{ContentFlags, LocaleFlags};

    fn make_index(n: usize) -> CascIndex {
        let mut entries = HashMap::new();
        for i in 0..n {
            let mut key = [0u8; 9];
            key[0] = i as u8;
            key[1] = (i >> 8) as u8;
            entries.insert(
                key,
                IndexEntry {
                    key,
                    archive_number: i as u32,
                    archive_offset: (i as u64) * 1024,
                    size: 4096,
                },
            );
        }
        CascIndex::from_entries(entries)
    }

    fn make_encoding(n: usize) -> EncodingFile {
        let mut entries = HashMap::new();
        for i in 0..n {
            let mut ckey = [0u8; 16];
            ckey[0] = i as u8;
            let mut ekey = [0u8; 16];
            ekey[0] = (i + 100) as u8;
            entries.insert(
                ckey,
                EncodingEntry {
                    ckey,
                    ekeys: vec![ekey],
                    file_size: (i as u64) * 512,
                },
            );
        }
        EncodingFile::from_raw(entries)
    }

    fn make_root(n: usize) -> RootFile {
        let mut entries: HashMap<u32, Vec<RootEntry>> = HashMap::new();
        let mut total = 0;
        for i in 0..n {
            let mut ckey = [0u8; 16];
            ckey[0] = i as u8;
            let entry = RootEntry {
                ckey,
                content_flags: ContentFlags(0x8),
                locale_flags: LocaleFlags(0x2),
                name_hash: if i % 2 == 0 { Some(i as u64 * 0xDEAD) } else { None },
            };
            entries.entry(i as u32).or_default().push(entry);
            total += 1;
        }
        RootFile::from_raw(RootFormat::MfstV1, entries, total)
    }

    fn make_tvfs(n: usize) -> TvfsManifest {
        let mut entries = HashMap::new();
        for i in 0..n {
            let path = format!("interface/test/file{}.blp", i);
            let mut ekey9 = [0u8; 9];
            ekey9[0] = i as u8;
            entries.insert(path, TvfsEntry { ekey9, content_size: i as u32 * 256 });
        }
        TvfsManifest::from_entries(entries)
    }

    #[test]
    fn round_trip_all_components() {
        let index = make_index(10);
        let ecache = make_index(5);
        let encoding = make_encoding(8);
        let root = make_root(12);
        let tvfs = make_tvfs(6);
        let build_key = "abcdef1234567890abcdef1234567890";

        let bytes = serialize(
            build_key,
            &index,
            Some(&ecache),
            &encoding,
            &root,
            Some(&tvfs),
        );

        let cache = deserialize(&bytes, build_key).expect("round-trip should succeed");

        assert_eq!(cache.index.len(), 10);
        assert_eq!(cache.index_ecache.as_ref().unwrap().len(), 5);
        assert_eq!(cache.encoding.len(), 8);
        assert_eq!(cache.root.len(), 12);
        assert_eq!(cache.tvfs.as_ref().unwrap().len(), 6);
    }

    #[test]
    fn round_trip_no_ecache_no_tvfs() {
        let index = make_index(3);
        let encoding = make_encoding(3);
        let root = make_root(3);
        let build_key = "00000000000000000000000000000000";

        let bytes = serialize(build_key, &index, None, &encoding, &root, None);
        let cache = deserialize(&bytes, build_key).expect("round-trip should succeed");

        assert!(cache.index_ecache.is_none());
        assert!(cache.tvfs.is_none());
    }

    #[test]
    fn stale_build_key_returns_miss() {
        let index = make_index(1);
        let encoding = make_encoding(1);
        let root = make_root(1);
        let bytes = serialize("key_A", &index, None, &encoding, &root, None);

        assert!(deserialize(&bytes, "key_B").is_err());
    }

    #[test]
    fn wrong_magic_returns_miss() {
        let mut data = vec![0u8; 64];
        data[0..4].copy_from_slice(b"NOPE");
        assert!(deserialize(&data, "any").is_err());
    }

    #[test]
    fn truncated_data_returns_miss() {
        let index = make_index(2);
        let encoding = make_encoding(2);
        let root = make_root(2);
        let bytes = serialize("key", &index, None, &encoding, &root, None);
        let half = &bytes[..bytes.len() / 2];
        assert!(deserialize(half, "key").is_err());
    }

    #[test]
    fn index_entries_survive_round_trip() {
        let mut raw_entries = HashMap::new();
        let key = [0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x11, 0x22, 0x33];
        raw_entries.insert(
            key,
            IndexEntry { key, archive_number: 7, archive_offset: 0xDEAD_BEEF, size: 1234 },
        );
        let index = CascIndex::from_entries(raw_entries);
        let encoding = make_encoding(0);
        let root = make_root(0);

        let bytes = serialize("k", &index, None, &encoding, &root, None);
        let cache = deserialize(&bytes, "k").unwrap();

        let entry = cache.index.find(&key).expect("key must survive round-trip");
        assert_eq!(entry.archive_number, 7);
        assert_eq!(entry.archive_offset, 0xDEAD_BEEF);
        assert_eq!(entry.size, 1234);
    }

    #[test]
    fn encoding_entry_file_size_survives_round_trip() {
        let mut ckey = [0u8; 16];
        ckey[0] = 0x42;
        let mut ekey = [0u8; 16];
        ekey[0] = 0x99;
        let mut raw = HashMap::new();
        raw.insert(
            ckey,
            EncodingEntry { ckey, ekeys: vec![ekey], file_size: 0xFF_FFFF_FFFF },
        );
        let encoding = EncodingFile::from_raw(raw);
        let index = make_index(0);
        let root = make_root(0);

        let bytes = serialize("k", &index, None, &encoding, &root, None);
        let cache = deserialize(&bytes, "k").unwrap();

        let entry = cache.encoding.find_ekey(&ckey).expect("ckey must survive");
        assert_eq!(entry.file_size, 0xFF_FFFF_FFFF);
        assert_eq!(entry.ekeys[0], ekey);
    }

    #[test]
    fn root_name_hash_survives_round_trip() {
        let mut ckey = [0u8; 16];
        ckey[0] = 0x01;
        let entry = RootEntry {
            ckey,
            content_flags: ContentFlags(0),
            locale_flags: LocaleFlags(0x2),
            name_hash: Some(0xDEAD_BEEF_1234_5678),
        };
        let mut entries = HashMap::new();
        entries.insert(99u32, vec![entry]);
        let root = RootFile::from_raw(RootFormat::MfstV2, entries, 1);
        let index = make_index(0);
        let encoding = make_encoding(0);

        let bytes = serialize("k", &index, None, &encoding, &root, None);
        let cache = deserialize(&bytes, "k").unwrap();

        use crate::root::flags::LocaleFlags as LF;
        let e = cache.root.find_by_fdid(99, LF::EN_US).expect("fdid must survive");
        assert_eq!(e.name_hash, Some(0xDEAD_BEEF_1234_5678));
        assert_eq!(cache.root.format(), RootFormat::MfstV2);
    }
}
