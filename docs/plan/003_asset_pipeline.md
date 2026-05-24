# Milestone 3 — Asset Pipeline

## Goal

Resolve and load real WoW textures (file path references and atlas names) into the preview, converting proprietary BLP format to PNG with an on-disk cache, falling back to labeled placeholders when assets are unavailable.

## Approach

1. Read WoW install / extracted-assets dir from VSCode settings (mirrors `dev/config.local.sh` `WOW_DIR` pattern).
2. Resolve a texture reference (`Interface\Buttons\UI-Quickslot-Depress`) to a file on disk.
3. Convert BLP→PNG on first use; cache under `.scryer-cache/`.
4. Serve cached PNG to the webview via `webview.asWebviewUri`.
5. Resolve atlas names via a JSON manifest (name → sheet file + crop rect).

## BLP Format Hurdle (Decision)

WoW's proprietary BLP format is not natively decodable by browsers or Node. Three approaches:

| Option | Pros | Cons |
|--------|------|------|
| **(a) blp2png CLI** | Robust external tool; handles edge cases | External binary dep; per-file process spawn; user must install |
| **(b) pure-JS BLP decoder** *(recommended primary)* | Zero external deps; runs in extension host; no install step | Coverage varies; some BLP variants unsupported |
| **(c) WASM decoder** | Fast; portable; in-process | Must source/build a reliable one |

**Decision: (b) pure-JS BLP decoder as primary** (e.g. `blp-parser` or similar npm package). Decode to RGBA buffer → encode PNG via `pngjs`. Use **(a) blp2png CLI as optional fallback** (user-configured path) for unsupported BLP variants.

## Path Resolution

WoW uses two texture file formats — **both must be handled:**

- **BLP** — the primary proprietary format for all Interface textures. Requires BLP decode (see section above).
- **TGA** (Targa) — used by some older textures and many addon-bundled images. TGA is a widely-supported, simple uncompressed (or RLE-compressed) format. **No special conversion step needed** — decode to RGBA via a JS library (`tga-js` or similar) or serve the raw bytes and let the browser decode it via `<img>`. Much simpler than BLP.

WoW texture paths use backslash separators and typically omit the file extension. Normalize on input:

1. Replace `\` → `/`, lowercase.
2. If path has no extension: try `.blp` first, then `.tga`.
3. If path ends in `.blp` and decode fails: fall back to `.tga` at the same path (some addon mixups).
4. Strip leading `Interface/` and prepend the virtual Interface root.
5. Search order:
   - `scryer.extractedAssetsDir` (loose PNG/BLP/TGA extracted by WoW.export or similar)
   - `scryer.installDir` loose files (only useful if user has non-CASC Classic)
   - Addon-local relative paths (for addon-bundled textures — common with TGA files)
6. Memoize resolution results (path string → absolute disk path).

**Critical note:** Retail WoW assets (The War Within) live in CASC archives, not loose files. Most users will need to extract assets first. Document this clearly and make it the primary workflow.

## WoW Install Dir Config

VSCode settings (contribute via `package.json`):

```jsonc
"scryer.installDir": "",          // e.g. /path/to/World of Warcraft/_retail_
"scryer.extractedAssetsDir": "",  // primary: loose BLP/PNG from WoW.export
"scryer.assetCacheDir": "",       // default: ${workspaceFolder}/.scryer-cache
"scryer.blp2pngPath": ""          // optional: path to blp2png binary
```

This mirrors and extends the `dev/config.local.sh` (`WOW_DIR`, `WOW_ACCOUNT`) convention already established in the repo.

## Atlas Textures

An atlas reference (e.g. `atlas="glues-characterselect-tophud-middle-bg"`) names a region within a sprite sheet. Requirements:

- **Atlas manifest:** JSON mapping `atlasName → { file, x, y, width, height, tilesH, tilesV }`.
- **Source:** extract via tooling (see below) and ship as a versioned JSON file (or generate on first use).
- **`useAtlasSize="true"`** → size the rendered frame from the atlas region's width/height.
- **Rendering:** CSS `background-image` + `background-position` + `background-size` for DOM renderer; direct blit for Canvas renderer.

## Extraction Tooling (Documented, Not Bundled)

We do not bundle WoW assets (copyright). Document the workflow and provide helper scripts:

- **WoW.export** (Marlamin) — GUI/CLI to bulk-extract BLP and atlas data from CASC.
- **CASCExplorer** — browse and extract individual files from CASC storage.
- **Marlamin's community listfile** — maps CASC file IDs to virtual paths (needed for proper resolution).
- Extend `dev/assets.sh` with a documented extraction recipe per game flavor.

## Local Cache

- Cache dir: `.scryer-cache/` (add to `.gitignore` — matches existing conventions).
- Key: SHA1 of the resolved source path + mtime+size (invalidate on change).
- File: `<sha1>.png` (decoded/converted texture).
- Atlas manifest cached per game build version.

## Fallback

When an asset cannot be resolved or decoded:
- Render a colored placeholder rectangle (color hashed from the path/atlas name).
- Overlay the path as a small label (for identification).
- Log a single warning per unresolved path to the VSCode output channel with a "configure scryer.extractedAssetsDir" hint.

## Security

- Reads only from configured dirs + workspace folder; reject path traversal (paths with `..`) outside allowed roots.
- No network requests; all assets are local.
- Webview CSP allows `img-src ${webview.cspSource}` only — all images served via `asWebviewUri`.

## Key Technical Decisions

- **Pure-JS decoder primary** (portability, no install step) with **CLI fallback** (coverage for edge cases).
- **DOM uses CSS sprite cropping** for atlas regions; future Canvas renderer does precise pixel blits.
- **Lazy conversion:** decode BLP → PNG on first request, not upfront. This keeps startup fast for large addons.

## Foreseen Hurdles

- **CASC archives** — the main blocker for most Retail users. Must clearly document that asset extraction is a prerequisite and provide tooling guidance.
- **BLP variant coverage** — DXT1/3/5 are common and well-supported; some older/uncommon variants may fail. The CLI fallback handles these.
- **Atlas manifest accuracy** — atlas regions change between game patches. Manifest needs to be versioned and regenerated per build (tie to M5 version target).
- **Large cache size** — a full Retail Interface extraction can be multi-GB. Cache only on-demand; document cleanup.
- **Alpha handling and `alphaMode` mapping** — especially `ADD` and `MOD` blend modes have no CSS equivalent; DOM renderer approximates; Canvas renderer implements properly.

## Dependencies

**M2** (renderer to display assets); benefits from **M5** (per-version install dir and asset manifest).

## Rough Effort

**M** — 1–2 weeks for file path and BLP pipeline. Could grow toward **L** if building an in-house atlas manifest extractor.
