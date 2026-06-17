//! TACT encryption support for BLTE mode-E blocks.
//!
//! Blizzard uses TACT (Trusted Application Content Transfer) to encrypt
//! sensitive game data inside BLTE containers. Each encrypted block carries
//! an encryption header that names the key (a `u64` key name), provides an
//! IV, and identifies the cipher:
//!
//! - **Salsa20** (`S`) - the 16-byte TACT key is doubled to 32 bytes and
//!   used with an 8-byte nonce derived from the IV.
//! - **ARC4** (`A`) - RC4 with the standard WoW 1024-byte keystream skip.
//!
//! Keys are stored in a [`TactKeyStore`](crate::blte::encryption::TactKeyStore) which can be populated from the
//! bundled community-known key list or loaded from a text key file.

use std::collections::HashMap;
use std::path::Path;

use crate::error::{CascError, Result};

// ---------------------------------------------------------------------------
// TactKeyStore
// ---------------------------------------------------------------------------

/// Stores TACT encryption keys (key_name u64 -> 16-byte key value).
pub struct TactKeyStore {
    keys: HashMap<u64, [u8; 16]>,
}

impl Default for TactKeyStore {
    fn default() -> Self {
        Self::new()
    }
}

impl TactKeyStore {
    /// Create an empty key store.
    pub fn new() -> Self {
        Self {
            keys: HashMap::new(),
        }
    }

    /// Load a key store from a text file.
    ///
    /// Format: one key per line as `hex_key_name hex_key_value`.
    /// Lines starting with `#` and blank lines are ignored.
    pub fn load_keyfile(path: &Path) -> Result<Self> {
        let content = std::fs::read_to_string(path)?;
        let mut keys = HashMap::new();

        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }

            let parts: Vec<&str> = trimmed.split_whitespace().collect();
            if parts.len() < 2 {
                return Err(CascError::InvalidFormat(format!(
                    "invalid keyfile line: {}",
                    trimmed
                )));
            }

            let key_name = u64::from_str_radix(parts[0], 16).map_err(|e| {
                CascError::InvalidFormat(format!("invalid key name '{}': {}", parts[0], e))
            })?;

            let key_value = hex_to_key_result(parts[1])?;
            keys.insert(key_name, key_value);
        }

        Ok(Self { keys })
    }

    /// Download the community WoW TACT key list and merge into this store.
    ///
    /// `urls` is tried in order; the first successful fetch wins. The result is
    /// cached at `<output_dir>/.casc-meta/tact-keys.txt`. The cache is invalidated
    /// when `build_key` changes (new game build) or after 7 days. If all URLs fail
    /// and no cached file exists, the store remains empty — callers fall back to CSV.
    pub fn load_community_keys(&mut self, output_dir: &std::path::Path, build_key: &str, urls: &[&str]) {
        const MAX_AGE_SECS: u64 = 7 * 24 * 60 * 60;
        const DEFAULT_URL: &str =
            "https://raw.githubusercontent.com/wowdev/TACTKeys/master/WoW.txt";
        let default_slice: &[&str] = &[DEFAULT_URL];
        let urls = if urls.is_empty() { default_slice } else { urls };

        let cache_path = output_dir.join(".casc-meta").join("tact-keys.txt");
        let build_stamp_path = output_dir.join(".casc-meta").join("tact-keys.build");

        let needs_download = {
            let stored = std::fs::read_to_string(&build_stamp_path).unwrap_or_default();
            if stored.trim() != build_key {
                tracing::info!("tact-keys: build changed, refreshing key cache");
                true
            } else {
                let age = std::fs::metadata(&cache_path)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.elapsed().ok())
                    .unwrap_or(std::time::Duration::MAX);
                age.as_secs() >= MAX_AGE_SECS
            }
        };

        if needs_download {
            if let Some(parent) = cache_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let client = reqwest::blocking::Client::new();
            let mut fetched = false;
            for url in urls {
                match client
                    .get(*url)
                    .header("User-Agent", "scryer-asset-server/0.1")
                    .send()
                    .and_then(|r| r.text())
                {
                    Ok(body) => {
                        let _ = std::fs::write(&cache_path, &body);
                        let _ = std::fs::write(&build_stamp_path, build_key);
                        tracing::info!("tact-keys: downloaded {} bytes from {}", body.len(), url);
                        fetched = true;
                        break;
                    }
                    Err(e) => {
                        tracing::warn!("tact-keys: fetch failed for {} ({}); trying next", url, e);
                    }
                }
            }
            if !fetched {
                tracing::warn!("tact-keys: all URLs failed; using cached file if present");
            }
        }

        match Self::load_keyfile(&cache_path) {
            Ok(ks) => {
                let n = ks.len();
                self.merge(&ks);
                tracing::info!("tact-keys: loaded {} community keys from cache", n);
            }
            Err(e) => tracing::warn!("tact-keys: no usable cache ({}); key store empty", e),
        }
    }

    /// Insert a single key by name and value.
    pub fn insert(&mut self, key_name: u64, key_value: [u8; 16]) {
        self.keys.insert(key_name, key_value);
    }

    /// Merge keys from another store into this one.
    /// Existing keys are overwritten if the other store has the same key name.
    pub fn merge(&mut self, other: &TactKeyStore) {
        for (&name, &value) in &other.keys {
            self.keys.insert(name, value);
        }
    }

    /// Look up a key by name.
    pub fn get(&self, key_name: u64) -> Option<&[u8; 16]> {
        self.keys.get(&key_name)
    }

    /// Return the number of keys in the store.
    pub fn len(&self) -> usize {
        self.keys.len()
    }

    /// Return true if the store contains no keys.
    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }
}

// ---------------------------------------------------------------------------
// Encryption header types
// ---------------------------------------------------------------------------

/// Encryption algorithm used by a BLTE encrypted block.
#[derive(Debug, PartialEq)]
pub enum EncryptionAlgorithm {
    /// Salsa20 stream cipher (mode byte `S`). The 16-byte key is doubled to 32 bytes.
    Salsa20,
    /// ARC4 (RC4) stream cipher with 1024-byte keystream skip (mode byte `A`).
    ARC4,
}

/// Parsed encryption header from a BLTE mode-E block.
#[derive(Debug)]
pub struct EncryptionHeader {
    /// 64-bit key name used to look up the decryption key in the [`TactKeyStore`].
    pub key_name: u64,
    /// Initialization vector for the cipher.
    pub iv: Vec<u8>,
    /// The encryption algorithm used (Salsa20 or ARC4).
    pub algorithm: EncryptionAlgorithm,
}

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------

/// Parse an encryption header from the data following the `E` mode byte.
///
/// Wire format (matches wow.export / TACTLib):
///   key_name_size (u8)  — must be 8
///   key_name      (8 B) — u64 LE TACT key identifier
///   iv_size       (u8)  — typically 4 or 8
///   iv            (iv_size B)
///   enc_type      (u8)  — b'S' Salsa20 / b'A' ARC4
///
/// Returns the parsed header and a slice of the remaining encrypted payload.
pub fn parse_encryption_header(data: &[u8]) -> Result<(EncryptionHeader, &[u8])> {
    if data.is_empty() {
        return Err(CascError::InvalidFormat(
            "encryption header: empty data".into(),
        ));
    }

    let mut pos = 0;

    // key_name_size (u8)
    let key_name_size = data[pos] as usize;
    pos += 1;

    if key_name_size != 8 {
        return Err(CascError::InvalidFormat(format!(
            "encryption header: expected key_name_size 8, got {}",
            key_name_size
        )));
    }

    // key_name (8 bytes, u64 LE)
    if pos + 8 > data.len() {
        return Err(CascError::InvalidFormat(
            "encryption header: truncated key_name".into(),
        ));
    }
    let key_name = u64::from_le_bytes(data[pos..pos + 8].try_into().map_err(|_| {
        CascError::InvalidFormat("encryption header: failed to read key_name".into())
    })?);
    pos += 8;

    // iv_size (u8)
    if pos >= data.len() {
        return Err(CascError::InvalidFormat(
            "encryption header: truncated IV size".into(),
        ));
    }
    let iv_size = data[pos] as usize;
    pos += 1;

    // IV bytes
    if pos + iv_size > data.len() {
        return Err(CascError::InvalidFormat(
            "encryption header: truncated IV".into(),
        ));
    }
    let iv = data[pos..pos + iv_size].to_vec();
    pos += iv_size;

    // encryption_type (u8)
    if pos >= data.len() {
        return Err(CascError::InvalidFormat(
            "encryption header: missing encryption type".into(),
        ));
    }
    let algorithm = match data[pos] {
        b'S' => EncryptionAlgorithm::Salsa20,
        b'A' => EncryptionAlgorithm::ARC4,
        other => {
            return Err(CascError::InvalidFormat(format!(
                "encryption header: unknown algorithm 0x{:02X}",
                other
            )));
        }
    };
    pos += 1;

    Ok((
        EncryptionHeader {
            key_name,
            iv,
            algorithm,
        },
        &data[pos..],
    ))
}

// ---------------------------------------------------------------------------
// ARC4 (RC4 with 1024-byte skip)
// ---------------------------------------------------------------------------

struct Arc4 {
    s: [u8; 256],
    i: u8,
    j: u8,
}

impl Arc4 {
    fn new(key: &[u8]) -> Self {
        let mut s = [0u8; 256];
        for (i, slot) in s.iter_mut().enumerate() {
            *slot = i as u8;
        }
        // KSA requires in-place swaps driven by computed j, so indexing is necessary
        let mut j: u8 = 0;
        #[allow(clippy::needless_range_loop)]
        for i in 0..256 {
            j = j.wrapping_add(s[i]).wrapping_add(key[i % key.len()]);
            s.swap(i, j as usize);
        }
        // WoW-specific: skip first 1024 bytes of keystream
        let mut arc4 = Arc4 { s, i: 0, j: 0 };
        let mut discard = [0u8; 1024];
        arc4.process(&mut discard);
        arc4
    }

    fn process(&mut self, data: &mut [u8]) {
        for byte in data.iter_mut() {
            self.i = self.i.wrapping_add(1);
            self.j = self.j.wrapping_add(self.s[self.i as usize]);
            self.s.swap(self.i as usize, self.j as usize);
            let k =
                self.s[(self.s[self.i as usize].wrapping_add(self.s[self.j as usize])) as usize];
            *byte ^= k;
        }
    }
}

// ---------------------------------------------------------------------------
// Salsa20 decryption helper
// ---------------------------------------------------------------------------

// "expand 16-byte k" — correct constant for 16-byte TACT keys.
// The RustCrypto salsa20 crate only exposes "expand 32-byte k", so we
// implement the required subset inline, exactly as wow.export does.
const SIGMA16: [u32; 4] = [0x6170_7865, 0x3120_646e, 0x7962_2d36, 0x6b20_6574];

#[inline(always)]
fn rotl32(v: u32, n: u32) -> u32 {
    v.rotate_left(n)
}

fn salsa20_block(key: &[u32; 8], nonce: &[u32; 2], counter: u64) -> [u8; 64] {
    let ctr_lo = counter as u32;
    let ctr_hi = (counter >> 32) as u32;

    let (j0, j5, j10, j15) = (SIGMA16[0], SIGMA16[1], SIGMA16[2], SIGMA16[3]);
    let (j1, j2, j3, j4) = (key[0], key[1], key[2], key[3]);
    let (j11, j12, j13, j14) = (key[4], key[5], key[6], key[7]);
    let (j6, j7) = (nonce[0], nonce[1]);
    let (j8, j9) = (ctr_lo, ctr_hi);

    let (mut x0, mut x1, mut x2, mut x3) = (j0, j1, j2, j3);
    let (mut x4, mut x5, mut x6, mut x7) = (j4, j5, j6, j7);
    let (mut x8, mut x9, mut x10, mut x11) = (j8, j9, j10, j11);
    let (mut x12, mut x13, mut x14, mut x15) = (j12, j13, j14, j15);

    for _ in 0..10 {
        // column rounds
        x4  ^= rotl32(x0.wrapping_add(x12), 7);
        x8  ^= rotl32(x4.wrapping_add(x0),  9);
        x12 ^= rotl32(x8.wrapping_add(x4),  13);
        x0  ^= rotl32(x12.wrapping_add(x8), 18);
        x9  ^= rotl32(x5.wrapping_add(x1),  7);
        x13 ^= rotl32(x9.wrapping_add(x5),  9);
        x1  ^= rotl32(x13.wrapping_add(x9), 13);
        x5  ^= rotl32(x1.wrapping_add(x13), 18);
        x14 ^= rotl32(x10.wrapping_add(x6), 7);
        x2  ^= rotl32(x14.wrapping_add(x10),9);
        x6  ^= rotl32(x2.wrapping_add(x14), 13);
        x10 ^= rotl32(x6.wrapping_add(x2),  18);
        x3  ^= rotl32(x15.wrapping_add(x11),7);
        x7  ^= rotl32(x3.wrapping_add(x15), 9);
        x11 ^= rotl32(x7.wrapping_add(x3),  13);
        x15 ^= rotl32(x11.wrapping_add(x7), 18);
        // row rounds
        x1  ^= rotl32(x0.wrapping_add(x3),  7);
        x2  ^= rotl32(x1.wrapping_add(x0),  9);
        x3  ^= rotl32(x2.wrapping_add(x1),  13);
        x0  ^= rotl32(x3.wrapping_add(x2),  18);
        x6  ^= rotl32(x5.wrapping_add(x4),  7);
        x7  ^= rotl32(x6.wrapping_add(x5),  9);
        x4  ^= rotl32(x7.wrapping_add(x6),  13);
        x5  ^= rotl32(x4.wrapping_add(x7),  18);
        x11 ^= rotl32(x10.wrapping_add(x9), 7);
        x8  ^= rotl32(x11.wrapping_add(x10),9);
        x9  ^= rotl32(x8.wrapping_add(x11), 13);
        x10 ^= rotl32(x9.wrapping_add(x8),  18);
        x12 ^= rotl32(x15.wrapping_add(x14),7);
        x13 ^= rotl32(x12.wrapping_add(x15),9);
        x14 ^= rotl32(x13.wrapping_add(x12),13);
        x15 ^= rotl32(x14.wrapping_add(x13),18);
    }

    let words: [u32; 16] = [
        x0.wrapping_add(j0),   x1.wrapping_add(j1),   x2.wrapping_add(j2),   x3.wrapping_add(j3),
        x4.wrapping_add(j4),   x5.wrapping_add(j5),   x6.wrapping_add(j6),   x7.wrapping_add(j7),
        x8.wrapping_add(j8),   x9.wrapping_add(j9),   x10.wrapping_add(j10), x11.wrapping_add(j11),
        x12.wrapping_add(j12), x13.wrapping_add(j13), x14.wrapping_add(j14), x15.wrapping_add(j15),
    ];

    let mut out = [0u8; 64];
    for (i, w) in words.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&w.to_le_bytes());
    }
    out
}

pub(crate) fn decrypt_salsa20(key: &[u8; 16], iv: &[u8], data: &mut [u8]) {
    // Pack 16-byte key into 8 u32 words (doubled: k[0..4] then k[0..4] again).
    let mut kw = [0u32; 8];
    for (i, chunk) in key.chunks(4).enumerate() {
        let w = u32::from_le_bytes(chunk.try_into().unwrap());
        kw[i] = w;
        kw[i + 4] = w;
    }

    // Pad IV to 8-byte nonce.
    let mut nonce_bytes = [0u8; 8];
    let copy_len = iv.len().min(8);
    nonce_bytes[..copy_len].copy_from_slice(&iv[..copy_len]);
    let nw = [
        u32::from_le_bytes(nonce_bytes[0..4].try_into().unwrap()),
        u32::from_le_bytes(nonce_bytes[4..8].try_into().unwrap()),
    ];

    let mut counter: u64 = 0;
    let mut offset = 0;
    while offset < data.len() {
        let block = salsa20_block(&kw, &nw, counter);
        let remaining = data.len() - offset;
        let n = remaining.min(64);
        for i in 0..n {
            data[offset + i] ^= block[i];
        }
        offset += n;
        counter += 1;
    }
}

// ---------------------------------------------------------------------------
// Public decrypt entry point
// ---------------------------------------------------------------------------

/// Decrypt a BLTE mode-E block.
///
/// `data` is everything after the `E` mode byte. `block_index` is the
/// 0-based index of this block within the BLTE container — the IV is XORed
/// with the block index bytes before decryption (matches wow.export/TACTLib).
/// Returns the decrypted payload whose first byte is the inner compression
/// mode (N, Z, 4, etc.).
pub fn decrypt_block(data: &[u8], keystore: &TactKeyStore, block_index: u32) -> Result<Vec<u8>> {
    let (header, encrypted) = parse_encryption_header(data)?;

    tracing::debug!(
        "decrypt_block: key={:016X} iv={} algo={:?} block_index={} encrypted_len={}",
        header.key_name,
        hex::encode(&header.iv),
        header.algorithm,
        block_index,
        encrypted.len()
    );

    let key = keystore
        .get(header.key_name)
        .ok_or_else(|| CascError::EncryptionKeyMissing(format!("0x{:016X}", header.key_name)))?;

    // XOR the IV bytes with the block index (LE), as per wow.export BLTE spec.
    let mut iv = header.iv.clone();
    for (i, byte) in iv.iter_mut().enumerate().take(4) {
        *byte ^= ((block_index >> (i * 8)) & 0xFF) as u8;
    }

    let mut output = encrypted.to_vec();
    match header.algorithm {
        EncryptionAlgorithm::Salsa20 => {
            decrypt_salsa20(key, &iv, &mut output);
        }
        EncryptionAlgorithm::ARC4 => {
            let mut cipher = Arc4::new(key);
            cipher.process(&mut output);
        }
    }

    Ok(output)
}

// ---------------------------------------------------------------------------
// Key parsing helpers
// ---------------------------------------------------------------------------

/// Convert a hex string to a 16-byte key, returning an error on failure.
fn hex_to_key_result(hex_str: &str) -> Result<[u8; 16]> {
    let bytes = hex::decode(hex_str).map_err(|e| {
        CascError::InvalidFormat(format!("invalid hex key value '{}': {}", hex_str, e))
    })?;
    if bytes.len() != 16 {
        return Err(CascError::InvalidFormat(format!(
            "key value must be 16 bytes, got {}",
            bytes.len()
        )));
    }
    let mut key = [0u8; 16];
    key.copy_from_slice(&bytes);
    Ok(key)
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // TactKeyStore tests
    // -----------------------------------------------------------------------

    #[test]
    fn keystore_new_is_empty() {
        let ks = TactKeyStore::new();
        assert!(ks.is_empty());
        assert_eq!(ks.len(), 0);
    }

    #[test]
    fn keystore_get_unknown_returns_none() {
        let ks = TactKeyStore::new();
        assert!(ks.get(0xDEADBEEFCAFEBABE).is_none());
    }

    #[test]
    fn keystore_merge() {
        let mut ks1 = TactKeyStore::new();
        let mut ks2 = TactKeyStore::new();
        ks2.keys.insert(0x1234, [0xAA; 16]);
        ks1.merge(&ks2);
        assert!(ks1.get(0x1234).is_some());
        assert_eq!(ks1.get(0x1234).unwrap(), &[0xAA; 16]);
    }

    #[test]
    fn keystore_load_keyfile() {
        use std::io::Write;

        let dir = std::env::temp_dir().join("casc_test_keyfile");
        std::fs::create_dir_all(&dir).ok();
        let path = dir.join("test.keys");
        let mut f = std::fs::File::create(&path).unwrap();
        writeln!(f, "# Comment line").unwrap();
        writeln!(f, "DEADBEEFCAFEF00D 0102030405060708090A0B0C0D0E0F10").unwrap();
        writeln!(f).unwrap(); // blank line
        writeln!(f, "BEEFDEAD12345678 1112131415161718191A1B1C1D1E1F20").unwrap();
        drop(f);

        let ks = TactKeyStore::load_keyfile(&path).unwrap();
        assert_eq!(ks.len(), 2);
        assert!(ks.get(0xDEADBEEFCAFEF00D).is_some());
        assert!(ks.get(0xBEEFDEAD12345678).is_some());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn keystore_load_keyfile_missing_file_errors() {
        let path = Path::new("nonexistent_keyfile.txt");
        assert!(TactKeyStore::load_keyfile(path).is_err());
    }

    #[test]
    fn keystore_load_keyfile_invalid_hex_errors() {
        use std::io::Write;

        let dir = std::env::temp_dir().join("casc_test_keyfile_bad");
        std::fs::create_dir_all(&dir).ok();
        let path = dir.join("bad.keys");
        let mut f = std::fs::File::create(&path).unwrap();
        writeln!(f, "ZZZZ INVALID_HEX_VALUE_HERE_TOO").unwrap();
        drop(f);

        assert!(TactKeyStore::load_keyfile(&path).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    // -----------------------------------------------------------------------
    // Encryption header parsing tests
    // -----------------------------------------------------------------------

    #[test]
    fn parse_encryption_header_salsa20() {
        let mut data = Vec::new();
        data.push(8u8); // key_name_size = 8
        data.extend_from_slice(&0xDEADBEEFCAFEF00Du64.to_le_bytes());
        data.push(4u8); // iv_size = 4
        data.extend_from_slice(&[0x01, 0x02, 0x03, 0x04]); // IV
        data.push(b'S'); // Salsa20
        data.extend_from_slice(b"encrypted_payload");

        let (header, remaining) = parse_encryption_header(&data).unwrap();
        assert_eq!(header.key_name, 0xDEADBEEFCAFEF00D);
        assert_eq!(header.iv, vec![0x01, 0x02, 0x03, 0x04]);
        assert_eq!(header.algorithm, EncryptionAlgorithm::Salsa20);
        assert_eq!(remaining, b"encrypted_payload");
    }

    #[test]
    fn parse_encryption_header_arc4() {
        let mut data = Vec::new();
        data.push(8u8);
        data.extend_from_slice(&0xDEADBEEFu64.to_le_bytes());
        data.push(4u8);
        data.extend_from_slice(&[0x0A, 0x0B, 0x0C, 0x0D]);
        data.push(b'A'); // ARC4
        data.extend_from_slice(b"payload");

        let (header, remaining) = parse_encryption_header(&data).unwrap();
        assert_eq!(header.algorithm, EncryptionAlgorithm::ARC4);
        assert_eq!(header.key_name, 0xDEADBEEF);
        assert_eq!(remaining, b"payload");
    }

    #[test]
    fn parse_encryption_header_empty_errors() {
        assert!(parse_encryption_header(&[]).is_err());
    }

    #[test]
    fn parse_encryption_header_unknown_algo_errors() {
        let mut data = Vec::new();
        data.push(8u8);
        data.extend_from_slice(&0u64.to_le_bytes());
        data.push(4u8);
        data.extend_from_slice(&[0; 4]);
        data.push(b'X'); // unknown

        assert!(parse_encryption_header(&data).is_err());
    }

    // -----------------------------------------------------------------------
    // ARC4 tests
    // -----------------------------------------------------------------------

    #[test]
    fn arc4_round_trip() {
        let key = b"test_key_16bytes"; // 16 bytes
        let plaintext = b"Hello World! This is a test of ARC4 encryption.";

        let mut encrypted = plaintext.to_vec();
        let mut cipher1 = Arc4::new(key);
        cipher1.process(&mut encrypted);

        // encrypted should differ from plaintext
        assert_ne!(&encrypted[..], &plaintext[..]);

        // Decrypt with fresh cipher
        let mut decrypted = encrypted.clone();
        let mut cipher2 = Arc4::new(key);
        cipher2.process(&mut decrypted);

        assert_eq!(&decrypted[..], &plaintext[..]);
    }

    #[test]
    fn arc4_empty_data() {
        let key = b"some_key_16bytes";
        let mut data = Vec::new();
        let mut cipher = Arc4::new(key);
        cipher.process(&mut data);
        assert!(data.is_empty());
    }

    // -----------------------------------------------------------------------
    // Salsa20 tests
    // -----------------------------------------------------------------------

    #[test]
    fn salsa20_round_trip() {
        let key = [0x42u8; 16];
        let iv = [0x01, 0x02, 0x03, 0x04];
        let plaintext = b"test salsa20 encryption data";

        // Encrypt
        let mut data = plaintext.to_vec();
        decrypt_salsa20(&key, &iv, &mut data);
        assert_ne!(&data[..], &plaintext[..]);

        // Decrypt (XOR is self-inverse with same keystream)
        let mut roundtrip = data.clone();
        decrypt_salsa20(&key, &iv, &mut roundtrip);
        assert_eq!(&roundtrip[..], &plaintext[..]);
    }

    // -----------------------------------------------------------------------
    // Full decrypt_block tests
    // -----------------------------------------------------------------------

    #[test]
    fn decrypt_block_missing_key_errors() {
        let ks = TactKeyStore::new(); // empty - no keys
        let mut data = Vec::new();
        data.push(8u8); // key_name_size
        data.extend_from_slice(&0xDEADBEEFu64.to_le_bytes());
        data.push(4u8); // iv_size
        data.extend_from_slice(&[0; 4]);
        data.push(b'S');
        data.extend_from_slice(b"encrypted");

        let result = decrypt_block(&data, &ks, 0);
        assert!(result.is_err());
        match result.unwrap_err() {
            CascError::EncryptionKeyMissing(_) => {}
            e => panic!("Expected EncryptionKeyMissing, got: {:?}", e),
        }
    }

    fn make_test_keystore() -> (TactKeyStore, u64, [u8; 16]) {
        let key_name: u64 = 0xDEADBEEFCAFEBABE;
        let key_value = [0x42u8; 16];
        let mut ks = TactKeyStore::new();
        ks.keys.insert(key_name, key_value);
        (ks, key_name, key_value)
    }

    #[test]
    fn decrypt_block_salsa20_round_trip() {
        let (ks, key_name, key_value) = make_test_keystore();

        let plaintext = b"Nhello world inner content";
        let iv_bytes = [0x10, 0x20, 0x30, 0x40];

        let mut encrypted_payload = plaintext.to_vec();
        decrypt_salsa20(&key_value, &iv_bytes, &mut encrypted_payload);

        let mut block_data = Vec::new();
        block_data.push(8u8);
        block_data.extend_from_slice(&key_name.to_le_bytes());
        block_data.push(4u8);
        block_data.extend_from_slice(&iv_bytes);
        block_data.push(b'S');
        block_data.extend_from_slice(&encrypted_payload);

        let decrypted = decrypt_block(&block_data, &ks, 0).unwrap();
        assert_eq!(&decrypted[..], &plaintext[..]);
    }

    #[test]
    fn decrypt_block_arc4_round_trip() {
        let (ks, key_name, key_value) = make_test_keystore();

        let plaintext = b"Zcompressed inner data here";

        let mut encrypted_payload = plaintext.to_vec();
        let mut cipher = Arc4::new(&key_value);
        cipher.process(&mut encrypted_payload);

        let mut block_data = Vec::new();
        block_data.push(8u8);
        block_data.extend_from_slice(&key_name.to_le_bytes());
        block_data.push(4u8);
        block_data.extend_from_slice(&[0x01, 0x02, 0x03, 0x04]);
        block_data.push(b'A');
        block_data.extend_from_slice(&encrypted_payload);

        let decrypted = decrypt_block(&block_data, &ks, 0).unwrap();
        assert_eq!(&decrypted[..], &plaintext[..]);
    }

    #[test]
    fn hex_to_key_result_valid() {
        let key = hex_to_key_result("0102030405060708090A0B0C0D0E0F10").unwrap();
        assert_eq!(key.len(), 16);
        assert_eq!(key[0], 0x01);
        assert_eq!(key[15], 0x10);
    }

    #[test]
    fn hex_to_key_result_invalid_hex_errors() {
        assert!(hex_to_key_result("ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ").is_err());
    }

    #[test]
    fn hex_to_key_result_wrong_length_errors() {
        assert!(hex_to_key_result("AABB").is_err());
    }

}
