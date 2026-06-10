//! Parser for CDN archive index files (`Data/indices/*.index`).
//!
//! Each `.index` file maps EKeys to their location (offset + size) inside the
//! corresponding CDN archive. The archive hash is the filename (without `.index`).
//!
//! Format (confirmed empirically):
//! - N blocks × 4096 bytes, each containing up to 170 entries zero-padded
//!   Entry = EKey[16] + size[4 BE u32] + offset[4 BE u32] = 24 bytes
//! - TOC section: N × 24 bytes (last_key[16] + block_hash[8] per block)
//! - Footer: 28 bytes
//!   toc_hash[8] + params[8] + num_entries[4 LE u32] + data_hash[8]
//!   params: version[1] + unk[2] + block_size_kb[1] + f1[1] + f2[1] + key_size[1] + checksum_size[1]

use std::collections::HashMap;
use std::path::Path;

use crate::error::Result;

const FOOTER_SIZE: usize = 28;

/// Location of a blob inside a CDN archive.
#[derive(Debug, Clone)]
pub struct CdnArchiveEntry {
    /// Hex string of the archive EKey (i.e. the `.index` filename without extension).
    pub archive_hash_hex: String,
    /// Size of the blob in the archive (big-endian u32 on disk).
    pub size: u32,
    /// Byte offset of the blob in the archive (big-endian u32 on disk).
    pub offset: u32,
}

/// In-memory lookup table built from all `Data/indices/*.index` files.
///
/// Keys are the full 16-byte EKey from each archive index entry (NOT the 9-byte
/// prefix used by the local CASC index). The CDN archive index stores full EKeys;
/// truncating to 9 bytes causes collisions that map lookups to the wrong archive.
pub struct CdnArchiveIndex {
    entries: HashMap<[u8; 16], CdnArchiveEntry>,
}

impl CdnArchiveIndex {
    /// Load all `*.index` files from `indices_dir`, building a combined lookup table.
    ///
    /// Files larger than `max_file_bytes` are skipped — large archives contain bulk
    /// game assets (textures, models) unlikely to include the small interface files
    /// Scryer needs. Set to `usize::MAX` to load everything.
    pub fn load_all(indices_dir: &Path, max_file_bytes: u64) -> Result<Self> {
        let mut entries: HashMap<[u8; 16], CdnArchiveEntry> = HashMap::new();

        let read_dir = match std::fs::read_dir(indices_dir) {
            Ok(d) => d,
            Err(_) => {
                tracing::debug!("cdn archive index: {} not found — skipping", indices_dir.display());
                return Ok(Self { entries });
            }
        };

        let mut loaded = 0usize;
        let mut skipped = 0usize;

        for entry in read_dir.flatten() {
            let path = entry.path();
            let fname = match path.file_name().and_then(|f| f.to_str()) {
                Some(f) => f.to_owned(),
                None => continue,
            };
            let archive_hash_hex = match fname.strip_suffix(".index") {
                Some(h) if h.len() == 32 => h.to_owned(),
                _ => continue,
            };

            // Skip files that are too large.
            let file_size = match entry.metadata().map(|m| m.len()) {
                Ok(s) => s,
                Err(_) => continue,
            };
            if file_size > max_file_bytes {
                skipped += 1;
                continue;
            }

            let data = match std::fs::read(&path) {
                Ok(d) => d,
                Err(e) => {
                    tracing::debug!("cdn archive index: failed to read {}: {}", path.display(), e);
                    continue;
                }
            };

            match parse_archive_index(&data, &archive_hash_hex) {
                Ok(parsed_entries) => {
                    for (ekey16, size, offset) in parsed_entries {
                        entries.entry(ekey16).or_insert(CdnArchiveEntry {
                            archive_hash_hex: archive_hash_hex.clone(),
                            size,
                            offset,
                        });
                    }
                    loaded += 1;
                }
                Err(e) => {
                    tracing::debug!("cdn archive index: parse error for {}: {}", fname, e);
                }
            }
        }

        tracing::info!(
            "cdn archive index: loaded {} index files ({} skipped, {} entries)",
            loaded,
            skipped,
            entries.len()
        );

        Ok(Self { entries })
    }

    /// Look up a CDN archive location by EKey.
    pub fn find(&self, ekey: &[u8; 16]) -> Option<&CdnArchiveEntry> {
        self.entries.get(ekey)
    }

    /// Total number of indexed entries.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether the index is empty.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// Parse one CDN archive `.index` file. Returns `(ekey16, size, offset)` tuples.
fn parse_archive_index(data: &[u8], _archive_hash: &str) -> Result<Vec<([u8; 16], u32, u32)>> {
    use crate::error::CascError;

    if data.len() < FOOTER_SIZE {
        return Err(CascError::InvalidFormat("cdn index too short".into()));
    }

    let footer = &data[data.len() - FOOTER_SIZE..];
    // footer[8..16] = params: version(1) + unk(2) + block_size_kb(1) + f1(1) + f2(1) + key_size(1) + checksum_size(1)
    let block_size_kb = footer[11] as usize;
    let key_size = footer[14] as usize;
    let checksum_size = footer[15] as usize;
    let num_entries = u32::from_le_bytes([footer[16], footer[17], footer[18], footer[19]]) as usize;

    if key_size != 16 || block_size_kb == 0 || checksum_size == 0 {
        return Err(CascError::InvalidFormat(format!(
            "cdn index unexpected params: key_size={} block_size_kb={} checksum_size={}",
            key_size, block_size_kb, checksum_size
        )));
    }

    let block_size = block_size_kb * 1024;
    let entry_size = key_size + 4 + 4; // key + size(4) + offset(4)
    let entries_per_block = block_size / entry_size;
    let num_blocks = (num_entries + entries_per_block - 1) / entries_per_block;

    let data_size = num_blocks * block_size;
    if data_size > data.len() {
        return Err(CascError::InvalidFormat(format!(
            "cdn index data size {} exceeds file size {}",
            data_size,
            data.len()
        )));
    }

    let mut result = Vec::with_capacity(num_entries);

    for block_idx in 0..num_blocks {
        let block_start = block_idx * block_size;
        let block_entries = if block_idx == num_blocks - 1 {
            num_entries - block_idx * entries_per_block
        } else {
            entries_per_block
        };

        for entry_idx in 0..block_entries {
            let off = block_start + entry_idx * entry_size;
            if off + entry_size > data_size {
                break;
            }

            let mut ekey16 = [0u8; 16];
            ekey16.copy_from_slice(&data[off..off + 16]);

            let size = u32::from_be_bytes(data[off + 16..off + 20].try_into().unwrap());
            let offset = u32::from_be_bytes(data[off + 20..off + 24].try_into().unwrap());

            result.push((ekey16, size, offset));
        }
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_footer(num_entries: u32) -> Vec<u8> {
        let mut footer = vec![0u8; FOOTER_SIZE];
        // toc_hash (bytes 0-7): all zeros
        // params (bytes 8-15):
        footer[8] = 1;  // version
        footer[11] = 4; // block_size_kb
        footer[12] = 4; // f1
        footer[13] = 4; // f2
        footer[14] = 16; // key_size
        footer[15] = 8;  // checksum_size
        // num_entries (bytes 16-19):
        footer[16..20].copy_from_slice(&num_entries.to_le_bytes());
        // data_hash (bytes 20-27): all zeros
        footer
    }

    #[test]
    fn parse_single_entry() {
        // One block (4096 bytes) + TOC entry (24 bytes) + footer (28 bytes) = 4148 bytes
        let mut data = vec![0u8; 4096 + 24 + FOOTER_SIZE];

        // Write one entry at offset 0:
        // key[0..16]
        let ekey: [u8; 16] = [0x21, 0x33, 0xd0, 0xa5, 0xf8, 0xd8, 0x4d, 0x6b,
                               0x8e, 0xb7, 0x72, 0x4e, 0x0e, 0xad, 0xaf, 0xd7];
        data[0..16].copy_from_slice(&ekey);
        // size = 941230 (BE)
        data[16..20].copy_from_slice(&941230u32.to_be_bytes());
        // offset = 4384743 (BE)
        data[20..24].copy_from_slice(&4384743u32.to_be_bytes());

        // Write footer
        let footer = make_footer(1);
        let footer_start = data.len() - FOOTER_SIZE;
        data[footer_start..].copy_from_slice(&footer);

        let entries = parse_archive_index(&data, "testarc").unwrap();
        assert_eq!(entries.len(), 1);
        let (ekey16, size, offset) = entries[0];
        assert_eq!(ekey16, ekey);
        assert_eq!(size, 941230);
        assert_eq!(offset, 4384743);
    }

    #[test]
    fn parse_empty_entries() {
        let mut data = vec![0u8; 4096 + 24 + FOOTER_SIZE];
        let footer = make_footer(0);
        let footer_start = data.len() - FOOTER_SIZE;
        data[footer_start..].copy_from_slice(&footer);
        // 0 entries → 0 blocks → data_size = 0 which is < BLOCK_SIZE
        // parse should handle this gracefully
        // (0 blocks × 4096 = 0, no entries to iterate)
        let entries = parse_archive_index(&data, "empty");
        // May error or return empty, either is acceptable
        if let Ok(e) = entries {
            assert!(e.is_empty());
        }
    }

    #[test]
    fn cdn_archive_index_find() {
        let ekey: [u8; 16] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
        let mut entries = HashMap::new();
        entries.insert(ekey, CdnArchiveEntry {
            archive_hash_hex: "abcdef01234567890123456789abcdef".into(),
            size: 1000,
            offset: 2000,
        });
        let index = CdnArchiveIndex { entries };
        let found = index.find(&ekey).unwrap();
        assert_eq!(found.size, 1000);
        assert_eq!(found.offset, 2000);
    }
}
