//! Tier 3 — Synthetic CASC fixture tests.
//!
//! Builds a minimal valid CASC directory tree in a temp directory and exercises
//! `CascStorage::open → extract_all` end-to-end without a real WoW install.
//!
//! Three scenarios:
//!   1. Happy path: valid BLTE payload → extracted file matches input bytes.
//!   2. CDN-only stub: idx entry present but bytes at offset are not "BLTE" → skipped.
//!   3. Encrypted skip: ENCRYPTED content flag set → skipped without reading data.

use std::path::{Path, PathBuf};

use casc_lib::extract::{CascStorage, ExtractionConfig, OpenConfig, extract_all};

// ─── Key/FDID constants ──────────────────────────────────────────────────────

const BUILD_KEY_HEX: &str = "aabbccdd00112233aabbccdd00112233";

// Hex literals match the repeated-byte keys below.
const ROOT_CKEY_HEX: &str = "11111111111111111111111111111111";
const ENCODING_EKEY_HEX: &str = "33333333333333333333333333333333";

const ROOT_CKEY: [u8; 16] = [0x11; 16];
const ROOT_EKEY: [u8; 16] = [0x22; 16];
const ENCODING_EKEY: [u8; 16] = [0x33; 16];

const CKEY1: [u8; 16] = [0xA1; 16]; // FDID 1 — happy path
const EKEY1: [u8; 16] = [0xB1; 16];
const CKEY2: [u8; 16] = [0xA2; 16]; // FDID 2 — CDN-only stub
const EKEY2: [u8; 16] = [0xB2; 16];
const CKEY3: [u8; 16] = [0xA3; 16]; // FDID 3 — encrypted skip (no idx entry needed)

const PAYLOAD1: &[u8] = b"hello casc";

// ─── Binary format helpers ───────────────────────────────────────────────────

/// Wrap `payload` in a minimal single-block raw BLTE container (header_size=0).
fn make_blte(payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(9 + payload.len());
    out.extend_from_slice(b"BLTE");
    out.extend_from_slice(&0u32.to_be_bytes()); // header_size = 0 → single block
    out.push(b'N'); // raw (uncompressed) block mode
    out.extend_from_slice(payload);
    out
}

/// Build the 30-byte data.NNN per-entry header.
///
/// `total_size` includes this header (30) plus the BLTE payload length.
fn make_data_header(ekey: &[u8; 16], total_size: u32) -> [u8; 30] {
    let mut h = [0u8; 30];
    // EKey stored reversed on disk
    for i in 0..16 {
        h[i] = ekey[15 - i];
    }
    h[0x10..0x14].copy_from_slice(&total_size.to_le_bytes());
    h
}

/// Build raw (decoded) encoding file bytes — EN format v1, 1 KiB CE pages.
///
/// `entries`: `(ckey, ekey, file_size_hint)`
fn make_encoding_raw(entries: &[([u8; 16], [u8; 16], u64)]) -> Vec<u8> {
    const HASH_SIZE: u8 = 16;
    const PAGE_SIZE_KB: u16 = 1;
    const PAGE_SIZE: usize = 1024;
    // 1 (key_count) + 5 (file_size u40) + 16 (ckey) + 16 (ekey)
    const ENTRY_STRIDE: usize = 38;
    let entries_per_page = PAGE_SIZE / ENTRY_STRIDE;
    let ce_page_count = entries.len().div_ceil(entries_per_page).max(1) as u32;

    let mut data = Vec::new();

    // 22-byte header (big-endian fields)
    data.extend_from_slice(b"EN");
    data.push(1); // version
    data.push(HASH_SIZE); // hash_size_ckey
    data.push(HASH_SIZE); // hash_size_ekey
    data.extend_from_slice(&PAGE_SIZE_KB.to_be_bytes()); // ce_page_size_kb
    data.extend_from_slice(&PAGE_SIZE_KB.to_be_bytes()); // espec_page_size_kb
    data.extend_from_slice(&ce_page_count.to_be_bytes()); // ce_page_count
    data.extend_from_slice(&0u32.to_be_bytes()); // espec_page_count = 0
    data.push(0); // flags = 0
    data.extend_from_slice(&0u32.to_be_bytes()); // espec_block_size = 0

    // Sort entries by CKey so page-index first_ckey values are accurate
    let mut sorted: Vec<([u8; 16], [u8; 16], u64)> = entries.to_vec();
    sorted.sort_by_key(|e| e.0);

    // Page index: ce_page_count × (first_ckey[16] + page_md5[16])
    for page_idx in 0..ce_page_count as usize {
        let first = page_idx * entries_per_page;
        if first < sorted.len() {
            data.extend_from_slice(&sorted[first].0);
        } else {
            data.extend_from_slice(&[0xFFu8; 16]);
        }
        data.extend_from_slice(&[0u8; 16]); // md5 zeroed (not checked by parser)
    }

    // CE pages: each is PAGE_SIZE bytes, zero-padded to boundary
    for page_idx in 0..ce_page_count as usize {
        let start = page_idx * entries_per_page;
        let end = (start + entries_per_page).min(sorted.len());
        let mut page = Vec::new();
        for &(ckey, ekey, file_size) in &sorted[start..end] {
            page.push(1u8); // key_count = 1
            // file_size as big-endian u40 (5 bytes)
            page.push((file_size >> 32) as u8);
            page.push((file_size >> 24) as u8);
            page.push((file_size >> 16) as u8);
            page.push((file_size >> 8) as u8);
            page.push(file_size as u8);
            page.extend_from_slice(&ckey);
            page.extend_from_slice(&ekey);
        }
        page.resize(PAGE_SIZE, 0); // pad to page boundary
        data.extend_from_slice(&page);
    }

    data
}

/// Build raw (decoded) root file bytes — Legacy format (no MFST header).
///
/// Each block: `(content_flags, locale_flags, entries)` where entries are
/// `(fdid_delta, ckey)` pairs.
fn make_root_raw(blocks: &[(u32, u32, Vec<(i32, [u8; 16])>)]) -> Vec<u8> {
    let mut data = Vec::new();
    for (content_flags, locale_flags, entries) in blocks {
        // Block header v1: num_records (4) + content_flags (4) + locale_flags (4)
        data.extend_from_slice(&(entries.len() as u32).to_le_bytes());
        data.extend_from_slice(&content_flags.to_le_bytes());
        data.extend_from_slice(&locale_flags.to_le_bytes());
        // FDID deltas
        for (delta, _) in entries {
            data.extend_from_slice(&delta.to_le_bytes());
        }
        // CKeys
        for (_, ckey) in entries {
            data.extend_from_slice(ckey);
        }
        // Name hashes omitted when NoNameHash (0x10000000) flag is set
        if content_flags & 0x10000000 == 0 {
            for _ in entries {
                data.extend_from_slice(&0u64.to_le_bytes());
            }
        }
    }
    data
}

/// Build an `.idx` binary file (0x28-byte header + 18-byte entries).
///
/// Each entry: `(key_prefix_9, archive_number, archive_offset, size)`.
fn make_idx(entries: &[([u8; 9], u32, u64, u32)]) -> Vec<u8> {
    const OFFSET_BITS: u8 = 30;
    const ENTRY_STRIDE: usize = 18; // 9 (key) + 5 (archive+offset u40 BE) + 4 (size LE)
    let body_len = entries.len() * ENTRY_STRIDE;

    let mut data = vec![0u8; 0x28 + body_len];

    // Header fields (see storage/index.rs parse_idx_header for the layout)
    data[0x08..0x0A].copy_from_slice(&7u16.to_le_bytes()); // version = 7
    data[0x0A] = 0; // bucket index
    data[0x0B] = 0; // extra_bytes
    data[0x0C] = 4; // size_len
    data[0x0D] = 5; // offset_len
    data[0x0E] = 9; // key_len
    data[0x0F] = OFFSET_BITS;
    data[0x20..0x24].copy_from_slice(&(body_len as u32).to_le_bytes()); // entries_size

    for (i, &(key, archive, offset, size)) in entries.iter().enumerate() {
        let base = 0x28 + i * ENTRY_STRIDE;
        data[base..base + 9].copy_from_slice(&key);

        // Pack (archive_number, archive_offset) into a big-endian 5-byte u40.
        // The high (8 - offset_bits/8) bits carry the archive number.
        let raw: u64 = ((archive as u64) << OFFSET_BITS) | offset;
        let raw_be = raw.to_be_bytes(); // 8 bytes; we want the lower 5
        data[base + 9..base + 14].copy_from_slice(&raw_be[3..]);

        data[base + 14..base + 18].copy_from_slice(&size.to_le_bytes());
    }

    data
}

/// Take the first 9 bytes of a 16-byte key as a `[u8; 9]` idx prefix.
fn key9(k: &[u8; 16]) -> [u8; 9] {
    let mut out = [0u8; 9];
    out.copy_from_slice(&k[..9]);
    out
}

// ─── Temp directory helpers ──────────────────────────────────────────────────

fn temp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("casc_synthetic_{}", tag));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

// ─── Fixture builder ─────────────────────────────────────────────────────────

/// Write a complete synthetic CASC fixture to `dir` and return a ready `OpenConfig`.
///
/// Directory layout written:
///
/// ```text
/// <dir>/
///   .build.info
///   Data/
///     config/aa/bb/<build_key>
///     data/
///       data.000
///       0000000001.idx
///   listfile.csv          (empty — avoids network download)
/// ```
///
/// `data.000` layout:
///
/// ```text
/// offset 0          : [30-byte header for ENCODING_EKEY][enc_blte]
/// offset enc_total  : [30-byte header for ROOT_EKEY][root_blte]
/// offset cont_start : [payload1_blte]      ← BLTE directly (no header prefix)
/// offset stub_start : [0x00 × 8]           ← CDN-only: not "BLTE", 8 bytes minimum
/// ```
///
/// Bootstrap reads (`bootstrap_encoding`, `bootstrap_root`) use `read_entry`
/// which skips the 30-byte header. Content reads (`read_by_ckey`) use
/// `read_raw` which returns data from the idx offset directly, so content
/// entries have their BLTE payload sitting at the idx offset with no prefix.
fn build_fixture(dir: &Path) -> OpenConfig {
    // Encoding raw (decoded) content
    let enc_raw = make_encoding_raw(&[
        (ROOT_CKEY, ROOT_EKEY, 1000),
        (CKEY1, EKEY1, PAYLOAD1.len() as u64),
        (CKEY2, EKEY2, 8),
        (CKEY3, [0xB3; 16], 0),
    ]);
    let enc_blte = make_blte(&enc_raw);

    // Root raw (decoded) content — Legacy format (no MFST header)
    // Block 1: FDID 1 (happy) and FDID 2 (CDN-only stub), NoNameHash
    // Block 2: FDID 3 (encrypted), NoNameHash | ENCRYPTED
    let root_raw = make_root_raw(&[
        (
            0x10000000, // NoNameHash
            0xFFFF_FFFF,
            vec![
                (1i32, CKEY1), // FDID 1  (first delta = absolute FDID)
                (0i32, CKEY2), // FDID 2  (prev + 1 + delta = 1 + 1 + 0 = 2)
            ],
        ),
        (
            0x1800_0000, // NoNameHash | ENCRYPTED
            0xFFFF_FFFF,
            vec![(3i32, CKEY3)], // FDID 3
        ),
    ]);
    let root_blte = make_blte(&root_raw);

    // Content file 1 — BLTE payload sits directly at its idx offset
    let payload1_blte = make_blte(PAYLOAD1);

    // Compute offsets in data.000
    let enc_entry_total = 30 + enc_blte.len();
    let root_entry_total = 30 + root_blte.len();

    let enc_offset: u64 = 0;
    let root_offset: u64 = enc_entry_total as u64;
    let content1_offset: u64 = (enc_entry_total + root_entry_total) as u64;
    let cdn_stub_offset: u64 = content1_offset + payload1_blte.len() as u64;

    // Assemble data.000
    let mut data000: Vec<u8> = Vec::new();
    data000.extend_from_slice(&make_data_header(&ENCODING_EKEY, enc_entry_total as u32));
    data000.extend_from_slice(&enc_blte);
    data000.extend_from_slice(&make_data_header(&ROOT_EKEY, root_entry_total as u32));
    data000.extend_from_slice(&root_blte);
    data000.extend_from_slice(&payload1_blte); // BLTE at content1_offset
    data000.extend_from_slice(&[0u8; 8]); // 8-byte CDN-only stub (≥8 so BLTE decoder
                                           // reaches the magic check before truncation)

    // .idx — all entries in a single bucket-0 file
    let idx = make_idx(&[
        (key9(&ENCODING_EKEY), 0, enc_offset, enc_entry_total as u32),
        (key9(&ROOT_EKEY), 0, root_offset, root_entry_total as u32),
        (key9(&EKEY1), 0, content1_offset, payload1_blte.len() as u32),
        (key9(&EKEY2), 0, cdn_stub_offset, 8u32),
        // EKEY3 intentionally absent — extract_one skips encrypted before any read
    ]);

    // Write files
    let data_data = dir.join("Data").join("data");
    std::fs::create_dir_all(&data_data).unwrap();
    std::fs::write(data_data.join("data.000"), &data000).unwrap();
    std::fs::write(data_data.join("0000000001.idx"), &idx).unwrap();

    // Build config
    let cfg_rel = format!(
        "config/{}/{}/{}",
        &BUILD_KEY_HEX[..2],
        &BUILD_KEY_HEX[2..4],
        BUILD_KEY_HEX
    );
    let cfg_path = dir.join("Data").join(&cfg_rel);
    std::fs::create_dir_all(cfg_path.parent().unwrap()).unwrap();
    std::fs::write(
        &cfg_path,
        format!(
            "root = {root}\nencoding = 00000000000000000000000000000000 {enc}\n\
             build-name = test-build\nbuild-uid = wow\nbuild-product = WoW\n",
            root = ROOT_CKEY_HEX,
            enc = ENCODING_EKEY_HEX,
        ),
    )
    .unwrap();

    // .build.info — minimal BPSV with only the columns the parser needs.
    std::fs::write(
        dir.join(".build.info"),
        format!(
            "Branch!STRING:0|Active!DEC:1|Build Key!HEX:16|Version!STRING:0|Product!STRING:0\n\
             eu|1|{}|1.0.0.0|wow\n",
            BUILD_KEY_HEX
        ),
    )
    .unwrap();

    // Empty listfile avoids the community-listfile network download
    let listfile = dir.join("listfile.csv");
    std::fs::write(&listfile, "").unwrap();

    OpenConfig {
        install_dir: dir.to_path_buf(),
        product: Some("wow".into()),
        keyfile: None,
        listfile: Some(listfile),
        output_dir: None,
    }
}

fn base_extract_cfg(output_dir: PathBuf) -> ExtractionConfig {
    ExtractionConfig {
        output_dir,
        locale: 0xFFFF_FFFF, // ALL
        threads: 1,
        verify: false,
        skip_encrypted: true,
        filters: vec![],
        no_metadata: true,
    }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

/// Happy path: FDID 1 extracts successfully; content matches PAYLOAD1.
#[test]
fn synthetic_happy_path() {
    let fix = temp_dir("happy_fix");
    let out = temp_dir("happy_out");

    let open_cfg = build_fixture(&fix);
    let storage = CascStorage::open(&open_cfg).expect("CascStorage::open on synthetic fixture");

    let info = storage.info();
    assert_eq!(info.encoding_entries, 4, "encoding table should have 4 entries");
    assert_eq!(info.root_entries, 3, "root should have 3 FDIDs");

    let stats = extract_all(&storage, &base_extract_cfg(out.clone()), None)
        .expect("extract_all should not error");

    assert_eq!(stats.total, 3);
    assert_eq!(stats.success, 1, "FDID 1 (valid BLTE payload) should succeed");
    assert_eq!(stats.errors, 0, "no hard errors expected");
    assert_eq!(
        stats.skipped, 2,
        "FDID 2 (cdn-only) + FDID 3 (encrypted) both skipped"
    );
    assert_eq!(
        stats.bytes_written,
        PAYLOAD1.len() as u64,
        "bytes_written = len(PAYLOAD1)"
    );

    // Verify the extracted file's content
    let extracted = out.join("unknown").join("1.dat");
    assert!(extracted.exists(), "extracted file must exist at unknown/1.dat");
    assert_eq!(
        std::fs::read(&extracted).unwrap(),
        PAYLOAD1,
        "extracted bytes must match PAYLOAD1"
    );

    let _ = std::fs::remove_dir_all(&fix);
    let _ = std::fs::remove_dir_all(&out);
}

/// CDN-only stub: EKEY2's archive slot contains non-BLTE bytes → `skipped:cdn-only`,
/// not `errors`.
#[test]
fn synthetic_cdn_only_maps_to_skipped() {
    let fix = temp_dir("cdn_fix");
    let out = temp_dir("cdn_out");

    let open_cfg = build_fixture(&fix);
    let storage = CascStorage::open(&open_cfg).expect("CascStorage::open");

    let stats = extract_all(&storage, &base_extract_cfg(out.clone()), None).unwrap();

    // CDN-only detection must increment skipped, never errors
    assert_eq!(stats.errors, 0, "CDN-only stub must not increment errors");
    // skipped includes at least FDID 2 (cdn-only) — FDID 3 (encrypted) also skipped
    assert!(stats.skipped >= 1, "CDN-only stub should increment skipped");

    let _ = std::fs::remove_dir_all(&fix);
    let _ = std::fs::remove_dir_all(&out);
}

/// Encrypted skip: FDID 3 has the ENCRYPTED content flag; with `skip_encrypted=true`
/// it must be skipped without attempting any data read.
#[test]
fn synthetic_encrypted_skip() {
    let fix = temp_dir("enc_fix");
    let out = temp_dir("enc_out");

    let open_cfg = build_fixture(&fix);
    let storage = CascStorage::open(&open_cfg).expect("CascStorage::open");

    let mut cfg = base_extract_cfg(out.clone());
    cfg.skip_encrypted = true;
    let stats = extract_all(&storage, &cfg, None).unwrap();

    assert_eq!(stats.errors, 0);
    // FDID 3 should contribute to skipped
    assert!(
        stats.skipped >= 1,
        "encrypted entry must be skipped with skip_encrypted=true"
    );
    // FDID 3 has no idx entry — if extract_one tried to read it, we'd get a
    // KeyNotFound error and errors would be > 0.
    assert_eq!(stats.errors, 0, "no read should have been attempted for FDID 3");

    let _ = std::fs::remove_dir_all(&fix);
    let _ = std::fs::remove_dir_all(&out);
}
