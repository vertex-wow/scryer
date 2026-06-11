//! TVFS binary parser.
//!
//! Ported from TACTLib `VFSManifestReader.cs` (C#) and cross-checked against
//! CascLib `CascRootFile_TVFS.cpp` (C). All offset arithmetic follows the
//! CascLib reference since it uses explicit pointer arithmetic rather than
//! stream seeks, making the logic easier to verify in Rust.
//!
//! # Format overview
//!
//! A TVFS blob has four regions identified by absolute offsets in the header:
//!
//! - **Path table** — a trie of path fragments. Each node either has a
//!   `NODE_VALUE` (pointing into the VFS table for a file, or with the high
//!   bit set for an inline subdirectory) or continues into the next node.
//! - **VFS table** — per-file span records (`span_count`, then for each span:
//!   `file_offset(4 BE)`, `span_size(4 BE)`, `cft_offset(1-4 BE)`).
//! - **CFT (Container File Table)** — EKey records, each `ekey_size` (always 9)
//!   bytes long, optionally followed by a CKey when `INCLUDE_CKEY` is set.
//! - **EST table** — only present when `WRITE_SUPPORT` is set; not used here.

use std::collections::HashMap;

use crate::error::{CascError, Result};

// ── Constants ─────────────────────────────────────────────────────────────────

const TVFS_MAGIC: &[u8; 4] = b"TVFS";

/// High bit of node_value: set when the node is a directory rather than a file.
const TVFS_FOLDER_NODE: u32 = 0x8000_0000;

/// Lower 31 bits of node_value give the byte length of a directory block,
/// measured from the start of the node_value field (i.e. includes the 4 bytes
/// of the node_value itself).
const TVFS_FOLDER_SIZE_MASK: u32 = 0x7FFF_FFFF;

/// `ManifestFlags` bit: paths in the path table are already lowercase ASCII.
const FLAG_LOWERCASE_MANIFEST: u32 = 0x0008;

// ── Public types ──────────────────────────────────────────────────────────────

/// A single file entry resolved from the TVFS manifest.
#[derive(Debug, Clone)]
pub struct TvfsEntry {
    /// 9-byte truncated EKey (matches what `CascIndex::find` expects).
    pub ekey9: [u8; 9],
    /// Uncompressed content size in bytes (from the VFS span record).
    pub content_size: u32,
}

/// Parsed TVFS manifest providing path → EKey9 lookup.
pub struct TvfsManifest {
    /// Lowercase forward-slash-normalized path → entry.
    entries: HashMap<String, TvfsEntry>,
}

impl TvfsManifest {
    /// Parse a TVFS manifest from a BLTE-decoded byte slice.
    pub fn parse(data: &[u8]) -> Result<Self> {
        // ── Header ────────────────────────────────────────────────────────────
        // Minimum header size is 0x26 (38) bytes:
        //   magic(4) version(1) header_size(1) ekey_size(1) pkey_size(1)
        //   flags(4 LE) path_table_offset(4 BE) path_table_size(4 BE)
        //   vfs_table_offset(4 BE) vfs_table_size(4 BE)
        //   cft_table_offset(4 BE) cft_table_size(4 BE) max_depth(2 BE)
        if data.len() < 38 {
            return Err(CascError::InvalidFormat(format!(
                "TVFS: data too short for header ({} bytes)",
                data.len()
            )));
        }

        if &data[0..4] != TVFS_MAGIC {
            return Err(CascError::InvalidMagic {
                expected: "TVFS".into(),
                found: String::from_utf8_lossy(&data[0..4]).into_owned(),
            });
        }

        let version = data[4];
        let header_size = data[5] as usize;
        let ekey_size = data[6] as usize;
        let _pkey_size = data[7];

        if version != 1 {
            return Err(CascError::UnsupportedVersion(version as u32));
        }
        if header_size < 0x26 {
            return Err(CascError::InvalidFormat(format!(
                "TVFS: header_size {} < minimum 0x26",
                header_size
            )));
        }
        if ekey_size != 9 {
            return Err(CascError::InvalidFormat(format!(
                "TVFS: unexpected ekey_size {} (expected 9)",
                ekey_size
            )));
        }
        if data.len() < header_size {
            return Err(CascError::InvalidFormat(format!(
                "TVFS: data ({} bytes) shorter than declared header_size {}",
                data.len(),
                header_size
            )));
        }

        // CascLib uses LE for Flags, BE for everything else. The flag bits we
        // care about (LOWERCASE_MANIFEST = 0x08) are in the low byte so the
        // endianness doesn't affect correctness in practice. We follow BE
        // throughout to match TACTLib's struct definition.
        let flags = read_be_u32(data, 8);
        let path_table_offset = read_be_u32(data, 12) as usize;
        let path_table_size = read_be_u32(data, 16) as usize;
        let vfs_table_offset = read_be_u32(data, 20) as usize;
        let _vfs_table_size = read_be_u32(data, 24) as usize;
        let cft_table_offset = read_be_u32(data, 28) as usize;
        let cft_table_size = read_be_u32(data, 32) as usize;
        // max_depth at [36..38] (u16 BE) — not needed for extraction

        let cft_offs_size = cft_offset_field_size(cft_table_size as u32);
        let manifest_is_lowercase = (flags & FLAG_LOWERCASE_MANIFEST) != 0;

        // ── Sanity-check table extents ─────────────────────────────────────
        let path_table_end = path_table_offset
            .checked_add(path_table_size)
            .filter(|&e| e <= data.len())
            .ok_or_else(|| {
                CascError::InvalidFormat("TVFS: path table extends beyond data".into())
            })?;

        if vfs_table_offset > data.len() {
            return Err(CascError::InvalidFormat(
                "TVFS: vfs_table_offset out of bounds".into(),
            ));
        }
        if cft_table_offset > data.len() {
            return Err(CascError::InvalidFormat(
                "TVFS: cft_table_offset out of bounds".into(),
            ));
        }

        // ── Root directory detection ───────────────────────────────────────
        // The path table may start with a root-directory node: 0xFF followed by
        // a 4-byte big-endian node_value (high bit set, lower 31 bits = dir length
        // including the node_value itself). Skip that node_value and parse
        // inside the root directory's bounds.
        let (dir_ptr, dir_end) =
            detect_root_dir(data, path_table_offset, path_table_end)?;

        // ── Recursive path walk ────────────────────────────────────────────
        let mut entries = HashMap::new();
        parse_path_file_table(
            data,
            dir_ptr,
            dir_end,
            String::new(),
            vfs_table_offset,
            cft_table_offset,
            cft_offs_size,
            ekey_size,
            manifest_is_lowercase,
            &mut entries,
        )?;

        tracing::debug!("TVFS: parsed {} entries", entries.len());
        Ok(Self { entries })
    }

    /// Look up a file by virtual path.
    ///
    /// The path is normalized (lowercased, backslash → forward slash) before
    /// lookup to match the stored keys.
    pub fn get(&self, path: &str) -> Option<&TvfsEntry> {
        let key = normalize_path_key(path);
        self.entries.get(&key)
    }

    /// Number of file entries in the manifest.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether the manifest contains no entries.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Iterate all `(path, entry)` pairs. Paths are lowercase and use `/`.
    pub fn iter(&self) -> impl Iterator<Item = (&String, &TvfsEntry)> {
        self.entries.iter()
    }

    /// Merge all entries from `other` into this manifest (last-write wins on collision).
    pub fn extend(&mut self, other: TvfsManifest) {
        self.entries.extend(other.entries);
    }

    #[cfg(test)]
    pub fn single_entry_for_tests(path: &str, ekey9: [u8; 9], content_size: u32) -> Self {
        let mut entries = HashMap::new();
        entries.insert(
            path.to_lowercase().replace('\\', "/"),
            TvfsEntry { ekey9, content_size },
        );
        Self { entries }
    }
}

// ── Path walker ───────────────────────────────────────────────────────────────

/// Detect the root directory bounds inside the path table.
///
/// The path table typically starts with:
///   `0xFF` + 4-byte BE node_value (high bit set, low 31 bits = dir length)
///
/// If that pattern is present, the actual directory data starts after those
/// 5 bytes and ends at `path_table_offset + (node_value & MASK)`.
/// Otherwise the whole path table is the directory.
fn detect_root_dir(
    data: &[u8],
    path_table_offset: usize,
    path_table_end: usize,
) -> Result<(usize, usize)> {
    // Need at least 5 bytes for root node header (0xFF + i32)
    if path_table_offset + 5 <= path_table_end && data[path_table_offset] == 0xFF {
        let node_value = read_be_i32(data, path_table_offset + 1) as u32;
        if (node_value & TVFS_FOLDER_NODE) == 0 {
            return Err(CascError::InvalidFormat(
                "TVFS: root node_value missing FOLDER_NODE bit".into(),
            ));
        }
        let dir_len = (node_value & TVFS_FOLDER_SIZE_MASK) as usize;
        let dir_end = path_table_offset + 1 + dir_len;
        if dir_end > path_table_end {
            return Err(CascError::InvalidFormat(
                "TVFS: root dir extends beyond path table".into(),
            ));
        }
        // Content starts after the 0xFF byte + 4-byte node_value
        let dir_ptr = path_table_offset + 1 + 4;
        return Ok((dir_ptr, dir_end));
    }
    Ok((path_table_offset, path_table_end))
}

/// Parsed path table entry.
struct PathEntry {
    /// Name fragment (None when the byte was 0xFF — node value immediately follows).
    name: Option<String>,
    /// Byte `0x00` appeared before the name → prepend `/` to path buffer.
    pre_sep: bool,
    /// Byte `0x00` appeared after the name, or implicit (non-0xFF byte follows name).
    post_sep: bool,
    /// Whether a node value was read.
    has_node_value: bool,
    /// Raw node value (signed; high bit = folder, low 31 bits = dir length / vfs offset).
    node_value: i32,
}

/// Accumulate path fragments and emit file entries.
///
/// `path_prefix` is the accumulated path up to this invocation. Each call
/// appends fragments until it hits a `NODE_VALUE` entry, then either recurses
/// (directory) or emits a file entry, and resets the buffer back to
/// `path_prefix` for the next sibling.
#[allow(clippy::too_many_arguments)]
fn parse_path_file_table(
    data: &[u8],
    path_table_ptr: usize,
    path_table_end: usize,
    path_prefix: String,
    vfs_table_offset: usize,
    cft_table_offset: usize,
    cft_offs_size: usize,
    ekey_size: usize,
    manifest_is_lowercase: bool,
    entries: &mut HashMap<String, TvfsEntry>,
) -> Result<()> {
    let mut pos = path_table_ptr;
    // Save the entry-point prefix. After each NODE_VALUE entry we restore the
    // buffer to this value (matching the C# "pathBufferBak = pathBuffer" pattern).
    let path_save = path_prefix.clone();
    let mut path_buffer = path_prefix;

    while pos < path_table_end {
        let (entry, new_pos) = read_path_entry(data, pos, path_table_end)?;
        pos = new_pos;

        // Accumulate this fragment onto the path buffer.
        if entry.pre_sep {
            path_buffer.push('/');
        }
        if let Some(ref name) = entry.name {
            path_buffer.push_str(name);
        }
        if entry.post_sep {
            path_buffer.push('/');
        }

        if entry.has_node_value {
            let nv = entry.node_value as u32;

            if nv & TVFS_FOLDER_NODE != 0 {
                // ── Subdirectory ────────────────────────────────────────────
                // Directory data follows immediately. Its length (in the lower
                // 31 bits) counts from the start of the node_value field, so
                // subtract 4 (sizeof node_value) to get the end relative to
                // `pos` (which is already past the node_value bytes).
                let dir_len = (nv & TVFS_FOLDER_SIZE_MASK) as usize;
                if dir_len < 4 {
                    // Degenerate: length <= sizeof(node_value), empty dir body.
                    tracing::debug!("TVFS: degenerate dir node (len={})", dir_len);
                    pos += dir_len.saturating_sub(4);
                } else {
                    let dir_end = pos + dir_len - 4;
                    if dir_end > path_table_end {
                        tracing::debug!("TVFS: dir_end {} > path_table_end {}, clamping", dir_end, path_table_end);
                    }
                    let dir_end = dir_end.min(path_table_end);
                    parse_path_file_table(
                        data,
                        pos,
                        dir_end,
                        path_buffer.clone(),
                        vfs_table_offset,
                        cft_table_offset,
                        cft_offs_size,
                        ekey_size,
                        manifest_is_lowercase,
                        entries,
                    )?;
                    pos = dir_end;
                }
            } else {
                // ── File ────────────────────────────────────────────────────
                let vfs_offset = nv as usize;
                match read_vfs_entry(
                    data,
                    vfs_table_offset,
                    vfs_offset,
                    cft_table_offset,
                    cft_offs_size,
                    ekey_size,
                ) {
                    Ok(tvfs_entry) => {
                        let key = if manifest_is_lowercase {
                            path_buffer.replace('\\', "/")
                        } else {
                            normalize_path_key(&path_buffer)
                        };
                        // Skip WoW "generic" names (hex-encoded FDID+CKey paths).
                        // These look like "000000020000:000C472F...", have no
                        // human-readable path, and aren't useful for our lookups.
                        if !is_wow_generic_name(&key) {
                            entries.insert(key, tvfs_entry);
                        }
                    }
                    Err(e) => {
                        tracing::debug!(
                            "TVFS: skip '{}' (vfs_offset={}): {}",
                            path_buffer,
                            vfs_offset,
                            e
                        );
                    }
                }
            }

            // Restore the path buffer to the prefix for the next sibling.
            path_buffer = path_save.clone();
        }
    }

    Ok(())
}

/// Parse a single path table entry from `data` at byte `pos`.
///
/// Structure (from CascLib comment):
/// ```text
/// (1byte) 0x00 optional — prefix path separator
/// (1byte) name length
/// (?byte) name
/// (1byte) 0x00 optional — postfix path separator
/// (1byte) 0xFF optional — node value marker
/// (4byte)              — node value (BE)
/// ```
fn read_path_entry(
    data: &[u8],
    mut pos: usize,
    end: usize,
) -> Result<(PathEntry, usize)> {
    let mut entry = PathEntry {
        name: None,
        pre_sep: false,
        post_sep: false,
        has_node_value: false,
        node_value: 0,
    };

    // 1. Pre-separator: current byte == 0x00 → consume and set flag.
    if pos < end && data[pos] == 0x00 {
        entry.pre_sep = true;
        pos += 1;
    }

    // 2. Name: current byte != 0xFF → treat as length byte + name bytes.
    if pos < end && data[pos] != 0xFF {
        let length = data[pos] as usize;
        pos += 1;
        if pos + length > end {
            return Err(CascError::InvalidFormat(format!(
                "TVFS: path entry name (len={}) extends past path table end",
                length
            )));
        }
        if length > 0 {
            let name_bytes = &data[pos..pos + length];
            let name = std::str::from_utf8(name_bytes).map_err(|_| {
                CascError::InvalidFormat("TVFS: path entry name is not valid UTF-8".into())
            })?;
            entry.name = Some(name.to_string());
        }
        pos += length;
    }

    // 3. Post-separator: current byte == 0x00 → consume and set flag.
    if pos < end && data[pos] == 0x00 {
        entry.post_sep = true;
        pos += 1;
    }

    // 4. Node value: 0xFF marker + 4-byte BE i32.
    //    Otherwise: the next non-zero byte implies a post-separator (path trie
    //    continues), but no node value for this entry.
    if pos < end {
        if data[pos] == 0xFF {
            pos += 1;
            if pos + 4 > end {
                return Err(CascError::InvalidFormat(
                    "TVFS: node_value field extends past path table end".into(),
                ));
            }
            entry.node_value = read_be_i32(data, pos);
            entry.has_node_value = true;
            pos += 4;
        } else {
            // Non-0xFF: implicit post-separator (path continues to next node).
            entry.post_sep = true;
        }
    }

    Ok((entry, pos))
}

/// Read a VFS entry at `vfs_table_offset + vfs_offset` and resolve the EKey
/// from the CFT at `cft_table_offset + cft_offset`.
///
/// We take only the first span (multi-span files are rare in WoW and all game
/// files we care about fit in a single span).
fn read_vfs_entry(
    data: &[u8],
    vfs_table_offset: usize,
    vfs_offset: usize,
    cft_table_offset: usize,
    cft_offs_size: usize,
    ekey_size: usize,
) -> Result<TvfsEntry> {
    let vfs_entry_pos = vfs_table_offset
        .checked_add(vfs_offset)
        .filter(|&p| p < data.len())
        .ok_or_else(|| {
            CascError::InvalidFormat(format!(
                "TVFS: vfs_offset {} out of bounds",
                vfs_offset
            ))
        })?;

    // span_count (1 byte): valid range 1..=224
    let span_count = data[vfs_entry_pos];
    if span_count == 0 || span_count > 224 {
        return Err(CascError::InvalidFormat(format!(
            "TVFS: invalid span_count {} at vfs offset {}",
            span_count, vfs_offset
        )));
    }

    // Read first span: file_offset(4 BE) + span_size(4 BE) + cft_offset(variable BE)
    let span_start = vfs_entry_pos + 1;
    let span_entry_size = 4 + 4 + cft_offs_size;
    if span_start + span_entry_size > data.len() {
        return Err(CascError::InvalidFormat(
            "TVFS: VFS span entry out of bounds".into(),
        ));
    }

    // file_offset at span_start+0 (not needed for extraction)
    let content_size = read_be_u32(data, span_start + 4);
    let cft_offset = read_be_uint(data, span_start + 8, cft_offs_size);

    // Resolve EKey from CFT
    let cft_entry_pos = cft_table_offset
        .checked_add(cft_offset)
        .filter(|&p| p + ekey_size <= data.len())
        .ok_or_else(|| {
            CascError::InvalidFormat(format!(
                "TVFS: cft_offset {} out of bounds (ekey_size={})",
                cft_offset, ekey_size
            ))
        })?;

    let mut ekey9 = [0u8; 9];
    ekey9.copy_from_slice(&data[cft_entry_pos..cft_entry_pos + 9]);

    Ok(TvfsEntry { ekey9, content_size })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Returns the number of bytes used for CFT offset fields in VFS span entries.
fn cft_offset_field_size(table_size: u32) -> usize {
    if table_size > 0x00FF_FFFF {
        4
    } else if table_size > 0x0000_FFFF {
        3
    } else if table_size > 0x0000_00FF {
        2
    } else {
        1
    }
}

/// Read a big-endian u32 from `data` at `offset`.
fn read_be_u32(data: &[u8], offset: usize) -> u32 {
    u32::from_be_bytes(data[offset..offset + 4].try_into().unwrap())
}

/// Read a big-endian i32 from `data` at `offset`.
fn read_be_i32(data: &[u8], offset: usize) -> i32 {
    i32::from_be_bytes(data[offset..offset + 4].try_into().unwrap())
}

/// Read a big-endian unsigned integer of `size` bytes (1–4) from `data`.
fn read_be_uint(data: &[u8], offset: usize, size: usize) -> usize {
    let mut value: usize = 0;
    for i in 0..size {
        value = (value << 8) | (data[offset + i] as usize);
    }
    value
}

/// Normalize a TVFS path to a lowercase forward-slash key for HashMap storage.
fn normalize_path_key(path: &str) -> String {
    path.to_lowercase().replace('\\', "/")
}

/// Returns `true` for WoW "generic" TVFS names (hex-encoded locale/content
/// flags + FDID + CKey), e.g. `"000000020000:000C472F02BA924C..."`.
///
/// These names have no human-readable path component and will never match a
/// user query. CascLib's `CheckWoWGenericName` identifies them by length and
/// the presence of `:` at position 12 or 16.
fn is_wow_generic_name(path: &str) -> bool {
    let len = path.len();
    if len == 52 || len == 53 || len == 57 {
        if let Some(colon_pos) = path.find(':') {
            return colon_pos == 12 || colon_pos == 16;
        }
    }
    false
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── Header parsing ────────────────────────────────────────────────────────

    #[test]
    fn reject_wrong_magic() {
        let mut data = vec![0u8; 38];
        data[0..4].copy_from_slice(b"BLTE");
        assert!(TvfsManifest::parse(&data).is_err());
    }

    #[test]
    fn reject_too_short() {
        let data = vec![0u8; 10];
        assert!(TvfsManifest::parse(&data).is_err());
    }

    #[test]
    fn reject_wrong_version() {
        let data = build_tvfs_header(2, 0x26, 9, 9, 0, 0x26, 0, 0x26, 0, 0x26, 0, 1);
        assert!(TvfsManifest::parse(&data).is_err());
    }

    #[test]
    fn reject_small_header_size() {
        let data = build_tvfs_header(1, 0x10, 9, 9, 0, 0x26, 0, 0x26, 0, 0x26, 0, 1);
        assert!(TvfsManifest::parse(&data).is_err());
    }

    #[test]
    fn reject_wrong_ekey_size() {
        let data = build_tvfs_header(1, 0x26, 16, 9, 0, 0x26, 0, 0x26, 0, 0x26, 0, 1);
        assert!(TvfsManifest::parse(&data).is_err());
    }

    // ── Empty manifest ────────────────────────────────────────────────────────

    #[test]
    fn parse_empty_manifest() {
        let data = build_minimal_tvfs(&[]);
        let manifest = TvfsManifest::parse(&data).expect("should parse empty manifest");
        assert!(manifest.is_empty());
    }

    // ── cft_offset_field_size ─────────────────────────────────────────────────

    #[test]
    fn cft_offs_size_1_byte() {
        assert_eq!(cft_offset_field_size(0), 1);
        assert_eq!(cft_offset_field_size(0xFF), 1);
    }

    #[test]
    fn cft_offs_size_2_bytes() {
        assert_eq!(cft_offset_field_size(0x100), 2);
        assert_eq!(cft_offset_field_size(0xFFFF), 2);
    }

    #[test]
    fn cft_offs_size_3_bytes() {
        assert_eq!(cft_offset_field_size(0x10000), 3);
        assert_eq!(cft_offset_field_size(0xFFFFFF), 3);
    }

    #[test]
    fn cft_offs_size_4_bytes() {
        assert_eq!(cft_offset_field_size(0x01000000), 4);
        assert_eq!(cft_offset_field_size(u32::MAX), 4);
    }

    // ── is_wow_generic_name ───────────────────────────────────────────────────

    #[test]
    fn generic_name_detected() {
        // 53-char path with colon at pos 16 (old format)
        let name = "0000000200000000:005096B78ECBF6630B7A282B01358857C6DDF2B2";
        assert_eq!(name.len(), 57);
        assert!(is_wow_generic_name(name));
    }

    #[test]
    fn regular_name_not_generic() {
        assert!(!is_wow_generic_name("interface/buttons/ui-checkbox.blp"));
        assert!(!is_wow_generic_name("world/maps/azeroth/azeroth_25_25.adt"));
    }

    // ── Round-trip fixture ────────────────────────────────────────────────────

    #[test]
    fn parse_single_file() {
        // Build a minimal TVFS with one file: "dir/file.blp" → a known EKey9.
        let ekey9 = [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09];
        let data = build_single_file_tvfs("dir/file.blp", &ekey9, 1234);
        let manifest = TvfsManifest::parse(&data).expect("should parse single-file TVFS");

        assert_eq!(manifest.len(), 1);

        let entry = manifest.get("dir/file.blp").expect("should find 'dir/file.blp'");
        assert_eq!(entry.ekey9, ekey9);
        assert_eq!(entry.content_size, 1234);
    }

    #[test]
    fn lookup_case_insensitive() {
        let ekey9 = [0xAA; 9];
        let data = build_single_file_tvfs("Interface/Buttons/UI-CheckBox.blp", &ekey9, 0);
        let manifest = TvfsManifest::parse(&data).unwrap();

        // Stored lowercase; lookup should work with any case.
        assert!(manifest.get("interface/buttons/ui-checkbox.blp").is_some());
        assert!(manifest.get("Interface/Buttons/UI-CheckBox.blp").is_some());
        assert!(manifest.get("INTERFACE/BUTTONS/UI-CHECKBOX.BLP").is_some());
    }

    #[test]
    fn parse_two_files_different_dirs() {
        let ekey_a = [0xAA; 9];
        let ekey_b = [0xBB; 9];
        let data = build_two_file_tvfs(
            "dir_a/file_a.blp", &ekey_a, 100,
            "dir_b/file_b.blp", &ekey_b, 200,
        );
        let manifest = TvfsManifest::parse(&data).unwrap();
        assert_eq!(manifest.len(), 2);
        assert_eq!(manifest.get("dir_a/file_a.blp").unwrap().ekey9, ekey_a);
        assert_eq!(manifest.get("dir_b/file_b.blp").unwrap().ekey9, ekey_b);
    }

    #[test]
    fn generic_names_excluded() {
        // Generic names should not appear in entries.
        let ekey9 = [0x01; 9];
        // 57-char WoW generic name (locale=00000002, content=00000000, FDID=00000001, ckey=...)
        let generic = "0000000200000000:005096B78ECBF6630B7A282B01358857C6DDF2B2";
        assert_eq!(generic.len(), 57);
        let data = build_single_file_tvfs(generic, &ekey9, 0);
        let manifest = TvfsManifest::parse(&data).unwrap();
        assert!(manifest.is_empty(), "generic-named entries should be excluded");
    }

    // ── Fixture builders ──────────────────────────────────────────────────────

    /// Build a raw TVFS header block (38 bytes). Table offsets start after the
    /// header; sizes / content supplied by caller.
    #[allow(clippy::too_many_arguments)]
    fn build_tvfs_header(
        version: u8,
        header_size: u8,
        ekey_size: u8,
        pkey_size: u8,
        flags: u32,
        path_table_offset: u32,
        path_table_size: u32,
        vfs_table_offset: u32,
        vfs_table_size: u32,
        cft_table_offset: u32,
        cft_table_size: u32,
        max_depth: u16,
    ) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(b"TVFS");          // magic
        v.push(version);                        // version
        v.push(header_size);                    // header_size
        v.push(ekey_size);                      // ekey_size
        v.push(pkey_size);                      // pkey_size
        v.extend_from_slice(&flags.to_be_bytes());
        v.extend_from_slice(&path_table_offset.to_be_bytes());
        v.extend_from_slice(&path_table_size.to_be_bytes());
        v.extend_from_slice(&vfs_table_offset.to_be_bytes());
        v.extend_from_slice(&vfs_table_size.to_be_bytes());
        v.extend_from_slice(&cft_table_offset.to_be_bytes());
        v.extend_from_slice(&cft_table_size.to_be_bytes());
        v.extend_from_slice(&max_depth.to_be_bytes());
        assert_eq!(v.len(), 38);
        v
    }

    /// Build the smallest valid TVFS with zero files and empty tables.
    fn build_minimal_tvfs(_files: &[()]) -> Vec<u8> {
        // Layout: header(38) | path_table(0) | vfs_table(0) | cft_table(0)
        // All table offsets point to byte 38 (after header) with size 0.
        build_tvfs_header(1, 0x26, 9, 9, 0, 38, 0, 38, 0, 38, 0, 1)
    }

    /// Encode a path as a sequence of path table entries that spell out the
    /// path fragments and terminate with a file NODE_VALUE.
    ///
    /// The encoding is flat (no subdirectory nodes): each path component
    /// (including intermediate separators) is emitted as a direct fragment.
    ///
    /// Path `"dir/file.blp"` → entries:
    ///   [name="dir", post_sep] + [pre_sep, name="file.blp", node_value=0]
    ///
    /// For simplicity this builder encodes as:
    ///   pre_sep=false, name=full_path, post_sep=false, NODE_VALUE=0
    /// (single entry, flat, works for any path without sub-dirs).
    fn encode_path_entry_flat(path: &str, vfs_offset: i32) -> Vec<u8> {
        let mut v = Vec::new();
        // name length + name bytes
        let name_bytes = path.as_bytes();
        assert!(name_bytes.len() <= 255, "path too long for test fixture");
        v.push(name_bytes.len() as u8);
        v.extend_from_slice(name_bytes);
        // node value: 0xFF marker + vfs_offset (no FOLDER_NODE bit)
        v.push(0xFF);
        v.extend_from_slice(&vfs_offset.to_be_bytes());
        v
    }

    /// Build a VFS span entry: span_count(1) + file_offset(4) + span_size(4) + cft_offset(1).
    fn encode_vfs_span(content_size: u32, cft_offset: u8) -> Vec<u8> {
        let mut v = Vec::new();
        v.push(1u8);                                    // span_count = 1
        v.extend_from_slice(&0u32.to_be_bytes());       // file_offset (unused)
        v.extend_from_slice(&content_size.to_be_bytes()); // span_size = content_size
        v.push(cft_offset);                             // cft_offset (1 byte, table < 256)
        v
    }

    /// Build a minimal one-file TVFS blob.
    fn build_single_file_tvfs(path: &str, ekey9: &[u8; 9], content_size: u32) -> Vec<u8> {
        // Layout after header (38 bytes):
        //   path_table: root_dir_node(5) + path_entry
        //   vfs_table:  span entry
        //   cft_table:  ekey9 (9 bytes)

        // Path table entry for the file (vfs_offset = 0, relative to vfs_table start)
        let path_entry = encode_path_entry_flat(path, 0);
        // Wrap in root dir node: 0xFF + node_value (FOLDER_NODE | dir_len)
        // dir_len includes the 4-byte node_value itself
        let dir_body_len = path_entry.len();
        let node_value = TVFS_FOLDER_NODE | (4 + dir_body_len as u32);
        let mut path_table = Vec::new();
        path_table.push(0xFF);
        path_table.extend_from_slice(&(node_value as i32).to_be_bytes());
        path_table.extend_from_slice(&path_entry);

        // VFS table: one span entry (cft_offset=0)
        let vfs_table = encode_vfs_span(content_size, 0);

        // CFT table: ekey9
        let cft_table: Vec<u8> = ekey9.to_vec();

        let header_size: u32 = 38;
        let path_off = header_size;
        let path_size = path_table.len() as u32;
        let vfs_off = path_off + path_size;
        let vfs_size = vfs_table.len() as u32;
        let cft_off = vfs_off + vfs_size;
        let cft_size = cft_table.len() as u32;

        let mut blob = build_tvfs_header(
            1, 0x26, 9, 9, 0,
            path_off, path_size,
            vfs_off, vfs_size,
            cft_off, cft_size,
            1,
        );
        blob.extend_from_slice(&path_table);
        blob.extend_from_slice(&vfs_table);
        blob.extend_from_slice(&cft_table);
        blob
    }

    /// Build a two-file TVFS blob.
    fn build_two_file_tvfs(
        path_a: &str, ekey_a: &[u8; 9], size_a: u32,
        path_b: &str, ekey_b: &[u8; 9], size_b: u32,
    ) -> Vec<u8> {
        // VFS table: span_a (10 bytes, cft_offset=0) + span_b (10 bytes, cft_offset=9)
        let vfs_a = encode_vfs_span(size_a, 0);   // cft_offset = 0
        let vfs_b = encode_vfs_span(size_b, 9);   // cft_offset = 9 (after ekey_a)

        // Path entries: file_a uses vfs_offset=0, file_b uses vfs_offset=vfs_a.len()
        let entry_a = encode_path_entry_flat(path_a, 0);
        let entry_b = encode_path_entry_flat(path_b, vfs_a.len() as i32);

        let dir_body = {
            let mut v = Vec::new();
            v.extend_from_slice(&entry_a);
            v.extend_from_slice(&entry_b);
            v
        };
        let node_value = TVFS_FOLDER_NODE | (4 + dir_body.len() as u32);
        let mut path_table = Vec::new();
        path_table.push(0xFF);
        path_table.extend_from_slice(&(node_value as i32).to_be_bytes());
        path_table.extend_from_slice(&dir_body);

        let mut vfs_table = Vec::new();
        vfs_table.extend_from_slice(&vfs_a);
        vfs_table.extend_from_slice(&vfs_b);

        let mut cft_table = Vec::new();
        cft_table.extend_from_slice(ekey_a);
        cft_table.extend_from_slice(ekey_b);

        let header_size: u32 = 38;
        let path_off = header_size;
        let path_size = path_table.len() as u32;
        let vfs_off = path_off + path_size;
        let vfs_size = vfs_table.len() as u32;
        let cft_off = vfs_off + vfs_size;
        let cft_size = cft_table.len() as u32;

        let mut blob = build_tvfs_header(
            1, 0x26, 9, 9, 0,
            path_off, path_size,
            vfs_off, vfs_size,
            cft_off, cft_size,
            1,
        );
        blob.extend_from_slice(&path_table);
        blob.extend_from_slice(&vfs_table);
        blob.extend_from_slice(&cft_table);
        blob
    }
}
