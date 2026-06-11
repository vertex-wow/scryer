//! TVFS (TACT Virtual File System) manifest parser.
//!
//! TVFS is a binary virtual filesystem manifest stored inside CASC (as a
//! regular CASC file whose CKey appears as `vfs-root` in the build config).
//! It maps virtual file paths directly to 9-byte EKeys, bypassing the
//! community listfile entirely.
//!
//! Available in retail WoW since patch 8.2. Classic WoW uses the legacy root
//! format and does not have a `vfs-root` entry.
//!
//! # Usage
//!
//! ```no_run
//! use casc_lib::tvfs::parser::TvfsManifest;
//!
//! let bytes: Vec<u8> = vec![]; // BLTE-decoded TVFS blob
//! let manifest = TvfsManifest::parse(&bytes)?;
//!
//! if let Some(entry) = manifest.get("interface/buttons/ui-checkbox.blp") {
//!     println!("EKey9: {}", hex::encode(entry.ekey9));
//! }
//! # Ok::<(), casc_lib::error::CascError>(())
//! ```

/// TVFS binary format parser — maps virtual paths to 9-byte EKeys.
pub mod parser;
