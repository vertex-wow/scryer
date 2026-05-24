# ADR 002 — Asset Pipeline (BLP, TGA, ImageMagick)

**Status:** Accepted  
**Date:** 2026-05-24

## Context

WoW addons reference textures using two proprietary/legacy formats:

- **BLP** — Blizzard's primary proprietary texture format. Used for all `Interface\...` paths. Requires a custom decoder; not supported by browsers or standard image tools natively.
- **TGA** (Targa) — Used by some older Blizzard textures and many addon-bundled images. Widely supported but not by browsers natively.

The scale of the problem is bounded: a typical addon references **dozens** of unique textures in its XML (verified against the live corpus — even Auctionator at 343 Lua files declares only ~15–24 unique XML texture paths). Total corpus-wide: ~541 TGA + ~179 BLP files across 152 addons. This is not the entire WoW asset library.

Additionally, `dev/assets.sh` already uses GraphicsMagick/ImageMagick as a developer-side tool (SVG→TGA conversion with `-flip`). The question was whether to make this a runtime extension dependency.

## Options Considered

### ImageMagick/GraphicsMagick as runtime dependency
Shell out to `magick convert` or `gm convert` for TGA (and potentially BLP) conversion.

### Pure in-process JS decoders
A pure-JS TGA decoder (~200 lines, zero dependencies) + a pure-JS BLP decoder (e.g., `blp-parser` npm package). Optional user-configured external `blp2png` fallback for exotic BLP variants.

### CGo/native decoder in a Go subprocess
Decode BLP and TGA using Go libraries with optional CGo for maximum coverage.

## Decision

**Pure in-process JS decoders, with optional external fallback for BLP edge cases.**

ImageMagick/GraphicsMagick were rejected as a runtime dependency for two reasons:

1. **ImageMagick does not support BLP natively.** A BLP-specific tool (`blp2png`, `BLPConverter`) would still be required regardless — so ImageMagick adds a dependency without solving the primary format.
2. **Not present on Windows by default.** Most WoW addon developers are on Windows. A "please install ImageMagick" error on first extension activation is a broken experience for the primary audience.

The Go subprocess option (ADR 001) was not adopted, eliminating that path.

## Architecture Adopted

- **TGA:** pure-JS decoder, always available, zero install. Must honor the TGA image-origin/descriptor byte (orientation) — `dev/assets.sh` vertically flips generated TGAs and stores the flip bit; the decoder must read it correctly or textures appear upside-down.
- **BLP:** pure-JS decoder (DXT1/3/5 + uncompressed variants — covers the vast majority of UI textures) as primary. Optional `scryer.blp2pngPath` setting allows a user to point at a `blp2png` binary for exotic variants.
- **Caching:** lazy decode on first reference → PNG written to `.scryer-cache/` (keyed by source path + mtime + size) → served via `webview.asWebviewUri`. Second and subsequent opens are instant.
- **Scope:** decode only textures the previewed addon actually references, not the entire WoW asset library.
- **Retail assets (CASC):** Retail WoW textures are stored in CASC archives, not loose files. The primary source is a user-configured `scryer.extractedAssetsDir` (extracted via WoW.export or CASCExplorer). The install dir is a secondary fallback for Classic/non-CASC installs.

## `dev/assets.sh` stays developer-only

The existing GM/ImageMagick usage in `dev/assets.sh` is correct and stays. It is a contributor-facing build script, not a runtime extension dependency. The distinction is intentional.

## Consequences

- Need to evaluate and pick a pure-JS BLP decoder that covers DXT1/3/5 and uncompressed. Validate against the `_live/Addons` corpus.
- TGA decoder must handle the vertical-flip case explicitly — test against known-good textures from `dev/assets.sh`.
- `.scryer-cache/` must be gitignored (already in `.gitignore` pattern for derived output).
- Atlas textures (`atlas="..."` in XML) require a JSON manifest mapping atlas names to sheet coordinates — this must be extracted from the game and version-tagged. See [plan/003_asset_pipeline.md](../plan/003_asset_pipeline.md) for details.

## References

- [plan/003_asset_pipeline.md](../plan/003_asset_pipeline.md)
- [plan/000_overview.md](../plan/000_overview.md)
- `dev/assets.sh`
