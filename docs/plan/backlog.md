# Backlog — Outstanding Tasks Without a Milestone

Cross-cutting items deferred from completed milestones, or tooling debt that doesn't fit a feature milestone. Review this file at the start of each milestone to see if anything should be scheduled.

---

## CI-safe committed fixtures (deferred from M1)

**Problem:** The live-fixture tests in `test/parser/toc.test.ts` and `test/parser/xml.test.ts` read directly from `_live/Addons/` and skip in CI (`describeIfLive`). Parser correctness against real addon structure is not verified on every push.

**Revised plan:** Use `_reference/wow-cookbook` (our owned, WoW-verified addon examples) instead of generating IR snapshots from `_live/`. Two tiers:

1. **Always-run inline tests** — embed short cookbook XML verbatim as template literals in the test file. No filesystem dependency; CI-safe. Good for ExampleFrameBare, ExampleFrameModalDialog, ExampleControlMoveableFrame (all under ~40 lines). These are already added (see `test/parser/xml.test.ts`).
2. **`describeIfCookbook` tests** — read larger cookbook files from `_reference/wow-cookbook/docs/frames/Addons/` for more thorough integration coverage. Skip gracefully when the symlink is absent (e.g. a fresh clone without the sibling repo). Add as needed when a parser bug is found in a specific cookbook example.

This replaces the generate-fixtures script approach entirely. No derived JSON snapshots to maintain; the cookbook XML is the source of truth.

Note: `_live/` fixture tests remain as-is for testing against Blizzard-internal templates (DefaultPanelTemplate etc.) that the cookbook depends on but doesn't define.

**Effort:** Done — inline fixtures already added alongside the parser gap tests.

---

## `relativeKey` anchor targets unimplemented (deferred from M2)

**Problem:** WoW anchors support `relativeKey="$parent.SomeChild"` — a dotted path resolved from the current frame's parent. The M2 layout engine (`src/webview/layout.ts`) does not implement this; any anchor with a `relativeKey` silently falls back to the viewport rect, producing incorrect positioning for frames that use this pattern.

**Plan:** In `resolveTarget`, add a branch for `anchor.relativeKey`:

1. Parse the key path (split on `.`, expand `$parent` to the actual parent frame name).
2. Walk the frame registry using the expanded path segments.
3. Return the resolved target's rect, or fall back with a logged warning if unresolvable.

**Effort:** S — a few hours. Can be done as a standalone PR before M3 or alongside M3's anchor-target work.

---

## TGA texture decode (deferred from M3)

**Problem:** TGA (Targa) textures are used by many addon-bundled images. M3 logs a warning and shows a labeled placeholder for `.tga` files; it does not decode them.

**Plan:**

1. Pick a pure-JS TGA decoder (e.g. `tga-js` on npm, or a small custom reader — the format is simple: uncompressed or RLE-compressed, fixed header).
2. Decode TGA → RGBA buffer, then encode to PNG via `pngjs` (same pipeline as BLP).
3. **Critical:** respect the TGA image-origin descriptor byte (bit 5 of byte 17). If set, the image data is top-to-bottom; if clear, it is bottom-to-top. `dev/assets.sh` stores TGAs with the flip applied and the bit set correctly — the decoder must read it to avoid upside-down textures.
4. Cache in `.scryer-cache/` using the same SHA1 key scheme as BLP.
5. Add tests against a small known-good TGA fixture (bottom-to-top + top-to-bottom variants).

**Effort:** S — ~2–4 hours once a TGA library is selected.

---

## dev/extract.sh — WoW asset extraction for contributors (deferred from M3)

**Status: Done** (2026-05-26, commit `8667c2f`)

**What was built:** `dev/extract.sh` reads `WOW_DIR` + `WOW_ACCOUNT` from `dev/config.local.sh`, accepts a flavor arg (`retail`/`classic`/`classic_era`), and extracts a minimal Interface texture slice into `.wow-assets/` (gitignored).

- **Retail:** uses `rustydemon-cli` (Rust-based CASC extractor, auto-detected from `PATH` or `CASC_TOOL` override in config). Downloads the Marlamin community listfile automatically. Outputs **BLP files** — these go through the normal BLP→PNG decode path in `AssetService`.
- **Classic/Classic Era:** `rsync` from `$WOW_DIR/_classic_/Interface/` loose files.
- `.wow-assets/` added to `.gitignore`; `dev/config.sh.example` documents `CASC_TOOL` override and the post-extract `scryer.extractedAssetsDir` setting.

**Note:** The original plan described WoW.export (GUI/CLI, outputs PNG). The actual implementation used `rustydemon-cli` instead — a headless CLI better suited for scripted extraction. Because it outputs BLP rather than PNG, it exercises the BLP decode path rather than the PNG direct-serve path, which is fine.

**Effort:** S — within estimate.

---

## In-app asset setup guidance for end users (deferred from M3)

**Problem:** When a user opens a WoW XML file with Scryer and has no `scryer.extractedAssetsDir` configured, all textures show as colored placeholders with no explanation. There is nothing in the UI telling them how to get real textures.

**Plan:**

On first render (or when asset requests return nothing for every texture in the file), show a one-time notification:

```
Scryer: No extracted assets configured.
To see real WoW textures, set scryer.extractedAssetsDir to a folder of
extracted WoW assets (PNG/BLP). [Open Settings] [Learn More]
```

- "Open Settings" → `vscode.commands.executeCommand('workbench.action.openSettings', 'scryer.extractedAssetsDir')`.
- "Learn More" → link to a docs page or the README section on extraction.
- Show once per workspace (persist seen-flag in `context.workspaceState`), not on every open.
- Do not show if `scryer.extractedAssetsDir` is already set.

The output channel already logs per-path warnings; this is a higher-visibility one-time prompt, not a repeated nag.

**Effort:** S — ~1–2 hours. Notification logic in `panel.ts` + `workspaceState` flag.

---

## On-demand texture extraction from the preview (deferred from M3)

**Problem:** When the preview renders a file that references textures not yet in `extractedAssetsDir`, those textures show as colored placeholders. The user must manually run `dev/extract.sh` upfront and know which texture families to extract — there is no way to extract just what a specific file needs, and no automatic trigger from the preview itself.

**Plan:**

Two parts: extend `dev/extract.sh` to accept a list of specific paths, and add an on-demand extraction flow in the extension.

### 1. `dev/extract.sh` — targeted extraction mode

Add a `--paths-file <file>` flag (alongside the existing flavor arg):

```bash
./dev/extract.sh retail --paths-file /tmp/scryer-missing.txt
```

Where `scryer-missing.txt` is a newline-delimited list of WoW-relative texture paths (e.g. `Interface/Buttons/UI-CheckBox-Check.blp`).

- **Retail (rustydemon-cli):** pass each path directly to `rustydemon-cli export` instead of the glob patterns. rustydemon-cli already accepts individual paths; this is a loop over the list.
- **Classic/loose:** convert each path to its absolute source path and `rsync`/`cp` it individually.
- If `--paths-file` is absent, fall back to the existing full-slice glob extraction (no behaviour change for current callers).

### 2. Extension — pool missing textures and invoke extract.sh

The extraction call must be encapsulated in a single function on `AssetService` (e.g. `extractMissing(paths: string[]): Promise<void>`) that takes the texture list and handles everything internally — writing the temp file, spawning the script, and waiting for exit. The rest of the extension only calls this function; it never touches the script directly. This keeps the extraction mechanism swappable: if we later want to call a native API, a different tool, or an in-process CASC reader instead of the shell script, only this one function changes.

In `AssetService._resolve`, when `resolveTexturePath` returns null (asset not found on disk), record the unresolved path in a pending set rather than immediately returning null.

After the render cycle completes (all `requestAsset` messages processed), if the pending set is non-empty:

1. Call `assetService.extractMissing(pendingPaths)`.
2. Inside `extractMissing`: write paths to a temp file, spawn `dev/extract.sh <flavor> --paths-file <tempfile>`, show a VSCode progress notification ("Scryer: extracting N textures…"), and await exit.
3. On return: call `assetService.invalidate()` to clear the resolution memo, then re-send `requestAsset` for the previously-missing paths. Assets that resolved will now load; those that still fail (wrong flavor, not in listfile, etc.) fall back to placeholder as before.
4. Read flavor from a new `scryer.flavor` config (`retail`/`classic`/`classic_era`, default `retail`). Auto-detect script path as `<workspaceFolder>/dev/extract.sh`; skip silently if not found so the extension still works in projects without a `dev/` tree.

**Config additions:**

```jsonc
"scryer.flavor": "retail",           // retail | classic | classic_era
"scryer.extractScriptPath": ""       // default: auto-detected dev/extract.sh
```

**What this replaces:** the existing "In-app asset setup guidance" backlog item becomes less urgent if on-demand extraction works — the user sees real textures on first open rather than a one-time notification.

**Effort:** M — extract.sh changes are S; the extension pooling + spawn + invalidate + retry loop is the bulk of the work.

---

## In-process JavaScript CASC reader (replace extract.sh + rustydemon-cli)

**Problem:** The on-demand extraction flow (see above) depends on `rustydemon-cli` being installed and `dev/config.local.sh` being configured. This is a friction point for end users of the extension — they are addon developers, not tool installers. The extension should be able to read textures directly from the WoW install without any external binary.

**Goal:** Replace the `extractMissing(paths)` internals with a pure-JS CASC reader that reads directly from `scryer.installDir`. The function signature stays identical — only its implementation changes (this is exactly why the function boundary was designed the way it was). End result: install the extension, point `scryer.installDir` at your WoW folder, open an XML file, textures load. No shell script, no rustydemon-cli, no listfile download.

**What changes:**

- `AssetService.extractMissing(paths)` is reimplemented without spawning a subprocess. Given a list of WoW-relative texture paths, it opens the CASC storage at `scryer.installDir`, reads the requested files, writes them into `extractedAssetsDir` (or directly into the cache), and returns.
- `scryer.extractScriptPath` and `scryer.flavor` configs become unnecessary (flavor can be auto-detected from the install's `.build.info`).
- `dev/extract.sh` and `dev/config.local.sh` remain as developer/contributor tooling but the extension no longer requires them.
- The community listfile is no longer needed — CASC file lookup by virtual path is handled internally via the TVFS manifest and encoding tables.

**Reference implementations (all MIT, listed in NOTICE):**

Full source for all of the following is checked into `_reference/` (read-only):

- **wow.export** (Kruithne) — JavaScript GUI that reads WoW CASC archives directly in Node/Electron. Primary reference: same author as `js-blp` (which we already use), so the JS idioms will be familiar. Start here. The MIT license covers direct code integration; the developer has also given their personal blessing, which is a welcome bonus.
- **CascLib** (Ladislav Zezula) — C reference implementation; useful for cross-checking edge cases in encoding/index parsing.
- **SereniaBLPLib** (Xalcon) — C# BLP texture parser; useful reference for DXT decompression edge cases (though js-blp already handles BLP).
- **TACTLib** (Overtools) — C# implementation with good TVFS and static-container coverage.
- **casc-extractor** (Xerrion) — Rust CLI and library; additional reference for archive index and BLTE handling.
- **wowdev.wiki/CASC** — format documentation for CASC, TACT, BLTE, encoding, and TVFS manifest structures.

**Key CASC concepts to implement (in rough dependency order):**

1. Parse `.build.info` / `.product.db` to locate the active build config.
2. Read the build config and CDN config to find the encoding manifest and archive indices.
3. Parse the encoding table (content hash → encoded hash lookup).
4. Parse the root file (TVFS or legacy flat root) to map virtual paths (e.g. `Interface/Buttons/UI-CheckBox-Check.blp`) → content hash.
5. Given a content hash, locate the data in local archive indices and read the BLTE-encoded block.
6. Decompress BLTE (zlib or none) to recover the raw file bytes (BLP in this case).

Retail uses TVFS (introduced in 8.2); Classic uses the older flat-root format. Both must be supported if we want to cover all three flavor targets.

**Effort:** L — CASC is a multi-layer format (build info → encoding → root → index → BLTE). wow.export is a strong prior art reference that de-risks most of the format work, but this is still the largest single item on the backlog.

---

## tsconfig solution-style refactor (IDE tooling debt)

**Problem:** `tsconfig.json` includes a `"references"` entry to `tsconfig.test.json` intending VS Code to use the test config for `test/` files. In practice the language server falls back to the root config, which lacks `types: ["jest","node"]`, so Jest/Node globals appear unresolved in the IDE. No CI impact — typecheck uses `tsconfig.build.json` which excludes test files.

**Fix:** Convert to a solution-style layout:

- Rename current `tsconfig.json` → `tsconfig.src.json` (add `"composite": true`, keep `rootDir: "src"`, no `references`).
- Replace `tsconfig.json` with a solution file: `{ "files": [], "references": [{"path":"./tsconfig.src.json"}, {"path":"./tsconfig.test.json"}] }`.
- Update `tsconfig.test.json` to reference `tsconfig.src.json` instead of `tsconfig.json`.
- Update `tsconfig.build.json`, `package.json` scripts, and any other references to the renamed file.

VS Code reliably picks the correct per-file config in a solution-style layout.

**Effort:** XS — under an hour, mostly renaming and updating references.
