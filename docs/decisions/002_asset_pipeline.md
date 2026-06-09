# ADR 002 — Asset Pipeline (BLP, TGA, ImageMagick)

**Status:** Accepted — Implemented 2026-05-25  
**Date:** 2026-05-24

## Context

WoW addons reference textures using two proprietary/legacy formats:

- **BLP** — Blizzard's primary proprietary texture format. Used for all `Interface\...` paths. Requires a custom decoder; not supported by browsers or standard image tools natively.
- **TGA** (Targa) — Used by some older Blizzard textures and many addon-bundled images. Widely supported but not by browsers natively.

The scale of the problem is bounded: a typical addon references **dozens** of unique textures in its XML (verified against the live corpus — even Auctionator at 343 Lua files declares only ~15–24 unique XML texture paths). Total corpus-wide: ~541 TGA + ~179 BLP files across 152 addons. This is not the entire WoW asset library.

Additionally, `dev/assets.ts` already uses GraphicsMagick/ImageMagick as a developer-side tool (SVG→TGA conversion with `-flip`). The question was whether to make this a runtime extension dependency.

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

- **BLP:** `js-blp` 1.0.5 (Kruithne, MIT) — pure-JS, handles BLP1 uncompressed + BLP2 DXT1/3/5. Returns RGBA via a Bufo buffer (`bufo.raw`), encoded to PNG via `pngjs` 7.0.0. Optional `scryer.blp2pngPath` setting allows a user to point at a `blp2png` binary for exotic variants (not yet wired — setting exists for future use).
- **TGA:** deferred in M3. Logs a warning and shows a labeled placeholder, advising the user to pre-convert to PNG. The orientation/flip concern (TGA image-origin descriptor byte) must be handled when implemented. See todo.
- **Caching:** lazy decode on first reference → PNG written to `<cacheRoot>/derived/textures/` (keyed by SHA1 of source path + mtime + size) → served via `webview.asWebviewUri`. Raw PNG/TGA files in `<cacheRoot>/source/` are served directly without copying.
- **Cache root:** a unified `cacheRoot` (settable via `scryer.cacheLocation`: `global` / `workspace` / `custom`) holds both raw extracted assets (`source/`) and derived outputs (`derived/`). Default is `globalStorageUri` so the GB-scale asset tree is shared across workspaces.
- **Scope:** decode only textures the previewed addon actually references, not the entire WoW asset library.
- **Retail assets (CASC):** Retail WoW textures are stored in CASC archives, not loose files. The primary source is `<cacheRoot>/source/` (populated by `pnpm run extract` / `dev/extract.ts`). The install dir (`scryer.installDir`) is a secondary fallback for Classic/non-CASC installs.
- **Async flow:** webview renders placeholders immediately, then sends `requestAsset` messages for each unique file path. Extension host resolves asynchronously and responds with `assetResolved { path, uri }`. Webview swaps placeholder for real `background-image` on receipt.

## `dev/assets.ts` stays developer-only

The existing GM/ImageMagick usage in `dev/assets.ts` is correct and stays. It is a contributor-facing build script (`pnpm run assets`), not a runtime extension dependency. The distinction is intentional.

## Consequences

- `js-blp` 1.0.5 was chosen. Validate coverage against the `_live/Addons` corpus; log unsupported variants for CLI fallback.
- TGA decoder deferred. When implemented, must handle the vertical-flip case (TGA image-origin descriptor byte) — `dev/assets.ts` stores flipped TGAs and the flip bit must be respected.
- `.scryer-cache/` is gitignored — used when `scryer.cacheLocation = "workspace"`. Default (`"global"`) routes to `globalStorageUri` outside the workspace tree entirely.
- Atlas textures (`atlas="..."` in XML) require a JSON manifest mapping atlas names to sheet coordinates — this must be extracted from the game and version-tagged. Deferred to M5. See [plan/003_asset_pipeline.md](../plan/003_asset_pipeline.md) for details.

## References

- [plan/003_asset_pipeline.md](../plan/003_asset_pipeline.md)
- [plan/000_overview.md](../plan/000_overview.md)
- `dev/assets.ts`
