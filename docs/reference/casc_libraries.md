# Reference — CASC Libraries (`_reference/`)

Libraries and tools for reading WoW CASC (Content Addressable Storage Container) archives. All cloned into `_reference/` as read-only reference. All MIT licensed.

See `NOTICE` for the authoritative list of third-party attributions.

---

## CascLib — `_reference/CascLib/`

**Author:** Ladislav Zezula  
**Language:** C/C++  
**Source:** https://github.com/ladislav-zezula/CascLib

The original open-source CASC implementation, maintained since 2014. Covers CASC storage reading, BLTE block decoding, encoding manifests, MNDX/MARR path resolution, and more. Widely treated as the community reference spec for the format. Good to diff against when implementing a new reader.

---

## TACTLib — `_reference/TACTLib/`

**Author:** Overtools team  
**Language:** C# (.NET)  
**Source:** https://github.com/overtools/TACTLib

C# TACT/CASC client library. Particularly strong on TVFS (tree-based virtual filesystem) and static-container (CDN) implementations. Useful reference for understanding the higher-level path resolution layer above raw BLTE decoding.

---

## SereniaBLPLib — `_reference/SereniaBLPLib/`

**Author:** Xalcon (WoW-Tools)  
**Language:** C# (.NET)  
**Source:** https://github.com/WoW-Tools/SereniaBLPLib

BLP texture parser and DXT decompressor. BLP is WoW's primary texture format; this library handles all BLP versions including DXT1/DXT3/DXT5 block compression and uncompressed ARGB. Reference for the BLP decode path in the asset pipeline.

---

## wow.export — `_reference/wow.export/`

**Author:** Kruithne  
**Language:** TypeScript / Electron  
**Source:** https://github.com/Kruithne/wow.export

Full-featured GUI export toolkit for WoW assets. Supports both retail and classic clients, CDN streaming (no local client needed), 3D model preview (M2/WMO), terrain export, sound/video, and DB2 viewer. Batteries-included approach: CASC reading, BLTE decoding, BLP conversion, and atlas manifest generation are all present and integrated. Primary reference for the full extraction pipeline end-to-end.

Permission to reference this code was granted by Kruithne directly (see `docs/reference/wow.extract_code_permission_kruithne_discord_2026-05-25.png`).

---

## casc-extractor — `_reference/casc-extractor/`

**Author:** Xerrion  
**Language:** Rust  
**Source:** https://github.com/Xerrion/casc-extractor

Pure Rust CLI and library for WoW CASC archives. Implements BLTE decoding (plain, zlib, LZ4), TACT stream handling, parallel extraction via rayon, and JSONL/CSV metadata indexing. Crate layout: `casc-lib` (library) and `casc-cli` (CLI). Reference for a clean Rust extraction implementation.
