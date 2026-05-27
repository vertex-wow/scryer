# Milestone 3 — Asset Pipeline

**Status: ✅ Complete (2026-05-25)** — core BLP + PNG pipeline shipped. TGA decode and atlas manifest deferred; see gaps below.

## Goal

Resolve and load real WoW textures (file path references and atlas names) into the preview, converting proprietary BLP format to PNG with an on-disk cache, falling back to labeled placeholders when assets are unavailable.

## What Was Built

### New files

- `src/assets/resolver.ts` — `normalizePath` + `resolveTexturePath`: backslash→slash, lowercase, multi-dir probe (BLP/TGA/PNG, with and without `Interface/` prefix), memoized, path-traversal safe (`..` rejected).
- `src/assets/blp.ts` — BLP → RGBA via `js-blp` 1.0.5, RGBA → PNG buffer via `pngjs` 7.0.0.
- `src/assets/cache.ts` — SHA1 cache key from path+mtime+size, read/write the configured textures conversion dir (`<cacheRoot>/derived/textures/`).
- `src/assets/index.ts` — `AssetService` class: resolves path → probes disk → decodes BLP → returns abs PNG path. `fromConfig()` reads VSCode settings and resolves the `cacheRoot` (global/workspace/custom) into explicit `sourceDir`, `texturesConvDir`, and `registryDir` paths.
- `src/types/js-blp.d.ts` — TypeScript declarations for the untyped `js-blp` CJS package.
- `test/assets/resolver.test.ts` — 13 tests: normalization, disk probe, traversal guard, memoization.

### Updated files

- `src/panel.ts` — handles `requestAsset` messages, calls `AssetService`, posts `assetResolved { path, uri }`; adds `cacheRoot` to `localResourceRoots`; shares one `AssetService` instance per extension session (singleton — `blizzardFilesEnsured` persists across panel opens); calls `invalidateAfterBlizzardExtraction()` instead of a full cache reset after successful extraction.
- `src/webview/renderer.ts` — texture divs with `tex.file` tagged with `data-asset-path`; atlas textures tagged with `data-atlas-name` (labeled placeholder).
- `src/webview/main.ts` — after render, collects unique `data-asset-path` values, posts `requestAsset`; handles `assetResolved` by applying `background-image` + removing placeholder child.
- `package.json` — `scryer.cacheLocation`, `scryer.cacheDir`, and `scryer.blp2pngPath` settings added.
- `.gitignore` — `.scryer-cache/` added.

### Async asset flow

1. Webview renders with colored placeholders for all `tex.file` textures.
2. Webview sends `requestAsset { path }` for each unique file path.
3. Extension host resolves → decodes if needed → posts `assetResolved { path, uri }`.
4. Webview receives `assetResolved`, swaps placeholder for real `background-image`.

PNG files in `cacheRoot/source/` are served directly (no copy); BLP files are decoded and written to `cacheRoot/derived/textures/`.

## Approach

1. Read WoW install / extracted-assets dir from VSCode settings (mirrors `dev/config.local.sh` `WOW_DIR` pattern).
2. Resolve a texture reference (`Interface\Buttons\UI-Quickslot-Depress`) to a file on disk.
3. Convert BLP→PNG on first use; cache under `<cacheRoot>/derived/textures/`.
4. Serve cached PNG to the webview via `webview.asWebviewUri`.
5. Resolve atlas names via a JSON manifest (name → sheet file + crop rect). _(Deferred — see gaps.)_

## BLP Format Hurdle (Decision)

WoW's proprietary BLP format is not natively decodable by browsers or Node. Three approaches:

| Option                                         | Pros                                                        | Cons                                                           |
| ---------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------- |
| **(a) blp2png CLI**                            | Robust external tool; handles edge cases                    | External binary dep; per-file process spawn; user must install |
| **(b) pure-JS BLP decoder** _(chosen primary)_ | Zero external deps; runs in extension host; no install step | Coverage varies; some BLP variants unsupported                 |
| **(c) WASM decoder**                           | Fast; portable; in-process                                  | Must source/build a reliable one                               |

**Decision: (b) pure-JS BLP decoder as primary.** Package chosen: `js-blp` 1.0.5 (Kruithne, MIT). Decodes BLP1 uncompressed + BLP2 DXT1/3/5. Returns RGBA via a Bufo buffer (`bufo.raw`), encoded to PNG via `pngjs`. Use **(a) blp2png CLI as optional fallback** (user-configured `scryer.blp2pngPath`) for unsupported variants — **not yet wired up** (see gaps).

## Path Resolution

WoW uses two texture file formats — **both must be handled:**

- **BLP** — the primary proprietary format for all Interface textures. Requires BLP decode (see above). **Implemented.**
- **TGA** (Targa) — used by some older textures and many addon-bundled images. **Deferred** — logs a warning, advises pre-converting to PNG. See backlog.

WoW texture paths use backslash separators and typically omit the file extension. Normalize on input:

1. Replace `\` → `/`, lowercase.
2. If path has no extension: try `.blp` first, then `.tga`, then `.png`.
3. Strip leading `Interface/` and probe both with and without the prefix (extractors vary).
4. Search order:
   - `<cacheRoot>/source/` (raw WoW assets extracted by `dev/extract.sh` or similar)
   - `scryer.installDir` loose files (only useful if user has non-CASC Classic)
   - Addon-local relative paths (for addon-bundled textures — common with TGA files)
5. Memoize resolution results (path string → absolute disk path).

**Critical note:** Retail WoW assets (The War Within) live in CASC archives, not loose files. Most users will need to extract assets first. Document this clearly and make it the primary workflow.

## WoW Install Dir Config

VSCode settings contributed via `package.json`:

```jsonc
"scryer.cacheLocation": "global", // "global" (globalStorageUri, default) | "workspace" | "custom"
"scryer.cacheDir": "",            // path when cacheLocation=custom; ignored otherwise
"scryer.installDir": "",          // WoW install dir — Classic loose-file fallback
"scryer.blp2pngPath": ""          // optional: path to blp2png binary (not yet wired)
```

The resolved `cacheRoot` contains:

```
<cacheRoot>/
  source/Interface/...     raw WoW assets (extracted BLP/PNG/TGA/Lua/XML) — expensive to regenerate
  derived/textures/        BLP→PNG conversions — safe to delete, rebuilt on demand
  derived/registry/        parsed Blizzard template registry JSON — safe to delete
```

Default cacheRoot (`"global"`) is `context.globalStorageUri.fsPath`, shared across workspaces so the GB-scale asset tree is not duplicated per project. `"workspace"` uses `.scryer-cache/` inside the workspace folder (gitignored).

## Atlas Textures

**Deferred.** An atlas reference (e.g. `atlas="glues-characterselect-tophud-middle-bg"`) names a region within a sprite sheet. Requirements:

- **Atlas manifest:** JSON mapping `atlasName → { file, x, y, width, height, tilesH, tilesV }`.
- **Source:** extract via tooling and ship as a versioned JSON file (or generate on first use).
- **`useAtlasSize="true"`** → size the rendered frame from the atlas region's width/height.
- **Rendering:** CSS `background-image` + `background-position` + `background-size` for DOM renderer.

Atlas textures currently render as labeled colored placeholders (`[atlas] <name>`). Full implementation depends on M5 (version targets and per-build manifests).

## Extraction Tooling

We do not bundle WoW assets (copyright). `dev/extract.sh` is the primary contributor workflow:

- **`dev/extract.sh`** (shipped 2026-05-26) — reads `WOW_DIR` from `dev/config.local.sh`, accepts `retail`/`classic`/`classic_era` flavor arg, extracts a minimal Interface texture slice into `.wow-assets/` (gitignored).
  - **Retail:** `rustydemon-cli` (Rust CASC extractor); auto-downloads Marlamin community listfile. Outputs BLP — exercises the BLP→PNG decode path.
  - **Classic/Classic Era:** `rsync` from loose `$WOW_DIR/_classic_/Interface/` files.
  - `CASC_TOOL` override in `dev/config.local.sh` for non-PATH installs (e.g. Windows).
- **CASCExplorer** — alternative GUI for browsing and extracting individual files from CASC.
- **WoW.export** (Marlamin) — GUI/CLI alternative that outputs PNG directly; useful if rustydemon-cli is unavailable.

## Local Cache

- Cache root: `<cacheRoot>/derived/textures/` for BLP→PNG conversions; `<cacheRoot>/source/` for raw extracted assets.
- Key: SHA1 of the resolved source path + mtime + size (invalidates on file change).
- File: `<sha1>.png` (decoded/converted texture).
- PNG/TGA/BLP files in `source/` are served directly; only BLP→PNG conversions are written to `derived/textures/`.
- `.scryer-cache/` in the workspace is gitignored (used when `cacheLocation = "workspace"`).

## Fallback

When an asset cannot be resolved or decoded:

- Render a colored placeholder rectangle (color hashed from the path/atlas name).
- Overlay the path as a small label (for identification).
- Log a warning per unresolved path to the VSCode "Scryer" output channel.

## Security

- Reads only from configured dirs + workspace folder; reject path traversal (paths with `..`) outside allowed roots.
- No network requests; all assets are local.
- Webview CSP allows `img-src ${webview.cspSource}` only — all images served via `asWebviewUri`.

## Known Gaps (Deferred)

| Item                              | Notes                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------ |
| TGA decode                        | Logs warning + placeholder. See backlog for implementation plan.               |
| Atlas manifest lookup             | Placeholder. Requires JSON manifest (M5 dependency).                           |
| `scryer.blp2pngPath` CLI fallback | Setting exists, not wired. Needed for exotic BLP variants js-blp can't handle. |

## Dependencies

**M2** (renderer to display assets); benefits from **M5** (per-version install dir and asset manifest).

## Effort

**M** — took ~1 session for BLP + PNG pipeline (within estimate).
