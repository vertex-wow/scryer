# Backlog — Outstanding Tasks Without a Milestone

Cross-cutting items deferred from completed milestones, or tooling debt that doesn't fit a feature milestone. Review this file at the start of each milestone to see if anything should be scheduled.

---

## Blizzard FrameXML template corpus loading (pre-M4)

**Status: Done** (2026-05-26)

**What was built:**

`src/parser/blizzard-registry.ts` — `loadBlizzardRegistry(addonsDir, registryDir)` scans `Blizzard_SharedXML` and `Blizzard_FrameXML` via their TOC files, following `<Include>` chains to collect all virtual frame definitions into a `Map<string, FrameIR>`. Result is serialised under `<cacheRoot>/derived/registry/` and validated against TOC file mtimes on every call (fast on cache hit: 4 stat/read ops).

`src/parser/collect-textures.ts` — `collectTexturePaths(frames)` walks the resolved frame tree (layers, button textures, children) and returns every distinct `TextureIR.file` path.

`AssetService.loadBlizzardTemplates()` — convenience wrapper that computes the addons dir from `<cacheRoot>/source/Interface/AddOns/` and delegates to `loadBlizzardRegistry`.

`panel.ts` `renderFile` — loads the registry before each `resolveInheritance` call so all Blizzard templates are available, then calls `collectTexturePaths` and pre-queues every texture for `resolveAndSendAsset` so extraction and resolution begins immediately (proactive rather than waiting for per-texture webview requests).

**Discovery strategy:** TOC-driven rather than hand-curated. `Blizzard_SharedXML` and `Blizzard_FrameXML` TOC files enumerate all XML files; the loader follows `<Include>` directives recursively to catch flavour-specific subdirectory files (e.g. `Mainline/SharedUIPanelTemplates.xml`). Missing or unparseable files are silently skipped (handles flavour differences between retail/classic/classic_era extractions).

**Remaining limitation (resolved):** Code-driven templates (`NineSlicePanelTemplate` → `NineSliceCodeTemplate`) had no XML textures; borders were driven entirely by `NineSlicePanelMixin:OnLoad`. This now works: XML script `method="OnLoad"` is emitted as a `HookScript` delegation, so the mixin's `OnLoad` fires at frame creation time. `useParentLevel` z-ordering is also resolved — such frames receive a CSS z-index in the BORDER layer range (28) so parent ARTWORK content renders above them.

**Follow-up fixes (same work session):**

`src/parser/blizzard-registry.ts` — `resolveCI(base, relPath)`: case-insensitive path component matching so TOC/XML path lookups work when `rustydemon-cli` lowercases all output filenames on Linux.

`src/assets/index.ts` — `AssetService.invalidateTextures()`: lighter post-extraction invalidation that clears the resolution memo without resetting `blizzardFilesEnsured` or the registry disk cache, preventing the re-extraction loop triggered when Blizzard files were already present but texture paths still needed resolving.

`src/panel.ts` — `ScryerPanel.extractionTriedPaths`: tracks paths that have already been through an extraction attempt so re-renders triggered by `ensureBlizzardFiles` do not re-queue the same permanently-missing paths on every render cycle.

`src/parser/inherit.ts` — Anonymous frames were being added to the cycle-detection set under the sentinel `"<anonymous>"`, causing any template with unnamed child frames to falsely report circular inheritance. Only named frames can form real cycles; anonymous frames are now excluded from the set entirely.

`src/webview/layout.ts` — `resolveTarget` was treating a missing `relativeTo` as UIParent (viewport) rather than the frame's parent. WoW's convention is that omitting `relativeTo` means "relative to my parent", not UIParent. Fixed to return `parentRect` when `relativeTo` is absent; UIParent is only used when explicitly named.

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

## `relativeKey` anchor targets (deferred from M2)

**Status: Done** (2026-05-26)

**What was built:**

`src/webview/layout.ts` — `resolveTarget` now handles `anchor.relativeKey` before falling through to `relativeTo`. The key expansion mirrors WoW's `$parent`-substitution convention used in frame `name` attributes: `"$parent.MinimalTab"` with parent `"MyFrame"` → `"MyFrameMinimalTab"` (replace `$parent`, strip dots, look up in the name registry). Also fixed: `relativeTo="$parent"` (explicit reference to the parent frame) now correctly returns the parent rect instead of falling back to the viewport.

Three tests added in `test/webview/layout.test.ts`: sibling resolution via `$parent.Key`, unresolvable key falls back to viewport, and `relativeTo="$parent"` equivalence.

---

## TGA texture decode (deferred from M3)

**Problem:** TGA (Targa) textures are used by many addon-bundled images. M3 logs a warning and shows a labeled placeholder for `.tga` files; it does not decode them.

**Plan:**

1. Pick a pure-JS TGA decoder (e.g. `tga-js` on npm, or a small custom reader — the format is simple: uncompressed or RLE-compressed, fixed header).
2. Decode TGA → RGBA buffer, then encode to PNG via `pngjs` (same pipeline as BLP).
3. **Critical:** respect the TGA image-origin descriptor byte (bit 5 of byte 17). If set, the image data is top-to-bottom; if clear, it is bottom-to-top. `dev/assets.sh` stores TGAs with the flip applied and the bit set correctly — the decoder must read it to avoid upside-down textures.
4. Cache in `<cacheRoot>/derived/textures/` using the same SHA1 key scheme as BLP.
5. Add tests against a small known-good TGA fixture (bottom-to-top + top-to-bottom variants).

**Effort:** S — ~2–4 hours once a TGA library is selected.

---

## dev/extract.sh — WoW asset extraction for contributors (deferred from M3)

**Status: Done** (2026-05-26, commit `8667c2f`)

**What was built:** `dev/extract.sh` reads `WOW_DIR` + `WOW_ACCOUNT` from `dev/config.local.sh`, accepts a flavor arg (`retail`/`classic`/`classic_era`), and extracts a minimal Interface texture slice into `.wow-assets/` (gitignored).

- **Retail:** uses `rustydemon-cli` (Rust-based CASC extractor, auto-detected from `PATH` or `CASC_TOOL` override in config). Downloads the Marlamin community listfile automatically. Outputs **BLP files** — these go through the normal BLP→PNG decode path in `AssetService`.
- **Classic/Classic Era:** `rsync` from `$WOW_DIR/_classic_/Interface/` loose files.
- `.wow-assets/` added to `.gitignore`; `dev/config.sh.example` documents `CASC_TOOL` override and the post-extract `scryer.cacheDir` / `scryer.cacheLocation` settings.

**Note:** The original plan described WoW.export (GUI/CLI, outputs PNG). The actual implementation used `rustydemon-cli` instead — a headless CLI better suited for scripted extraction. Because it outputs BLP rather than PNG, it exercises the BLP decode path rather than the PNG direct-serve path, which is fine.

**Effort:** S — within estimate.

---

## In-app asset setup guidance for end users (deferred from M3)

**Problem:** When a user opens a WoW XML file with Scryer and has no extracted assets in the cacheRoot, all textures show as colored placeholders with no explanation. There is nothing in the UI telling them how to get real textures.

**Plan:**

On first render (or when asset requests return nothing for every texture in the file), show a one-time notification:

```
Scryer: No extracted assets found.
To see real WoW textures, run dev/extract.sh to populate the asset cache,
or configure scryer.cacheLocation / scryer.cacheDir. [Open Settings] [Learn More]
```

- "Open Settings" → `vscode.commands.executeCommand('workbench.action.openSettings', 'scryer.cacheLocation')`.
- "Learn More" → link to a docs page or the README section on extraction.
- Show once per workspace (persist seen-flag in `context.workspaceState`), not on every open.
- Do not show if `<cacheRoot>/source/Interface/` is already populated.

The output channel already logs per-path warnings; this is a higher-visibility one-time prompt, not a repeated nag.

**Effort:** S — ~1–2 hours. Notification logic in `panel.ts` + `workspaceState` flag.

---

## On-demand texture extraction from the preview (deferred from M3)

**Status: Done** (2026-05-26)

**What was built:**

`dev/extract.sh` now accepts `--paths-file <file>` as a second argument alongside the flavor:

```bash
./dev/extract.sh retail --paths-file /tmp/scryer-missing.txt
```

`scryer-missing.txt` is a newline-delimited list of WoW-relative texture paths. Retail loops each path through `rustydemon-cli export` individually. Classic uses `find -ipath` + `cp` to handle filesystem case differences. Full-slice extraction (no `--paths-file`) is unchanged.

The extension side (`AssetService.extractMissing(paths)`) writes the temp file, spawns the script with a VSCode progress notification, and awaits exit. `ScryerPanel` debounces unresolved `requestAsset` messages (300 ms), calls `extractMissing`, invalidates the resolver memo, then re-fires resolution for each missing path. A `retryInProgress` flag prevents the retry pass from scheduling another extraction loop on still-missing assets.

Config additions: `scryer.flavor` (`retail`/`classic`/`classic_era`, default `retail`) and `scryer.extractScriptPath` (empty = auto-detect `<wsFolder>/dev/extract.sh`). Extension skips extraction silently if the script is not found.

**Effort:** M — within estimate.

---

## In-process JavaScript CASC reader (replace extract.sh + rustydemon-cli)

**Problem:** The on-demand extraction flow (see above) depends on `rustydemon-cli` being installed and `dev/config.local.sh` being configured. This is a friction point for end users of the extension — they are addon developers, not tool installers. The extension should be able to read textures directly from the WoW install without any external binary.

**Goal:** Replace the `extractMissing(paths)` internals with a pure-JS CASC reader that reads directly from `scryer.installDir`. The function signature stays identical — only its implementation changes (this is exactly why the function boundary was designed the way it was). End result: install the extension, point `scryer.installDir` at your WoW folder, open an XML file, textures load. No shell script, no rustydemon-cli, no listfile download.

**What changes:**

- `AssetService.extractMissing(paths)` is reimplemented without spawning a subprocess. Given a list of WoW-relative texture paths, it opens the CASC storage at `scryer.installDir`, reads the requested files, writes them into `<cacheRoot>/source/`, and returns.
- `scryer.extractScriptPath` and `scryer.flavor` configs become unnecessary (flavor can be auto-detected from the install's `.build.info`).
- `dev/extract.sh` and `dev/config.local.sh` remain as developer/contributor tooling but the extension no longer requires them.
- The community listfile is no longer needed — CASC file lookup by virtual path is handled internally via the TVFS manifest and encoding tables.

**Reference implementations (all MIT, listed in NOTICE):**

Full source for all of the following is checked into `_reference/` (read-only):

- **wow.export** (Kruithne) — JavaScript GUI that reads WoW CASC archives directly in Node/Electron. Primary reference: same author as `js-blp` (which we already use), so the JS idioms will be familiar. Start here. The MIT license covers direct code integration; the developer has also given their personal blessing, which is a welcome bonus (see [`docs/reference/wow.extract_code_permission_kruithne_discord_2026-05-25.png`](../reference/wow.extract_code_permission_kruithne_discord_2026-05-25.png)).
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

## Extract Blizzard Interface addon files from user's WoW installation

**Status: Done** (2026-05-26)

**What was built:** `dev/extract.sh` now accepts `--type textures|interface|all` (default: `textures`):

```
./dev/extract.sh retail --type textures   # current behaviour (default)
./dev/extract.sh retail --type interface  # new: extracts Interface/AddOns/**
./dev/extract.sh retail --type all        # both
```

- **Retail (CASC):** `--type interface` passes `Interface/AddOns/Blizzard_SharedXML/**` and `Interface/AddOns/Blizzard_FrameXML/**` to `rustydemon-cli`. `.lua`/`.xml`/`.toc` files extract identically to textures.
- **Classic / Classic Era (loose files):** The rsync call gains `--include=*.lua`, `--include=*.xml`, `--include=*.toc` filter when `--type interface` or `--type all` is active.
- Output: `.wow-assets/Interface/AddOns/<AddonName>/` — matching the WoW install layout, same output root as textures.
- `--paths-file` is unaffected (targeted mode ignores `--type`).

**Note:** This unblocks the `Blizzard FrameXML template corpus loading` item — the XML files are now available at `.wow-assets/Interface/AddOns/`. Long-term, once the in-process CASC reader lands, this extraction can happen on demand automatically.

---

## Extraction benchmarks

**Status: Done** (2026-05-27)

**What was built:**

`dev/bench.ts` — benchmark script run via `pnpm bench`. Three scenarios timed at N = {1, 2, 5, 10, 50, 100} concurrent requests, 5 runs each:

1. **Texture-only** — BLP decode + PNG compression + cache write for N paths (calls `blpToPng` + `writeCached` directly, no vscode dependency).
2. **Addon-only** — `fs.promises.readFile` for N XML/Lua/TOC files (I/O-only path).
3. **Combined** — ceil(N/2) texture + floor(N/2) addon in parallel.

N is clamped to available fixtures (no cycling). When fewer fixtures are on disk than N requests, the output notes the cap. Run `dev/extract.sh retail --type all` for a full corpus that reaches N=100 uncapped.

`dev/bench.build.mjs` — esbuild config that bundles `bench.ts` into `dist/bench.js` (same settings as the extension host: CJS, Node platform, vscode external). `pnpm bench` builds then runs.

`dev/bench-results.json` — gitignored; written after each run with metadata (date, Node version, platform, fixture counts) and per-scenario results (min/median/p95/max for each N).

**Key findings from initial baseline (11 BLP fixtures, 228 addon files):**

- Addon file reads are negligible: 0–22 ms for N=1–100 (I/O is not the bottleneck).
- BLP decode dominates: N=11 including `ui-background-rock.blp` (514 KB, ~1024×1024) ~4 s. Split timers revealed `js-blp.getPixels` is **44× slower than `PNG.sync.write`** — the bottleneck is DXT decompression, not PNG encoding.
- Combined cost tracks texture decode; addon reads are effectively free alongside it.
- **CASC open cost:** `rustydemon-cli` listfile load is CPU-bound at ~25–33 s per invocation (2.17M entries). Per-file invocation is completely impractical — 102 textures × 28 s = 47 minutes of overhead.
- **Implication:** BLP DXT decompression (not PNG compression) is the main cost. Batch all extraction into a single CASC open. See `docs/measurements.md` for full corpus measurements (2026-05-27).

---

## Listfile pre-filter (rustydemon era)

**Status: ✅ Done** (2026-05-28)

**Problem:** `rustydemon-cli` reads the full community listfile CSV (2,172,924 entries, 140 MB) on every process launch and parses it internally — costing ~25–33 s CPU per invocation. We cannot change this; it is a fixed cost of the external binary. However, we control which file we pass via `-l`. The listfile contains entries for every WoW asset type (sounds, models, maps, etc.); only 169,862 entries (7.8%) start with `interface/`. The other 92% are irrelevant to Scryer and slow `rustydemon-cli` down for no benefit.

**What was built:**

`src/assets/extract-core.ts` — two new functions:

- `filterListfile` (private) — spawns `grep -F ';interface/'` and pipes stdout to `listfile-interface.csv`. Benchmarked at ~110–118 ms from Node.js.
- `ensureFilteredListfile` (exported) — calls `ensureListfile` to guarantee the full CSV exists, then skips re-filtering if `listfile-interface.csv` is already at least as new as `listfile.csv` (mtime comparison). Only re-filters after a fresh download.

`extractRetailPaths` and `extractRetailBulk` now pass `listfile-interface.csv` to rustydemon-cli instead of the full 140 MB file. `ensureListfile` is unchanged — `atlas-gen.ts` still receives the full file for FileDataID lookups across all asset types.

**Measured win:** Reduces input from 2.17 M to 169 K rows (~12×). `rustydemon-cli`'s internal parse time expected to drop from ~25–33 s to ~2–3 s.

See [measurements.md Q1b](../measurements.md#q1b-how-fast-can-we-pre-filter-listfilecsv-to-interface-only-entries) for the full benchmark comparing grep, xan, xsv, qsv, and Node.js stream approaches.

---

## Filtered listfile build-version stamping

**Status: 📋 Pending**

**Background:** `ensureFilteredListfile` (added in the Listfile pre-filter item) runs `grep -F ';interface/'` to produce `listfile-interface.csv` whenever `listfile.csv` is newer. This pays the grep cost once per download, which is ~110 ms and already cheap. However, the validity of the filtered file is coupled only to file mtimes — if `listfile.csv` is re-downloaded for any reason (manual refresh, future CDN change, migration to per-release URLs), the filter re-runs unnecessarily even when the underlying WoW build is identical.

The official community listfile from [wowdev/wow-listfile](https://github.com/wowdev/wow-listfile) publishes per-release verified files tied to specific WoW build numbers. Our cached filtered file should match that granularity: one filtered file per WoW build, reused across all listfile re-downloads for that build.

**Problem:** The mtime-based skip logic in `ensureFilteredListfile` does not know what WoW build the filtered file was generated for. A listfile re-download (e.g. after switching to GitHub release URLs) triggers a re-filter even if the game data hasn't changed.

**Goal:** Tie the filtered listfile cache to the WoW build number read from `.build.info` so the filter cost is paid exactly once per patch cycle — not once per download.

**Plan:**

1. After filtering, write a stamp file alongside `listfile-interface.csv` (e.g. `listfile-interface.stamp`) containing the current flavor build text (from `readBuildText`).
2. In `ensureFilteredListfile`: read the stamp; if the stamp matches the current build text and `listfile-interface.csv` exists, skip filtering regardless of `listfile.csv` mtime.
3. If `scryer.installDir` is unset (no `.build.info` to read), fall back to the existing mtime check — no regression for users without a configured install.
4. Update `ensureFilteredListfile`'s signature to accept an optional `buildText?: string` so callers can pass the already-read build text without an extra disk read.

**Interaction with [[listfile-source-and-capitalization-strategy]]:** Once the download URL is switched to per-release GitHub release assets, the URL itself carries build identity. The stamp approach works regardless — it decouples filter-cache validity from download frequency.

**Interaction with [[in-process-javascript-casc-reader]]:** When the in-process reader lands, it will need to load the listfile for virtual path → FileDataID resolution. The build-stamped filtered file is the natural input: small, pre-filtered, already invalidated on patch.

**Effort:** XS — ~30 lines in `extract-core.ts` (stamp read/write + build-text comparison). No new dependencies.

---

## Listfile source and capitalization strategy

**Status: 📋 Pending**

**Background:** We currently download the community listfile CSV from a hardcoded URL. The canonical source is [wowdev/wow-listfile](https://github.com/wowdev/wow-listfile), which publishes versioned GitHub releases containing two variants:

- `community-listfile.csv` — standard community list (what we use today, all lowercase)
- `community-listfile-withcapitalization.csv` — same file IDs, but path strings use the capitalization from WoW's virtual filesystem (e.g. `Interface/Buttons/UI-CheckBox-Check.blp` rather than `interface/buttons/ui-checkbox-check.blp`)

The verified listfile (published per-release) contains only paths confirmed to exist in actual CASC data, maximising hit rate vs. the full community list.

**Problems to solve:**

1. **Source URL** — we should download from a release asset URL rather than an ad-hoc hardcoded link. GitHub releases are versioned and stable; we can detect when a newer release is available and re-download.

2. **Capitalization** — `rustydemon-cli` lowercases all output filenames on Linux. Our `resolveCI` workaround exists precisely because the listfile (lowercase) and the filesystem paths diverge. Two strategies:
   - **Keep lowercase** — download `community-listfile.csv`, keep `resolveCI` case-insensitive matching. Current approach; works but `resolveCI` is a performance cost and a source of subtle bugs.
   - **Use capitalized** — download `community-listfile-withcapitalization.csv`, store extracted files under their canonical WoW names, remove or simplify `resolveCI`. Cleaner long-term; requires ensuring extraction writes files at the capitalized path.

3. **Verified vs. full community** — the verified listfile is a strict subset (only real paths). Using it reduces parse time and raises the hit rate on actual lookups. Downside: it may lag slightly behind new game patches before community verification catches up. Evaluate whether the lag matters in practice.

**Plan:**

1. In `src/assets/extract-core.ts` → `ensureListfile`: switch the download URL to the latest GitHub release of `wowdev/wow-listfile`. Consider using the GitHub releases API (`/repos/wowdev/wow-listfile/releases/latest`) to discover the URL dynamically so we do not need to update the code after every release.
2. Decide capitalization strategy. Recommended: capitalized (matches WoW canonical paths, simplifies `resolveCI`). If chosen, update `extractRetailPaths` / `extractRetailBulk` to pass the capitalized listfile, and audit `resolveCI` callers.
3. Update `ensureFilteredListfile` to produce a filtered version of whichever variant is chosen.
4. Write a short ADR documenting the listfile source choice and capitalization decision.

**Effort:** XS (URL change only); S (URL change + capitalization switch + resolveCI audit).

**See also:** [Listfile fast index](#listfile-fast-index-in-process--post-rustydemon-era) — once a fast index exists, apply the same source/capitalization choice to the index builder.

---

## Listfile fast index (in-process / post-rustydemon era)

**Status: 📋 Pending**

**Prerequisite:** [In-process CASC reader](#in-process-javascript-casc-reader-replace-extractsh--rustydemon-cli) (or at minimum, a Node.js-native extraction path that doesn't call `rustydemon-cli`).

**Problem:** Once `rustydemon-cli` is gone, the community listfile is only needed by `atlas-gen.ts` (FileDataID → `Interface/` path join for the atlas manifest). That consumer reads the entire CSV as a full linear scan — currently ~837 ms in-process for 169 K pre-filtered rows, or several seconds for the full 2.17 M row file. This is acceptable today (atlas gen runs rarely), but becomes a regression if the manifest needs regenerating after every game patch.

**Goal:** Convert the CSV to a binary index on first use — either SQLite or a lightweight flat binary format — so that FileDataID lookups are sub-millisecond point queries rather than a full scan.

**Options to evaluate:**

1. **SQLite** (`better-sqlite3` or the built-in `node:sqlite` module added in Node 22.5) — `SELECT path FROM listfile WHERE id = ?` is sub-millisecond after the first open. Widely understood, easy to inspect. Adds a native or pure-JS dependency.
2. **Flat binary hash map** — sorted `(u32 id, u32 offset)` index + packed string table. Pure JS, zero deps, ~5–10 ms read overhead. More implementation work than SQLite.

**Scope note:** The listfile becomes fully unnecessary once [Atlas manifest from DB2](#atlas-manifest-from-db2-replace-wagotools) lands (DB2 files carry FileDataIDs natively). If that item lands before this one, skip this entirely.

See [measurements.md Q1b](../measurements.md#q1b-how-fast-can-we-pre-filter-listfilecsv-to-interface-only-entries) for the full benchmark that covers SQLite virtual table extensions (sqlite-xsv, sqlean vsv), INSERT+SELECT approaches (node:sqlite, better-sqlite3, @libsql/client), and the baseline Node.js stream approach — these are the starting points for evaluating the write-once/point-lookup pattern.

**Effort:** S (SQLite); M (custom binary format).

---

## WoW build version tracking and cache invalidation

**Status: Done** (2026-05-27)

**What was built:**

`src/assets/build-info.ts` — pure-fs module exporting `FLAVOR_INFO` (flavor → `{ product, subdir }` map), `parseBuildInfo` (pipe-delimited `.build.info` parser accepting `Version` or `BuildText` column), `readBuildText`, `readBuildStamp`, `writeBuildStamp`, `clearFlavorCache`, and `flavorSubdir`/`flavorProduct` helpers.

**Cache layout changed to per-flavor:** `<cacheRoot>/<flavor>/source/`, `<cacheRoot>/<flavor>/derived/textures/`, `<cacheRoot>/<flavor>/derived/registry/`. This ensures retail and classic caches are fully isolated — a retail patch wipes only `<cacheRoot>/retail/` and leaves classic untouched.

**`AssetService.checkBuildVersion()`** — called synchronously at startup in `extension.ts` before the prewarm block. Reads `.build.info` from `scryer.installDir`, compares `BuildText` for the configured flavor against `<cacheRoot>/<flavor>/.build-stamp`. On mismatch: deletes the flavor cache subtree, calls `invalidate()`, logs to the output channel. No-op when `installDir` is unset or `.build.info` is unreadable (no cache wipe on uncertainty).

**Stamp written after extraction** — `writeBuildStampIfConfigured()` called after `extractMissing` and `ensureBlizzardFiles` succeed.

**`scryer.installDir` is now the WoW root** (not the flavor subdir). `fromConfig` derives `installFlavorDir = path.join(installDir, flavorSubdir(flavor))` for loose-file searches and webview resource roots. `scryer.cascToolPath` setting added for pinning the CASC tool binary.

**`dev/extract.sh`** now accepts `--wow-dir <path>` and `--casc-tool <path>`, making `config.local.sh` optional when called from the extension. `dev/config.sh.example` and `dev/config.local.sh` updated with header comments listing which scripts still require the config file (`links.sh`).

**Tests:** `test/assets/build-info.test.ts` — 27 tests covering parser edge cases, round-trip stamp read/write, per-flavor isolation, and null-safety.

---

## Preload workspace textures at startup

**Problem:** When a WoW XML file is first opened, textures are resolved and decoded on-demand as the webview requests them. This means the first render is slow — each texture causes a round-trip from webview → extension → disk/cache → decode → response before it appears.

**Goal:** Scan `<cacheRoot>/source/` at extension startup and pre-warm the asset cache so textures are already decoded when the first preview renders.

**Plan:**

1. At extension activation, glob `<cacheRoot>/source/` for all BLP and TGA files (PNG files are already fast, but can be indexed too).
2. Decode each file through the existing `AssetService` pipeline (BLP→PNG, TGA→PNG) and populate the in-memory cache.
3. Run this preload in the background (don't block activation); use a VSCode progress notification or output channel message to indicate it is happening.
4. Limit concurrency to avoid pegging the CPU (e.g. a queue of 4–8 parallel decode workers).
5. Persist the decoded PNG bytes to `<cacheRoot>/derived/textures/` (already done per-file on first decode) so subsequent sessions benefit from disk cache even without a full re-scan.

**Stretch:** Watch `<cacheRoot>/source/` for new files (VSCode `FileSystemWatcher`) and decode them as they arrive, so a fresh extraction populates the cache incrementally.

**Effort:** S — the decode pipeline already exists; this is parallelizing it over a directory listing at startup. The main complexity is worker concurrency and not blocking the extension host.

---

## Preload settings — `scryer.startupContent` + `scryer.userAddonPreload`

**Status: Settings contributed** (2026-05-27) — `package.json` contributions added; implementation pending.

**Supersedes:** The earlier single-setting `scryer.preloadScope` design. That design conflated two orthogonal axes (static Blizzard library scope vs. dynamic per-edit addon scope) into one enum, making it impossible to express e.g. "all Blizz templates but on-demand for my addon."

---

### `scryer.startupContent` (default `"none"`)

Controls what Blizzard template and asset content Scryer loads when the extension activates. This is a static, one-time load at startup — the Blizzard corpus is shared across all previews.

| Value                             | Behavior                                                |
| --------------------------------- | ------------------------------------------------------- |
| `"none"`                          | Nothing preloaded (default)                             |
| `"shared-templates"`              | Preload `Blizzard_SharedXML` template definitions       |
| `"all-templates"`                 | Preload all Blizzard addon template definitions         |
| `"all-templates-shared-textures"` | All templates + textures from `Blizzard_SharedXML` only |
| `"all-templates-textures"`        | All templates + all Blizzard textures                   |

**Implementation notes:**

- Template tiers read from `<cacheRoot>/source/Interface/AddOns/`. Texture tiers additionally require BLP decode + cache write to `derived/textures/`.
- If a texture-bearing tier is selected but `<cacheRoot>/source/` is unpopulated, degrade to the templates-only tier with a warning rather than failing silently.
- The "+textures" tiers can be thousands of files. Run in the background worker pool (see [[preload-workspace-textures]]) with a progress notification; never block activation.

---

### `scryer.userAddonPreload` (default `"on-demand"`)

Controls how eagerly Scryer pre-warms texture assets for the addon currently being previewed. This is a dynamic, per-session scope that runs continuously as the user edits.

| Value            | Behavior                                                              |
| ---------------- | --------------------------------------------------------------------- |
| `"on-demand"`    | Decode textures only when the webview requests them (current default) |
| `"saved-file"`   | Pre-warm textures referenced by the currently saved file              |
| `"current-file"` | Pre-warm textures for the current file including unsaved edits        |
| `"workspace"`    | Pre-warm textures for all WoW XML files in the workspace              |

**Implementation notes:**

- `"saved-file"` and `"current-file"` require parsing the active file to collect texture paths before decoding — use `collectAddonTexturePaths` from `src/parser/addon-textures.ts`.
- `"current-file"` means the buffer contents, not the disk file — needs access to the VS Code `TextDocument` active content.
- `"workspace"` scope is the most expensive: all XML files in the workspace are scanned. Limit concurrency and run in the background.

---

**Effort (implementation):** S — worker pool + concurrency exist via [[preload-workspace-textures]]; these are scope gates on top of that work. `"current-file"` (unsaved-buffer scan) is the only novel path.

---

### Progressive tier execution for `scryer.startupContent`

**Status: Done** (2026-05-27)

**What was built:**

`src/extension.ts` — Replaced the `if/else if` texture prewarm with a staged pipeline. A `TIER_ORDER` constant maps tier names to their rank so `tierIdx >= TIER_ORDER.indexOf("all-templates-shared-textures")` drives each guard. A `cancelled` flag is registered in `context.subscriptions` so extension deactivation aborts remaining stages cleanly. Stage completions are logged to the Scryer output channel.

**Template loading is a single step** (not progressively separated) because there are only two addons (`Blizzard_SharedXML`, `Blizzard_FrameXML`) and the disk cache makes the shared-vs-all difference well under 0.5 s. Panels also need the full ALL registry — pre-warming only the SHARED cache gives them no benefit at panel-open time.

**Texture prewarm is split:** shared textures complete before FrameXML textures begin. BLP→PNG conversion for FrameXML textures can take several seconds; completing shared textures first means the first panel open that relies only on shared templates gets fast texture serving while FrameXML conversion still runs in the background. When `all-templates-textures` is configured, the second `prewarmBlizzardTextures(ADDON_NAMES)` call re-encounters shared texture paths, but they are already PNG-cached on disk so each is a fast file-existence hit rather than a BLP decode.

---

## Output channel logging

**Status: Done** (2026-05-26, revised 2026-05-29)

**What was built:**

`src/parser/inherit.ts` — `resolveInheritance` now accepts an options object `{ warnings?, pending?, warn? }` as its third parameter (replaces the old positional `warnings` + `pending` args). All `console.warn`/`console.log` calls removed; messages are routed through the optional `warn?: (msg: string) => void` callback instead. This keeps `inherit.ts` a pure module with no VSCode dependency and makes it fully testable without mocking.

`src/panel.ts` and `src/assets/` — Use `vscode.LogOutputChannel` (`createOutputChannel("Scryer", { log: true })`). All output calls use the typed channel methods (`output.warn`, `output.debug`, `output.error`, `output.trace`) unconditionally. Users control verbosity via VS Code's built-in log level selector in the Output panel.

No `scryer.logLevel` setting is exposed — `LogOutputChannel.logLevel` is read-only and cannot be set programmatically, so a custom setting would have no effect on what the channel actually displays.

`test/parser/inherit.test.ts` — "unknown template" tests updated to use the new options-object API and assert on the warn callback messages rather than console spies.

---

## Direct proprietary texture serving in the webview (BLP/TGA decode bypass)

**Status: Pending exploration**

**Context:** All textures currently go through a conversion pipeline (BLP→PNG or TGA→PNG) in the extension host before being served to the webview as `asset://` URIs. The benchmark showed that PNG _compression_ of large textures dominates decode cost (~4 s for a 1024×1024 DXT texture). This raises the question: could WoW's proprietary formats be served to the webview more directly, bypassing or deferring the compression step?

**Hypothesis:** Browsers have no native BLP support, so serving `.blp` files directly to an `<img>` tag is not possible. The real question is whether we can avoid PNG _compression_ specifically — not whether we can avoid decoding. Several approaches are worth evaluating before assuming the current pipeline is optimal:

1. **Raw RGBA transfer via message** — decode BLP/TGA to a raw RGBA buffer in the extension host (already done internally by `js-blp`) but send the buffer as a `Uint8Array` message instead of compressing to PNG. The webview reconstructs an `ImageData` and blits it to a `<canvas>` element. Eliminates `PNG.sync.write` entirely. Tradeoff: canvas elements instead of `<img>` tags; layout changes needed.

2. **ImageBitmap from ArrayBuffer** — variant of (1) using `createImageBitmap(new ImageData(...))` in the webview for hardware-decoded compositing. Potentially faster than canvas blit; same architectural change required.

3. **WASM BLP decoder in the webview** — bundle a WASM BLP decoder inside the webview bundle; send raw `.blp` bytes from the extension host (no decode, no PNG), let the webview decode locally. Avoids the extension host decode entirely. Likely blocked by VSCode's webview CSP restrictions (`'unsafe-eval'` / `wasm-unsafe-eval` may not be grantable).

4. **Compressed GPU texture formats (DXT/BCn via WebGL)** — BLP already stores many textures as DXT1/DXT3/DXT5 blocks internally. A WebGL renderer could upload these blocks directly as `COMPRESSED_RGBA_S3TC_DXT*` textures, skipping decode entirely. High complexity; requires moving from DOM to a WebGL renderer; a later-milestone concern (see Canvas/WebGL in Stretch Goals).

**Recommendation:** Approach (1) is the lowest-risk change and directly attacks the measured bottleneck (PNG compression). Approach (3) is the most architecturally clean but needs a quick CSP feasibility check before any code is written. Approaches (2) and (4) are refinements or longer-term ideas.

**Scope of this item:** Research and feasibility only. Prove out whether VSCode's webview CSP permits the required capabilities for each approach, estimate the layout changes needed for canvas-based rendering, and decide whether any approach clears the bar to justify a follow-up implementation task. Do not implement without a separate backlog item.

**Effort:** XS (research/feasibility); S–M for any approach taken to implementation.

---

## tsconfig solution-style refactor (IDE tooling debt)

**Status: ✅ Done (2026-05-26)**

**Problem:** `tsconfig.json` includes a `"references"` entry to `tsconfig.test.json` intending VS Code to use the test config for `test/` files. In practice the language server falls back to the root config, which lacks `types: ["jest","node"]`, so Jest/Node globals appear unresolved in the IDE. No CI impact — typecheck uses `tsconfig.build.json` which excludes test files.

**Fix applied:**

- `tsconfig.src.json` — former `tsconfig.json` content, plus `"composite": true`, no `references`.
- `tsconfig.json` — solution file: `{ "files": [], "references": [tsconfig.src.json, tsconfig.test.json] }`.
- `tsconfig.test.json` — updated to extend and reference `tsconfig.src.json`.
- `tsconfig.build.json` — updated to extend `tsconfig.src.json`; overrides `"composite": false` so `tsc --noEmit` works cleanly.

VS Code now reliably picks the correct per-file config via solution-style layout.

---

## Addon texture manifest builder

**Status: Done** (2026-05-27)

**What was built:**

`src/parser/addon-textures.ts` — `collectAddonTexturePaths(addonsDir, addonNames)` scans any set of addon folders via their TOC files, follows `<Include>` chains, and returns every distinct raw texture path found across all frames and templates. No inheritance resolution is applied — each XML definition's `file=` attributes are collected directly, which gives a correct superset of what will be needed at render time. `resolveCI` is now exported from `blizzard-registry.ts` so the path-finding logic is shared.

`dev/collect-textures.ts` — CLI wrapper (replaces `collect-blizz-textures.ts`). Accepts an optional addons dir and optional addon name list; defaults to scanning every subdirectory in the addons dir. Normalizes paths (backslash → slash, `.blp` appended if no extension) and outputs a sorted, deduplicated manifest to stdout with stats to stderr. Built via `pnpm collect-textures`.

**Usage:**

```bash
# All addons in the default dir → manifest → extract
pnpm collect-textures > /tmp/textures.txt
./dev/extract.sh retail --paths-file /tmp/textures.txt

# Named addons only
node dist/collect-textures.js .wow-assets/interface/addons Blizzard_SharedXML Blizzard_FrameXML

# Derive unique parent dirs and build brace glob
DIRS=$(sed 's|/[^/]*$||' /tmp/textures.txt | sort -u | tr '\n' ',' | sed 's/,$//')
rustydemon-cli export -a "$WOW_DIR" -l <cacheRoot>/downloads/listfile.csv -o .wow-assets -p "{$DIRS}/**" -j 8
```

**Design note:** Inheritance resolution is not needed for manifest/preload purposes. Template definitions include their `file=` attributes directly in the XML, so raw parsing already captures all texture references. Concrete frames that only inherit textures from Blizzard templates are covered when those template addons are also scanned. This keeps the function fast and dependency-free (no registry pass required).

---

## Dynamic flavor detection from `.build.info`

**Status: ✅ Done** (2026-05-27)

**What was built:**

`src/assets/build-info.ts` — `listInstalledFlavors(wowRoot)` reads `.build.info`, parses all product rows via `parseBuildInfo`, reverse-maps each product key through `PRODUCT_TO_FLAVOR`, and returns an `InstalledFlavor[]` (flavor + version pairs) for every recognized product. Unrecognized keys are silently ignored. Never throws.

`src/assets/index.ts` — Two new methods on `AssetService`:

- `getInstalledFlavors()` — thin wrapper over `listInstalledFlavors` that returns empty when `installDir` is unset.
- `detectAndLogFlavors()` — logs `"[Scryer] detected flavors: retail (11.2.0), classic_era (1.15.7)"` to the output channel; emits a warning when the configured `scryer.flavor` is absent from the detected set.

`src/extension.ts` — `detectAndLogFlavors()` called at activation (after `checkBuildVersion()`). A `vscode.workspace.onDidChangeConfiguration` listener re-creates `AssetService` and re-runs both `checkBuildVersion` + `detectAndLogFlavors` when any relevant setting changes (`scryer.flavor`, `scryer.installDir`, cache settings, etc.).

`scryer.selectFlavor` command registered in `extension.ts` and contributed in `package.json`. Opens a `showQuickPick` populated with detected flavors (version in description) when `installDir` is set; falls back to the static `FLAVOR_INFO` key list when not configured. Writing a selection updates `scryer.flavor` in workspace settings.

**Tests:** 6 new tests added to `test/assets/build-info.test.ts` covering: all-flavors returned, correct versions, unknown-product filtering, absent file, no recognized products, and empty-file robustness.

---

## CSS inset + relativeKey renderer fixes (deferred from M2)

**Status: ✅ Done** (2026-05-28)

**What was built:**

`src/webview/renderer.ts` — Two fixes:

1. **CSS inset shorthand bug:** The initial `cssText` was `"position:absolute;inset:0;overflow:hidden;"`, then `el.style.inset = ""` was used to clear the inset after setting explicit `left`/`top`. In Chromium's CSSOM, clearing a shorthand removes all its constituent longhands — including `left` and `top` that were set just before. Result: every texture collapsed to position (0,0), so the last-rendered cap appeared in place of all others. Fix: start with `"position:absolute;overflow:hidden;"` and use an if/else to either set explicit `left`/`top`/`width`/`height` or set `inset:0`, never mixing the two paths.

2. **Bulk layer layout:** Each texture was previously laid out in isolation via `layoutAll([obj], ...)`, so `Middle`'s `layoutAll` call had no Left/Right rects in its `rectMap` and `relativeKey` references fell back to the viewport. Fixed by calling `layoutAll` once for the entire layer's object list, so sibling relativeKey references (e.g. `$parent.Left` → `$parent.Right`) resolve correctly.

`src/webview/layout.ts` — `collectNames` now registers frames by `parentKey` in addition to `name`. Templates like `UIPanelGoldButtonTemplate` use `parentKey="Left"/"Right"/"Middle"` (not `name=`), so they were invisible to the registry. Adding `parentKey` registration allows `expandRelativeKey("$parent.Left", "")` → `"left"` to find the Left texture element.

**Visible result:** `UIPanelGoldButtonTemplate` buttons now render with Left cap on the left, Right cap on the right, and Middle filling the space between them.

---

## TexCoords sprite-sheet slicing in the DOM renderer (deferred from M2)

**Status: ✅ Done (2026-05-28)**

**What was built:**

`src/webview/main.ts` — `applyAsset` now checks `data-tex-coords` on each resolved texture element. If present, it computes pixel-based `background-size` and `background-position` from the UV crop:

```typescript
const bgW = el.offsetWidth / (right - left);
const bgH = el.offsetHeight / (bottom - top);
el.style.backgroundSize = `${bgW}px ${bgH}px`;
el.style.backgroundPosition = `${-left * bgW}px ${-top * bgH}px`;
```

**Why pixel units, not percentages:** CSS `background-position: X%` does NOT mean "offset by X% of the container." It means "point X% along the image aligns with point X% along the container" — a different coordinate when the image is larger than the container. For a corner slice where `scaleX ≈ 10.67`, the percentage formula gave `−566%` which CSS interpreted as a +657px rightward shift instead of the wanted −68px. Pixel math via `offsetWidth`/`offsetHeight` is unambiguous and correct.

**Companion fix — two-anchor size override** (`src/webview/layout.ts`): the middle textures in nine-slice templates (TopMiddle, MiddleLeft, etc.) have both a `<Size>` attribute and two opposing relativeKey anchors. `layoutByTwoAnchors` was using the explicit `<Size>` value (e.g., 56px) instead of the anchor-computed span (136px). WoW's rule is that two opposing anchors always stretch the element; `<Size>` is ignored for those axes. Fixed: anchor-computed dimensions unconditionally win when the two anchors span that axis; explicit size is only a fallback when both anchors share the same point-fraction and cannot determine the dimension.

**Visible result:** `UIMenuButtonStretchTemplate` (and any nine-slice template) now renders all nine segments — four corners with correct UV crops, four edges and one centre all stretching correctly to fill the button.

---

## Flavor configuration file — per-flavor display defaults

**Status: ✅ Done** (2026-05-28)

**Problem:** Previewed frames don't match in-game appearance because display properties are either hardcoded in the renderer or absent entirely. The most visible gaps are fonts, font sizes, and the UIParent reference resolution. WoW uses specific per-flavor fonts (e.g. `Fonts\FRIZQT__.TTF` as the primary UI font in Retail, different families in Classic Era), and the standard reference canvas is 1024×768 logical units (scaled from a 1920×1200 physical resolution). Without these, font strings render at browser defaults and frame proportions are wrong.

**Goal:** A layered configuration system that defines per-flavor display defaults, ships with the extension for each known flavor, and lets users override or extend it for their own setup.

**Design:**

- **Built-in config** (`src/flavors/<flavor>.json` or a single `src/flavors/defaults.json` with nested sections): a JSON file with a `default` section and per-flavor overrides (`retail`, `classic`, `classic_era`). The `default` section is applied when no flavor-specific entry exists.
- **Config keys (initial set):** `screenWidth`, `screenHeight` (physical screen resolution, default `1920` × `1080` — `uiParentWidth/Height` are derived: `uiParentHeight=768`, `uiParentWidth=round(768*screenWidth/screenHeight)`), `defaultFont` (WoW-relative path, e.g. `Fonts/FRIZQT__.TTF`), `defaultFontSize` (number), `defaultFontFlags` (e.g. `""`, `"OUTLINE"`, `"THICKOUTLINE"`), `defaultTextColor` (RGBA), `frameScale` (global preview scale).
- **User config:** a new extension setting `scryer.flavorConfigPath` (string, default empty) points to a user-supplied JSON file with the same shape. When set, it is loaded and merged additively on top of the built-in config: built-in `default` → built-in per-flavor → user `default` → user per-flavor. Later layers win per-key.
- **Consumption:** the webview renderer reads the resolved config object (passed in the initial `render` message or as a separate `configUpdate` message) and applies font/size/resolution defaults wherever an explicit frame attribute is absent. FontString elements without `font=` or `fontsize=` fall back to the resolved defaults.

**Implementation notes:**

- Keep the config shape flat and JSON-native. No TOML or YAML — avoids adding a parser dependency for a small config file.
- The webview already receives a JSON payload from the extension host; add the resolved flavor config to that payload rather than a separate round-trip.
- Font assets: WoW font paths (e.g. `Fonts/FRIZQT__.TTF`) must be resolved through the asset pipeline exactly like textures. If the font file is present in the cache, serve it as `asset://` and inject a `@font-face` rule. If absent, fall back to a reasonable system sans-serif.
- Future extension points: backdrop defaults, scrollbar skin paths, frame border defaults — all can be added as new keys without breaking the schema.

**Effort:** M — config loading and merging is straightforward (S); the larger work is wiring the resolved config into the webview renderer and applying defaults at the right rendering layer (M) without breaking the existing explicit-attribute path.

---

## Pixel ruler overlay in the preview panel

**Status: ✅ Done (2026-05-28)**

**What was built:**

`src/webview/ruler.ts` — `initRulers()` creates `#ruler-top` (horizontal `<canvas>`), `#ruler-left` (vertical `<canvas>`), and `#ruler-corner` (filler square) as `position: fixed` elements appended to the webview body. `updateRulers(wowViewportEl, scale)` redraws both canvases using `getBoundingClientRect()` on the WoW viewport element so the displayed coordinates automatically track CSS transforms (`frameScale`) and body scroll. `setRulersVisible(show)` toggles the `show-ruler` CSS class on the body, which activates display and adjusts body padding from 8px to 28px on the top/left to prevent canvas content from hiding beneath the strips.

**Coordinate system:** Ticks are in WoW logical pixels — the same units as the anchor layout engine. Minor ticks every 10 WoW px, major ticks at 50, numeric labels at 100. The horizontal ruler labels are right of the tick; the vertical ruler labels are rotated 90° so they read top-to-bottom.

**Extension host:**

- `src/protocol.ts` — `{ type: "setRuler"; show: boolean }` added to `HostMessage`.
- `src/panel.ts` — `rulerMessage()` helper reads `scryer.showRuler`; posted after every `render` message and on `onDidChangeConfiguration` when `scryer.showRuler` changes. A `StatusBarItem` ("Ruler: ON" / "Ruler: OFF") is created per panel, wired to the `scryer.toggleRuler` command, and disposed with the panel.
- `src/extension.ts` — `scryer.toggleRuler` command flips `scryer.showRuler` in workspace config; the `onDidChangeConfiguration` chain in `panel.ts` propagates the change to the webview automatically.
- `package.json` — `scryer.showRuler` boolean setting (default `false`); `scryer.toggleRuler` command contributed.

**Effort:** XS–S — within estimate.

---

## Atlas texture resolution

**Status: ✅ Done (2026-05-28)**

Atlas references (e.g. `atlas="glues-characterselect-tophud-middle-bg"`) name a region within a sprite sheet rather than a standalone file. They previously rendered as labeled colored placeholders (`[atlas] <name>`).

**What was built:**

1. **Manifest format** — JSON at `<cacheRoot>/<flavor>/derived/atlas-manifest.json` mapping `atlasName → { file, x, y, width, height, sheetW, sheetH, tilesH, tilesV }`. `file` is the WoW-relative path to the sprite sheet BLP. Pixel offsets `x`/`y` and region dimensions `width`/`height` come from `UiTextureAtlasMember.CommittedLeft/CommittedTop/Width/Height`; sheet totals `sheetW`/`sheetH` from `UiTextureAtlas.AtlasWidth/Height`.
2. **`src/assets/atlas-manifest.ts`** — `AtlasEntry` / `AtlasManifest` types; `loadAtlasManifest(path)` disk loader (returns `null` when file is absent — silent no-op for users without a manifest).
3. **`AssetService.loadAtlasManifest()`** — reads from `<texturesConvDir>/../atlas-manifest.json`.
4. **IR enrichment in `panel.ts`** — before sending the render message, walks all textures and fills `TextureIR.resolvedAtlas` from the manifest. `collectTexturePaths` was updated to also include resolved atlas sheet paths for pre-warming.
5. **Renderer** — when `resolvedAtlas` is set, emits `data-asset-path` (sheet file) + `data-atlas-crop` (crop JSON). `useAtlasSize=true` sets explicit element dimensions from the atlas region at render time and is re-applied when the asset loads.
6. **Webview `applyAsset`** — detects `data-atlas-crop` and computes `background-size`/`background-position` using pixel math (same approach as TexCoords). `useAtlasSize` overrides element dimensions on asset load.
7. **`dev/gen-atlas.mjs`** — generates the manifest JSON from `UiTextureAtlas` and `UiTextureAtlasMember` CSV exports (auto-downloaded from wago.tools, or supplied as local files via `--atlas-csv`/`--members-csv`) joined with `<cacheRoot>/downloads/listfile.csv` for FileDataID → path lookup. Accepts `--listfile <path>` or `--listfile-dir <dir>`. Invoked automatically by `AssetService.ensureAtlasManifest()` at first render when the manifest is absent; re-tried after Blizzard file extraction completes (which downloads the listfile as a side effect). Community listfile is cached at `<cacheRoot>/downloads/listfile.csv`; never written to `dev/`.
8. **Atlas name lookup** — case-insensitive with `-2x` suffix fallback. WoW DB2 exports store names lowercase (e.g. `ui-frame-diamondmetal-header-cornerleft-2x`); XML attributes use mixed-case without the suffix. `resolveAtlasInTexture` in `panel.ts` cascades: `manifest[name]` → `manifest[name.toLowerCase()]` → `manifest[name.toLowerCase() + "-2x"]`.

**Post-completion fixes (same session):**

- `dev/extract.sh` `ensure_listfile()` — progress messages redirected to stderr; previously captured by `listfile="$(ensure_listfile)"` command substitution, corrupting the path variable and causing rustydemon-cli to receive the download message as the listfile path.
- Atlas manifest generation retry — `panel.ts` resets `atlasGenDone` when Blizzard extraction produces new files, allowing the subsequent re-render to retry manifest generation once the listfile is available.
- `package.json` — `clear-cache:workspace` and `clear-cache:global` scripts for development convenience.

---

## JS entry-point runners (replace dev shell scripts)

**Status: ✅ Done (2026-05-28)**

**What was built:**

`src/assets/atlas-gen.ts` — self-contained atlas manifest generation library (ported from `dev/gen-atlas.mjs`). Exports `generateAtlasManifest(opts)`. Fetches UiTextureAtlas and UiTextureAtlasMember CSV exports from wago.tools, joins with the community listfile, and writes `atlas-manifest.json`. No vscode dependency.

`src/assets/extract-core.ts` — self-contained extraction library (ported from `dev/extract.sh`). Exports `extractPaths()`, `extractBulk()`, and `ensureListfile()`. Handles retail (rustydemon-cli subprocess), classic/classic_era (direct `fs` loose-file copy with case-insensitive path resolution), and listfile download (Node https streaming). No vscode dependency.

`src/assets/extractor.ts` — replaced entirely. Now a thin vscode wrapper around the two core libraries: `extractMissing()`, `extractInterface()`, `genAtlas()`. All subprocess and script-path logic removed.

`dev/extract.ts` — thin CLI shim replacing `dev/extract.sh`. Parses CLI args (same interface as the old bash script), reads `dev/config.local.json` for `wowDir`/`cascTool` defaults, delegates to `extract-core.ts`.

`dev/gen-atlas.ts` — thin CLI shim replacing `dev/gen-atlas.mjs`. Delegates to `atlas-gen.ts`.

`dev/bench.build.mjs` — updated to build `gen-atlas.ts` and `extract.ts` into `dist/`.

`dev/config.json.example` — replaces `dev/config.sh.example`. JSON format; gitignore entry added for `dev/config.local.json`.

`package.json` — added `pnpm run extract` and `pnpm run gen-atlas` scripts. Removed `scryer.extractScriptPath` setting from contributes.configuration.

**Architecture:** `src/` is the source of truth. `dev/` scripts are thin CLI entry points that import and call `src/` functions. The extension calls `src/` directly with no subprocess boundary. CLAUDE.md documents this invariant.

---

## User-visible loading notifications

**Status: 📋 Pending**

**Problem:** Several slow async operations happen silently with no user-facing feedback:

- **Atlas manifest generation** — `ensureAtlasManifest()` downloads two CSV exports from wago.tools (~1–3 s network + ~2 s parse), then writes the manifest. This happens at first render. The user sees placeholder tiles with no indication that anything is in progress or why.
- **Blizzard file extraction** — `ensureBlizzardFiles()` can trigger a CASC extraction pass. The output channel logs it, but the panel shows no in-panel status.
- **Startup preload** — `scryer.startupContent` tier execution logs to the output channel but there is no status bar or panel indicator that background work is ongoing.

The output channel is a power-user tool. Regular users never open it, so they have no visibility into why the preview is showing placeholders.

**Plan:**

1. **Atlas generation progress** — wrap `ensureAtlasManifest()` in a `vscode.window.withProgress({ location: ProgressLocation.Notification })` call. Show distinct messages for download phase ("Scryer: downloading atlas data…") and generation phase ("Scryer: building atlas manifest…"). Dismiss automatically on success; surface output channel on failure.

2. **In-panel loading indicator** — add a small status element to the webview HTML (e.g. a bottom-edge bar or a corner badge) that the extension host toggles via a `{ type: "setStatus" }` protocol message. States: `idle`, `loading` (generic), `extracting`, `buildingAtlas`. Prevents the "why are all my textures colored boxes?" confusion without requiring the user to find the output channel.

3. **Status bar for long background work** — reuse or extend the existing per-panel `StatusBarItem` to show a spinner prefix while any async work is in flight (extraction, atlas gen, preload tiers). Clear on idle.

4. **Consolidate** the existing `vscode.window.withProgress` call in `extractMissing()` so all three entry points (extraction, Blizzard file ensure, atlas gen) use a consistent notification pattern.

**Scope:** Extension host progress notifications + in-panel status indicator + status bar integration. No new user-configurable settings needed; this is always-on feedback that scales down gracefully when nothing is in flight.

**Effort:** S — ~2–4 hours. Notification plumbing is the largest part; in-panel status element is small HTML/CSS.

---

## Texture placeholder hover tooltip

**Status: ✅ Done (2026-05-30)**

**Problem:** Unloaded or missing textures render as colored placeholder elements with the texture path (or atlas name) as visible text. When the name is long, it is truncated by the element's bounds with no way to read the full path without inspecting the DOM. Additionally, Blizzard template frames with child frames on top of background textures blocked tooltip detection — `mouseover` + `closest()` can only walk _up_ the DOM from the event target, missing sibling placeholders hidden beneath stacked frames.

**What was built:**

- `src/webview/placeholder.ts` — `makePlaceholder` sets `div.dataset.phLabel` (the full un-truncated path or label) on the placeholder container div.
- `src/webview/main.ts` — a custom tooltip overlay div (`phTooltip`) is appended to `document.body`, positioned via `mousemove` and hidden via `mouseleave`. Detection uses `document.elementsFromPoint(x, y)` on every `mousemove`, which returns all elements at the cursor in z-order regardless of `pointer-events` — including placeholders visually beneath child frames. The first element inside the viewport container that has `data-ph-label` wins.

---

## Atlas manifest from DB2 (replace wago.tools)

**Status: 📋 Pending**

`dev/gen-atlas.mjs` currently generates the atlas manifest by downloading `UiTextureAtlas` and `UiTextureAtlasMember` CSV table exports from wago.tools. This works but has two problems: it makes an outbound HTTP request to a third-party service at extension startup (whenever the manifest is absent), and it silently produces a stale manifest when the user is offline or when wago.tools lags behind a patch.

**Goal:** Replace the CSV download with direct parsing of the DB2 binary files extracted from the user's WoW installation. No outbound HTTP. The manifest is generated from the same build as the user's game data.

**Rough plan:**

1. **Extract the DB2 files** — extend `dev/extract.sh --type atlas` (or the on-demand extractor) to pull `dbfilesclient/uitextureatlas.db2` and `dbfilesclient/uitextureatlasmember.db2` from CASC via rustydemon-cli, writing them to `<sourceDir>/dbfilesclient/`.

2. **Parse the DB2 binary format** — write a minimal WDC4 parser in `dev/parse-db2.mjs` (or inline in `gen-atlas.mjs`) covering only the two table schemas needed. The WDC4 format is documented; the field layouts for these two tables are fixed and small. Key reference: `_reference/wow.export/src/js/db/WDCReader.js`. The main complexity is bitpacked fields and the string table; both tables use simple non-packed integer and string fields so a hand-rolled subset parser is feasible without pulling in the full WDCReader infrastructure.

   Alternatively, use an npm DB2 parser such as `@wowserhq/db2` if one becomes available with a compatible license.

3. **FileDataID → path join** — unchanged: still uses the community listfile (now at `<cacheRoot>/downloads/listfile.csv`) to resolve FileDataIDs to `Interface/...` paths.

4. **Wire into `ensureAtlasManifest()`** — `AssetService.ensureAtlasManifest()` currently calls `shellGenAtlas` which spawns `gen-atlas.mjs`. After this change, `gen-atlas.mjs` falls back to the wago.tools download only when the DB2 files are absent (first run before any extraction), and prefers the local files when they exist.

**Depends on:** Having a WoW install configured (`scryer.installDir`) so the DB2 files can be extracted. Falls back to wago.tools download if not.

**Effort:** M (WDC4 parser for two specific schemas: S; DB2 extraction plumbing + fallback logic: S; testing across retail/classic builds: S).

---

## WoW font loading (FRIZQT\_\_.TTF from CASC)

**Status: ✅ Done (2026-05-28; non-blocking fix 2026-05-30)**

**Problem:** WoW fonts (e.g. `Fonts/FRIZQT__.TTF`) are packed in CASC archives, not present as loose files in the install directory. The asset resolver only handled image extensions, so font paths were never found, and FontStrings fell back to the system serif font.

**What was built:**

- `src/assets/resolver.ts` — extended `AssetKind` to include `"font"` for `.ttf`/`.otf`; added both extensions to the `hasExt` regex and `EXT_KIND` map.
- `src/assets/index.ts` — `_resolve()` now passes `font` kind through directly (no BLP conversion); added `claimExtraction(rawPath): boolean` — a per-session dedup guard backed by a `Set<string>` that prevents concurrent renders from triggering duplicate extraction attempts for the same path.
- `src/assets/extract-core.ts` — `extractRetailPaths()` switched from `ensureFilteredListfile` to `ensureListfile` (full community listfile). The interface-filtered listfile omits non-`Interface/` paths like `Fonts/`; font extraction requires the full CSV.
- `src/panel.ts` — font resolution is **non-blocking**: `renderFile()` resolves the font from cache immediately (fast path), and if absent, calls `extractAndSendFont()` as a fire-and-forget. When extraction completes, a `{ type: "fontResolved" }` message injects the `@font-face` rule in the webview without triggering a full re-render. `protocol.ts` — added `fontResolved` host→webview message type. `main.ts` — handles `fontResolved` by calling `applyDefaultFont()`.

**Why non-blocking matters:** The original blocking implementation awaited `extractMissing([font])` inside `renderFile()`. On cold start, font extraction takes ~6 minutes (full listfile download + CASC open). Meanwhile, Blizzard addon extraction would complete and call `renderFile()` again, posting a render with texture placeholders and kicking off their extraction. When the font finally resolved, the original `renderFile()` continuation posted a third render, wiping the DOM exactly as texture `assetResolved` messages were arriving. Textures targeted elements that no longer existed; the preview remained blank until the user closed and reopened. The non-blocking approach eliminates this spurious re-render entirely.

**Fallback:** When the font is unavailable, the CSS font stack falls back to `sans-serif` (matching WoW's own default appearance more closely than serif).

---

## All preview chrome values configurable via defaults.json

**Status: ✅ Done (2026-05-29)**

**What was built:**

Extended `src/flavors/defaults.json` and the `FlavorConfigLayer` / `ResolvedFlavorConfig` types to cover every previously hardcoded value in the preview — not just WoW environment fields but all visual and behavioral knobs in the preview chrome. This creates a single auditable location for every magic value in the renderer and makes the full set user-overridable via `scryer.flavorConfigPath`.

**New fields added (grouped by concern):**

- **WoW engine:** `uiParentHeight` (768 — now flows from defaults.json rather than being hardcoded in `resolveFlavorConfig`)
- **Rendering calibration:** `fontLetterSpacing` (renamed from `fontLetterSpacingEm`; default `"0.033em"`, now a string so the user can specify any CSS unit), `autoFontSizeRatio` (`0.75`), `fontSmoothing` (`"antialiased"` — maps to `-webkit-font-smoothing`; matches WoW's DirectWrite grayscale AA)
- **Viewport background:** `viewportBg`, `viewportCheckerLight`, `viewportCheckerDark`, `viewportCheckerSize`
- **Pixel ruler:** `rulerSize`, `rulerBg`, `rulerBorder`, `rulerTickMajorColor`, `rulerTickMinorColor`, `rulerLabelColor`, `rulerLabelInterval`, `rulerTickMajor`, `rulerTickMinor`, `rulerShadowColor`, `rulerShadowBlur`
- **Status bar:** `statusBarHeight`, `statusBarBg`, `statusBarColor`, `statusBarFont`
- **Placeholder tiles:** `placeholderSaturation`, `placeholderLightness`, `placeholderLabelOpacity`
- **Layout solver:** `layoutEpsilon`, `layoutMaxIterations`

**Consumer updates:**

- `ruler.ts` — `RULER_SIZE` / `STATUS_BAR_H` module-level exports removed; all drawing uses config fields. Shadow constants removed.
- `placeholder.ts` — `placeholderColor` and `makePlaceholder` now accept `config`; HSL values and label opacity come from config.
- `renderer.ts` — `renderTexture` receives config for placeholder calls; `layoutAll` calls pass `{ epsilon, maxIterations }` from config; viewport background/checkerboard use config; `letter-spacing` and `autoFontSizeRatio` come from config.
- `panel.ts` — `buildHtml()` resolves the flavor config and templates all computed CSS pixel values (status bar height, ruler size, body padding with and without ruler, all colors).
- `layout.ts` — `layoutByTwoAnchors` gains an optional `epsilon` param; `MAX_LAYOUT_ITERATIONS` constant removed; `layoutAll` accepts `{ epsilon?, maxIterations? }` opts.

**Documentation:**

- `CLAUDE.md` — new "defaults.json philosophy" section: all magic values in defaults.json; three-tier doc split; rule that new settings must be documented in the correct tier in the same change.
- `docs/configuration.md` — rewrote `flavorConfigPath` section with correct field names (old version had wrong fields); split into WoW environment fields vs. rendering calibration fields; links to advancedConfiguration.md.
- `docs/advancedConfiguration.md` (new) — documents all chrome-aesthetic fields (viewport, ruler, status bar, placeholder, layout solver); framed as the natural theming surface.
- `README.md` — fixed display defaults table (was showing 1024×768; now shows 1920×1080 + correct UIParent); linked to advancedConfiguration.md.

---

## FontString rendering fidelity

**Status: ✅ Done (2026-05-28)**

**Problem:** FontStrings in the preview differed from in-game in three ways: (1) left-aligned when they should be centered, (2) collapsed to zero width when no explicit size was set, (3) text was noticeably narrower than in-game for the same string.

**Root causes and fixes:**

1. **Wrong `justifyH` default** — WoW defaults `justifyH` to `CENTER` (not `LEFT`). `renderFontString` now applies `fs.justifyH ?? "CENTER"` and `fs.justifyV ?? "MIDDLE"`.

2. **Zero-width rect for unsized FontStrings** — A FontString with only a vertical anchor and no `<Size>` produces a `0×0` rect from the layout engine. WoW's default behaviour in this case is full parent width, auto height. `renderFontString` now detects `rect.width === 0` and applies `left: 0; width: 100%` instead of the explicit pixel values.

3. **Text narrower than in-game (letter-spacing fudge)** — WoW's DirectWrite renderer (grayscale AA) produces ~6.3% wider advance widths than the browser's ClearType renderer for the same font file. Calibrated against `FRIZQT__.TTF` at height=12 by measuring "Example Bare Frame" (18 chars): WoW=151px vs browser=142px at 125% DPI → 7.2 CSS px gap → 0.4px per char → `0.4/12 = 0.033em`. Applied as `letter-spacing: 0.033em` on the span so it scales with font size.

**Known remaining limitation:** The browser's ClearType subpixel AA makes text appear very slightly heavier/bolder than WoW's grayscale DirectWrite rendering. No CSS property available in the VS Code webview on Windows fully corrects this; it is an accepted approximation difference.

---

## TypeScriptToLua integration investigation

**Status: 📋 Pending**

TypeScriptToLua (TSTL) compiles TypeScript to Lua 5.1 and is widely used by WoW addon authors who want TypeScript's type system and modern syntax. From Scryer's perspective the output is ordinary Lua 5.1 — TSTL is a pre-compilation step the author performs before any Lua lands in the workspace. Scryer should run TSTL-compiled addons without special handling in the common case.

However, there are a few integration questions worth answering before M8 (TOC Execution Pipeline) is in progress:

1. **TSTL runtime library (`lualib_bundle`)** — TSTL emits a small runtime library (iterators, class system, `__TS__` helpers) that must load before addon code runs. Does the Scryer sandbox's load order accommodate it, or does it need an explicit entry point? Do any `lualib` patterns conflict with the WoW 5.1 shim (e.g. custom `__index` metamethods, use of `table.unpack`)?

2. **WoW API type stubs and TSTL** — The TSTL community maintains `@warcraft/types` (WoW API TypeScript declarations). If an author uses these, the compiled output makes the same API calls our stubs must handle. No new stub surface should be needed, but it's worth confirming the call patterns match expectations.

3. **Source maps** — TSTL can emit Lua source maps. If Scryer surfaces Lua errors (stack traces, sandbox violations), could source maps be used to point errors back to the TypeScript source? This would be a significant DX improvement for TSTL-authored addons.

4. **Addon detection** — Should Scryer detect TSTL-compiled addons (e.g. presence of `lualib_bundle.lua` in the addon directory or a TSTL config file) and adjust any behavior, or is "just run the Lua" always sufficient?

**Scope of this item:** Research and feasibility only. Answer questions 1–4, note any required sandbox or load-order changes, and decide whether any of them warrant a follow-up implementation task before or during M8.

**Effort:** XS–S (research); implementation unknown until investigation is complete.

---

## Live panel frame diffing (deferred from M4)

**Status:** 📋 Pending

**Problem:** The M4 live panel sends the full frame tree to the webview on every Lua mutation. For addons with large frame hierarchies or frequent mutations (e.g. `OnUpdate` handlers updating many frames per tick), this is wasteful — most of the tree is unchanged.

**Plan:** Track a shadow copy of the last-sent frame tree in `ScryerLivePanel`. On each mutation, compute a structural diff (added/removed/changed nodes) and send only the delta. The webview renderer applies incremental patches rather than rebuilding the DOM.

**Why deferred:** Full re-render is correct, simple, and sufficient for M4's goal of "does the addon render at all." Diffing is an optimization that only matters once real addons are running and frame counts are known. Premature optimization here would complicate the initial panel architecture.

**Effort:** S–M (depends on how complex the diff format needs to be; a simple recursive object comparison may be enough for the initial version).

---

## Center frame content on open

**Status:** ✅ Done (2026-05-30)

**Problem:** When a WoW XML file is opened, the preview canvas starts scrolled to the origin (top-left). Frames are anchored relative to UIParent and can appear anywhere on the virtual canvas — often centered or offset. The user must manually scroll to find their frames after every open.

**Plan:**

1. After `layoutAll` runs in the webview, compute the union bounding box of all top-level frame elements.
2. Derive a scroll offset that centers that bounding box within the visible panel area.
3. Apply the offset to the outer scroll container.
4. Persist scroll position across re-renders of the same file (hot-reload and Lua mutation should not jump).

The centering logic should live in the webview (`main.ts`) and trigger once after the first `render` message for a given file. A `data-file-key` or similar marker on the render payload can distinguish "new file opened" from "same file re-rendered."

**Effort:** XS–S.

---

## Grab pan and zoom on the preview canvas

**Status:** 📋 Pending

**Problem:** Scrollbars work but are slow for large navigation jumps. There is no way to zoom in on dense frame hierarchies or zoom out to see the whole layout at once. Both are common actions during addon development.

**Plan:**

1. **Grab pan** — listen for `mousedown` on the body (or a transparent overlay) and translate `mousemove` deltas into `window.scrollBy` calls while the button is held. Trigger on middle-click (button 1) unconditionally, and on left-click when `Space` is held (Figma-style). Show a `grab`/`grabbing` cursor during drag. Suppress any `click` event that fires at the end of a drag so interactive frames don't misfire.

2. **Scroll-wheel zoom** — intercept `wheel` events with `ctrlKey` (standard browser zoom gesture, also triggered by pinch-to-zoom on trackpads). Convert the wheel delta to a scale multiplier and update `flavorConfig.frameScale`. To keep the point under the cursor stationary: record the cursor's page coordinates before the scale change, apply the new scale (which changes element sizes and therefore scroll extents), then adjust `window.scrollTo` so the same page point is back under the cursor.

3. **Scale state** — `frameScale` lives in `ResolvedFlavorConfig` which is currently host-owned. Options:
   - Keep scale host-owned: send a `webviewMessage` back to the host when zoom changes; host re-renders with the new config. Simple but causes a full re-render on every zoom step, which may be too slow for smooth pinch.
   - Make scale webview-local: apply a CSS `transform:scale()` on the `#wow-viewport` element directly in the webview, independent of the host-side config. Fast and smooth; the host never needs to know. On the next full `render` message the host resets to its config value, which is acceptable.
   - Recommended: webview-local CSS scale for interactive zoom, with a "reset zoom" button or keyboard shortcut that snaps back to `frameScale` from config.

4. **Reset** — double-click or `Ctrl+0` restores default scale and re-centers content.

**Effort:** S.

---

## Canvas scroll in all directions and always-show scrollbars

**Status:** ✅ Done (2026-05-30)

**Problem:** The preview canvas currently restricts scrolling to non-negative coordinates — you can scroll right and down, but not left or up past the origin. Any frame element positioned in negative coordinate space (anchored above or to the left of UIParent's origin) is unreachable. Additionally, scrollbars only appear when content overflows, making it non-obvious that the canvas is scrollable.

**Goal:** Mirror WoW's unbounded virtual canvas: scroll in all four directions, with scrollbars always visible so the user knows the canvas is navigable.

**Implementation:** Body padding expanded to one UIParent dimension on each side (`padH = uiParentWidth * frameScale`, `padV = uiParentHeight * frameScale` in CSS px). `overflow:scroll` on body ensures scrollbars are always visible. On initial render (`msg.type === "render"`, not hot-reload), `window.scrollTo(padH, padV)` places the WoW origin at the natural 8px gutter position. Note: CSS propagates `overflow` from `<body>` to the viewport when `<html>` has default overflow, so `document.body.scrollLeft` is a no-op — `window.scrollTo()` is required. `body.show-ruler` padding is updated to add ruler size on top of the scroll padding rather than replacing it. Rulers continue to work via `getBoundingClientRect()`.

**Effort:** S.

---

## Preview background philosophy

**Status:** 📋 Pending

Scryer is an addon development tool — not a game emulator, not an alternative WoW client. The preview viewport intentionally omits game world graphics (terrain, character models, sky, particles). Only addon UI frames are rendered.

This matters because it is easy to drift: as fidelity improves, requests will come in for "why doesn't the world show behind the frames?" The answer is that rendering game geometry is out of scope by design, and there is real value in the current approach — a clean, distraction-free canvas makes frame layout and texture debugging much easier than it would be against a real game background.

**What this item covers:**

1. **Write ADR** — document the decision with context, the out-of-scope boundary ("no game world graphics"), and why that boundary is correct. Record what Scryer _is_: a UI frame preview and execution sandbox, not a visual WoW emulator.
2. **Improve placeholder fidelity** — the colored placeholder tiles are currently functional but not beautiful. Evaluate: should missing textures use a subtle checkerboard or the current hue-based solid color? Should textures that _have_ a resolved file but failed to decode show differently from ones that were never extracted?
3. **Viewport background** — the dark checker pattern is configurable (already in `defaults.json`). Confirm the defaults are a good "neutral canvas" for addon work, not something that implies a game world.
4. **No out-of-scope creep** — explicitly note in the ADR that requests for terrain, sky, or character rendering should be closed as out-of-scope.

**Effort:** XS (ADR + minor placeholder polish).

---

## XML + Lua coupling in static preview

**Status:** 📋 Pending

The current M2 static XML preview ignores any `.lua` files referenced in the same TOC. This works for purely declarative frames, but many addons use Lua to set up templates, register scripts, or populate `FontString` text at load time. Without any Lua execution, these frames render incomplete — missing text, incorrect visibility, or referencing templates that only exist as Lua tables.

**The core design question:** how much Lua execution, if any, is appropriate in the "static" preview path? Options:

1. **None (current)** — parse and render the XML literally; Lua side-effects are absent but the preview is predictable and instant.
2. **Template-only execution** — run just enough Lua to register virtual frames and templates that XML `inherits=` attributes reference, but skip all `OnLoad`/event handlers.
3. **Run-and-freeze** — execute the full TOC load sequence (XML parse + Lua execution through `ADDON_LOADED` / `PLAYER_LOGIN`) exactly once, then tear down the Lua VM and leave the resulting frame snapshot frozen in the webview. No event loop, no `OnUpdate`, no interactivity. The panel becomes a static snapshot of what the addon looked like after load, not a live session.
4. **Full execution on preview** — the static preview becomes the live preview (M7+), removing the distinction entirely.

Option 3 is an attractive middle ground: it gives correct initial state (text populated, visibility set, templates resolved) without the overhead or complexity of a live session. The tradeoff is that anything requiring ongoing event dispatch — progress bars, conditional visibility on player state, `OnUpdate` animations — won't reflect correctly. The panel being non-interactable is intentional: no clicks, no keyboard events, no `OnEvent` callbacks fire after the initial load.

**What this item covers:**

1. **Audit real addons** — look at 5–10 popular addons in `_live/` or `_reference/wow-cookbook` and note how many XML files have meaningful Lua coupling (templates defined in Lua, text set in `OnLoad`, etc.). This determines how bad the current gap is in practice.
2. **Decide the static/live boundary** — document the decision as one of the four options above; option 3 (run-and-freeze) is the most likely candidate if any Lua execution is added to the static path.
3. **Surface the gap to users** — if a previewed XML file has a TOC with Lua entries, show a status bar note: "Lua files not executed — use _Run_ for live preview." This sets expectations without requiring a full implementation.
4. **Write ADR** if the static/live boundary changes from the current assumption.

**Effort:** S (audit + decision + status bar note). Implementing option 3 would be an additional S–M on top, gated on M8.

---

## F5 run mode

**Status:** 📋 Pending

Once M8 (TOC Execution Pipeline) and M9 (Script Events) are complete, the full addon runtime exists — but it may only be reachable via `scryer.openLive` from the command palette. Developers expect F5 (or equivalent) to mean "run this thing."

**Goal:** Make the full execution pipeline discoverable with a single keystroke. Press F5 in any `.xml`, `.lua`, or `.toc` file that belongs to a WoW addon → Scryer finds the TOC, loads the full addon, and opens (or focuses) the live preview panel.

**What this item covers:**

1. **Command:** `scryer.run` contributed in `package.json` with a keyboard shortcut (default `F5`), constrained to addon files (via `when` clause: `editorLangId in ['xml', 'lua']`). The command logic: walk up from the active file to find the nearest `.toc`, then launch `scryer.openLive` against it.
2. **Re-run on F5 in panel focus** — if the live preview panel is focused, F5 re-runs (reloads) the current addon without re-opening the panel.
3. **Stop/restart** — consider `Shift+F5` to stop execution (tear down the sandbox, clear the frame tree) without closing the panel.
4. **Status bar integration** — the existing per-panel `StatusBarItem` could show a "▶ Run" / "■ Stop" affordance when a TOC is detected.

**Scope note:** This item is purely a UX/discoverability layer on top of M8+M9. No new runtime capability is added; the command wiring and TOC discovery are the only implementation work.

**Effort:** S — the runtime is M8+M9; this is ~2–3 hours of command registration, `when` clause tuning, and TOC-finder logic.

---

## Preview settings toolbar

**Status:** 📋 Pending

The preview panel currently has no UI for changing common settings — resolution, UI scale, flavor, ruler visibility. Developers who want to check how an addon looks at 1024×768 vs 1920×1200, or on Classic vs Retail font sizes, must navigate to VS Code settings and edit JSON strings.

**Goal:** A compact toolbar inside the preview panel (above or below the WoW viewport) with direct controls for the most-changed settings.

**Proposed controls (initial set):**

| Control           | Type                                                          | Maps to                                                                 |
| ----------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Screen resolution | Dropdown (1920×1200, 1920×1080, 2560×1440, 1024×768, custom…) | `scryer.flavorConfigPath` override or a new `scryer.resolution` setting |
| UI scale          | Slider or text input (0.5–2.0)                                | `flavorConfig.frameScale`                                               |
| Flavor            | Dropdown (Retail, Classic, Classic Era)                       | `scryer.flavor`                                                         |
| Ruler             | Toggle button                                                 | `scryer.showRuler`                                                      |
| Run / Stop        | Button                                                        | `scryer.run` / sandbox teardown                                         |

**Architecture notes:**

- The toolbar lives in the webview HTML (not the extension host), so changes are sent as `hostMessage` updates from the webview to the extension. The extension host writes the new value back via workspace settings and re-renders.
- Alternatively, toolbar controls could emit a `{ type: "settingChange"; key; value }` webview message; the panel's `onDidReceiveMessage` updates the workspace config via `vscode.workspace.getConfiguration("scryer").update(...)`, which fires `onDidChangeConfiguration` and naturally triggers a re-render. This is the cleanest flow.
- Avoid duplicating the full settings surface — this toolbar is for the settings developers reach for most. Deep configuration still lives in VS Code settings.

**Effort:** S — webview HTML/CSS for the toolbar strip, message protocol additions, and config-write round-trip. Roughly 4–6 hours.

---

## Keyboard input handling in preview

**Status:** 📋 Pending

Once the full runtime (M8+M9) is running, the preview webview becomes an interactive WoW-like surface. WoW addons register keyboard handlers, open/close frames on key presses, and rely on the default WoW keybindings (e.g. ESC closes the topmost open frame). The webview's default key behavior will conflict with this.

**Questions to resolve before implementing:**

1. **ESC key** — In VS Code's webview, ESC closes the panel or blurs the editor. In WoW, ESC closes the topmost open full-screen frame (the "UISpecialFrames" stack). These two behaviors conflict. Options: (a) intercept ESC in the webview and synthesize a WoW `ESCAPE_PRESSED` event, letting VS Code's ESC only fire if no WoW frame consumes it; (b) provide a toggle to "capture keyboard input" that swallows ESC; (c) document the conflict and let addon authors work around it.

2. **WoW default keybindings** — WoW has a large default keybinding table (movement, targeting, action bars, etc.). Most are irrelevant to UI addon development. The preview only needs to emulate bindings that addons are likely to test: ESC, Enter, Tab, and any custom bindings an addon registers via `SetBinding`/`SetBindingClick`.

3. **Input capture toggle** — A panel control (button or checkbox: "Capture keyboard") that, when active, routes all keystrokes through the Lua event bridge (`KeyDown`, `KeyUp` events) rather than letting them bubble to VS Code. Pressing the toggle again (or pressing a configurable release chord like Ctrl+ESC) releases capture.

4. **Virtual gamepad / binding emulation** — Out of scope for now, but note it for the future: addons that use controller input will need a different strategy.

**Approach:**

- Phase 1 (this item): resolve questions 1–3, write an ADR on the keyboard capture strategy, and implement input capture toggle + ESC routing in the webview.
- Phase 2 (deferred): full binding table emulation if real addons require it.

**Effort:** S–M — the design question is the hard part; once the strategy is decided, webview event listener setup + Lua event dispatch is ~4–8 hours.

---

## Addon state emulation

**Status:** 📋 Pending

Real WoW addons react to game state: player health drops, a new buff is applied, a quest completes, the player enters combat. Testing these reactions in the real game requires either waiting for the right game event or using test tools that exist inside the game. Neither is CI-friendly.

**Goal:** A secondary scripting layer that lets addon authors (or a test addon) drive simulated game state changes, so that a Scryer test suite can assert "when player health drops below 20%, the low-health flash frame becomes visible" without a running WoW client.

**Concept — "addons testing addons":**

An author ships a companion addon (e.g. `MyAddon_Tests`) that uses a Scryer-specific API to manipulate state:

```lua
-- hypothetical Scryer test API
ScryerTest.SetUnitHealth("player", 0.15)  -- fires UNIT_HEALTH event
ScryerTest.SimulateEvent("COMBAT_LOG_EVENT_UNFILTERED", ...)
ScryerTest.Assert(MyAddon.lowHealthFrame:IsShown(), "low health frame should be visible")
```

This is not a general WoW emulator — it only needs to cover the subset of game state that UI addons can _observe_ (unit stats, events, aura states, etc.), not the subset they _cause_ (damage dealt, movement, etc.).

**Architecture:**

- `ScryerTest` is a global table injected into the sandbox alongside the WoW API stubs (M6). It is absent from the real WoW environment (addons that accidentally ship test code get a no-op stub or an error, not a game-breaking call).
- `ScryerTest.SimulateEvent(event, ...)` — fires the named event on the frame event bus, reaching any addon that called `frame:RegisterEvent(event)`.
- `ScryerTest.SetUnitHealth` / `SetUnitAura` / etc. — update the mock state tables backing `UnitHealth`, `UnitBuff`, etc. stubs, then fire the corresponding event.
- Test results flow back via `ScryerTest.Assert` / `ScryerTest.Fail` → collected by the extension host → shown in VS Code Test Explorer (M12).

**Depends on:** M12 (Test Suite) for the runner and Test Explorer integration. M9 (Script Events) for the event bridge that `SimulateEvent` needs.

**Effort:** M–L — the state tables and `SimulateEvent` wiring are S; a comprehensive enough stub surface to cover real addon test patterns is M; a VS Code Test Explorer integration is M. Total is M–L depending on how complete the stub surface needs to be.

---

## WYSIWYG widget placement

**Status:** 📋 Pending

Addon developers often prototype frame layouts by guessing anchor values and reloading. A drag-to-place mode in the preview would let them position frames visually and get the correct anchor XML or Lua back without any trial-and-error.

**Goal:** Click a frame in the live preview, drag it to a new position, and have Scryer emit the updated `<AbsInset>` / `<Anchor>` XML fragment or Lua `SetPoint` call that reproduces that position.

**What makes this hard:**

WoW's anchor system is constraint-based — a frame's position is determined by up to two anchor points, each relative to a named frame and a point (TOPLEFT, CENTER, etc.). Inverting a rendered position back to an anchor description is ambiguous: the same pixel position can be expressed as dozens of valid anchor combinations. The tool needs a strategy for which anchor form to prefer (e.g. preserve the existing anchor type and only update the offsets, or default to `TOPLEFT` + `BOTTOMRIGHT` for two-anchor frames).

**Rough plan:**

1. **Drag affordance in webview** — in a "placement mode" (toggled via toolbar or command), frames become draggable. Mouse events update a ghost overlay; on drop, the new absolute position is reported to the extension host.
2. **Anchor inversion** — given the frame's current anchor configuration (from the IR) and its new pixel position, compute updated `x`/`y` offsets. If the frame has two anchors that fix both axes, update both offsets independently. If one anchor is `CENTER`, update to keep it centered at the new position.
3. **Output** — show a small popover or notification with the updated XML snippet. "Copy to clipboard" button. Optionally, offer to write the change back to the source file directly (this is the risky path — file writes require confirming the right source location).
4. **Resize handles** — extend drag to the frame edges/corners for resizing, which requires updating `<Size>` values and/or the second anchor's offset.

**Constraints:**

- Frames with templated anchors (where the anchor is in a Blizzard parent template) cannot be written back to the source file — only frames with anchors directly in the addon XML are candidates for in-place editing.
- This feature is UI-only (no runtime state changes); it operates on the rendered layout, not the Lua frame object.

**Depends on:** M7 (Frame Object Model) for the live panel and frame identity tracking; M9 (Script Events) for the event bridge that drag events will use.

**Effort:** L — the drag affordance and anchor inversion for simple cases are S; handling the full variety of anchor configurations (CENTER, relative-to-sibling, two-axis independence) is M; safe source-file write-back is M. Total L.

---

## Lua sandbox execution timeout (deferred from M6)

**Status:** ✅ Complete (2026-05-29)

**Problem:** wasmoon's `createEngine` accepts a `functionTimeout` option (milliseconds) that kills any JS→Lua call that exceeds the limit. Without it, a buggy or malicious addon containing an infinite loop (`while true do end`) will hang the extension host process indefinitely — blocking all VS Code UI until the user force-quits.

**Plan:** Thread a `sandboxTimeout` option through `createSandbox` (default value in `defaults.json`). Pass it as `functionTimeout` to `factory.createEngine`. Catch `LuaTimeoutError` in the execution pipeline (M8) and surface a user-visible error in the output channel. Start with a conservative default (e.g. 5 000 ms) that covers normal addon init without hitting legitimate long-running code.

**Note:** `functionTimeout` applies per JS→Lua call, not to the total session lifetime. Accumulated time across many short calls is not bounded by this. Full protection requires re-entering the sandbox via a watchdog pattern; that is out of scope here — the basic timeout handles the obvious case (tight loop at top level).

**Effort:** XS — wiring the option and catching the error is ~10 lines; choosing a sensible default requires testing against a few real addons.

**Depends on:** M8 (TOC Execution Pipeline), where addon Lua first runs end-to-end.

---

## parentKey / parentArray wiring for runtime frames (deferred from M7)

**Status:** ✅ Done (2026-05-29)

**What was built:** Wiring is emitted in `src/lua/xml-importer.ts` during Lua code generation for XML frames. After each texture, fontstring, or child frame is created, the importer now emits `parent.Key = child` (parentKey) and `parent.Array = parent.Array or {}; table.insert(parent.Array, child)` (parentArray). The actual plan (frame-class.lua + extra args to CreateFrame) was superseded — the cleaner solution is in the code-generation layer since that's where the parentKey metadata is available. Covered by 6 tests in `test/lua/xml-importer.test.ts`.

---

## StatusBar fill texture rendering (deferred from M7)

**Status:** 📋 Pending

**Problem:** `StatusBar` frames created via `CreateFrame("StatusBar", ...)` render as plain frames — no fill bar is visible. `SetValue(75)` / `SetMinMaxValues(0, 100)` sets internal state but produces no visual output.

**Plan:** In `frameNodeToIR` (or `statusBarNodeToIR`), when `statusBarValue` is set and the frame has an explicit width, synthesise a fill texture in the ARTWORK layer with width proportional to `(value - min) / (max - min)`. Apply `statusBarColor` or `statusBarTexturePath` as the fill appearance. For the case where width is not yet known at serialization time, add a `data-*` attribute to the rendered DOM element and let the webview apply the fill percentage via CSS after layout.

**Effort:** S — the serialization-time approach is straightforward; the post-layout percentage approach requires a small webview-side addition.

**Depends on:** M7 (done).

---

## Template application in runtime CreateFrame (deferred from M7)

**Status:** ✅ Done (2026-05-29)

**What was built:**

`src/lua/createframe.ts` — `registerFrameModel` gains an optional `blizzardTemplates?: Map<string, FrameIR>` parameter. A new `__scryer_apply_template(fid, templateStr)` TS callback is registered: it splits the comma-separated template string, resolves each template name against the blizzard registry via `resolveInheritance` (using a synthetic single-frame UiDocument to get the fully-merged IR), and generates a Lua code string that applies the template's layers (textures, fontstrings), size, anchors, and scripts to the existing frame. Inline script bodies are injected as `__scryer_xs${i}` Lua globals before the returned string is executed. A per-sandbox `templateCache` memoizes resolved templates to avoid repeated inheritance resolution for the same name.

`src/lua/frame-class.lua` — `CreateFrame` captures `_apply_template` at bootstrap. After creating the frame table, if the 4th argument is a non-empty string, it sets `__scryer_tpl_frame = frame`, calls `_apply_template(fid, template)` to get the code string, runs it via `load(code)()`, then clears `__scryer_tpl_frame`. The `__scryer_apply_template` global is cleared with all other helpers at the end of the bootstrap block.

`src/live-panel.ts` — `loadBlizzardTemplates()` is now called before `registerFrameModel` so the templates are available for the full addon run.

**Tests:** 7 tests in `test/lua/createframe.test.ts`: unknown template no-op, texture applied, size applied, fontstring applied, function-reference script registered, multiple comma-separated templates, global cleared after bootstrap.

**Remaining limitation:** Template child frames (nested `<Frame>` elements defined within a template's `<Frames>` block) are not instantiated — only `layers` (textures/fontstrings), size, anchors, and scripts are applied. This covers the vast majority of Blizzard templates in practice.

---

## GlobalStrings population (deferred from M5)

**Status:** ✅ Complete (2026-05-29)

**Problem:** WoW addons and Blizzard XML files reference global string constants by name — e.g. `FontString text="OKAY"` or `button:SetText(CLOSE)`. Without these constants pre-populated in `_G`, such code will silently receive `nil` and render nothing.

**Plan:** At sandbox bootstrap (before any addon code runs), populate `_G` with the 24k enUS GlobalStrings from `_reference/vscode-wow-api/src/data/globalstring/enUS.ts`. Extract the key-value pairs into a compact `src/lua/globalstrings.json` via a one-time dev script (similar to atlas manifest generation). In `createSandbox`, iterate the JSON and call `lua.global.set(key, value)` for each entry. Locale-awareness can be deferred; enUS is sufficient for all current use cases.

**Why deferred from M5:** 24k entries ~1.5 MB — loading all of them in M5 would bloat the bundle before any rendering code exists to use them. The right point to add this is M7 (Frame Object Model), when `FontString` and `SetText` rendering will immediately exercise the strings.

**Effort:** XS (extraction script + sandbox wiring once M7 is in progress).

**Implementation:** `dev/gen-globalstrings.ts` imports `enUS.ts` via esbuild and writes `src/lua/globalstrings.json` (23,955 entries, ~1.5 MB). `createSandbox` loads it via `require` and calls `lua.global.set(key, value)` for each entry. Run `pnpm run gen-globalstrings` to regenerate if the reference corpus updates.

---

## Texture tiling on dynamically created textures (NineSlice stub follow-up)

**Status:** ✅ Complete (2026-05-30)

**Problem:** `SetHorizTile` and `SetVertTile` were no-ops on `TextureMT`. The NineSlice renderer calls them on each border/edge texture piece after reading tiling flags from `C_Texture.GetAtlasInfo`.

**Implementation:** Added `horizTile`/`vertTile` fields to `TextureNode` and `TextureIR`. Added `__scryer_tex_set_horiz_tile`/`__scryer_tex_set_vert_tile` host bindings in `createframe.ts`, wired through `frame-class.lua`. In the webview renderer, these flags override the atlas manifest's `tilesH`/`tilesV` when set (`tex.horizTile ?? ra.tilesH`).

---

## `SetDrawLayer` on dynamically created textures (NineSlice stub follow-up)

**Status:** ✅ Complete (2026-05-30)

**Problem:** `SetDrawLayer` was a no-op on `TextureMT`. NineSlice pieces were left in the default `ARTWORK` layer rather than `BORDER`.

**Implementation:** Added `__scryer_tex_set_draw_layer(id, layer, subLevel)` host binding in `createframe.ts`, wired through `frame-class.lua`. Updates `TextureNode.layer` and `TextureNode.subLevel` in the registry; `textureNodeToIR` already reads these fields, so no IR or renderer changes were needed.

---

## Full Blizzard_SharedXML Lua corpus loading

**Status:** ✅ Complete (2026-05-30)

**Problem:** Only `NineSlice.lua` and `NineSliceLayouts.lua` were loaded before running the user's addon.

**Implementation:** Added `blizzardAddonLuaFiles(addonsDir, addonName)` to `blizzard-registry.ts` — parses the addon's `_Mainline.toc` (via `findTocPath` + `parseToc`) and returns all Lua file paths in TOC order. Added `AssetService.blizzardAddonLuaFiles(addonName)` as a convenience wrapper. In `live-panel.ts`, replaced the hardcoded two-file list with a TOC-driven loop over `Blizzard_SharedXML`. Files that error at runtime are silently skipped (`debug` log only) so a broken stub doesn't abort the load.

---

## `C_Texture.GetAtlasInfo` full field set

**Status:** ✅ Complete (2026-05-30)

**Problem:** The stub returned only `{ tilesHorizontally, tilesVertically }`. It also returned nil when no atlas manifest was available, causing `SetAtlas` to never be called (because NineSlice gates on `if info then`). Atlas names with `_`/`!` tiling-hint prefixes also failed to look up.

**Implementation:** `C_Texture.GetAtlasInfo` is now always overridden. Lookup tries the original (lowercased, prefix-intact) name first, then stripped variants — matches the manifest key format which preserves `_`/`!`. Tiling flags are forced true from the prefix (`_` → `tilesHorizontally`, `!` → `tilesVertically`) independent of manifest metadata, since the manifest `tilesH/V` fields do not reliably reflect WoW's prefix convention. With manifest: returns full `{ tilesHorizontally, tilesVertically, width, height, leftTexCoord, rightTexCoord, topTexCoord, bottomTexCoord }`. Without manifest: returns `{ tilesHorizontally, tilesVertically }` derived from prefix so `SetAtlas` is still called. Same prefix-aware lookup applied to `resolveAtlasInTexture` in `panel.ts`/`live-panel.ts`.

---

## Texture-to-texture SetPoint anchor resolution

**Status:** ✅ Complete (2026-05-30)

**Problem:** When `piece:SetPoint(point, otherTexture, ...)` was called (e.g. NineSlice edges anchoring to corner pieces), `resolveRelTo` only looked up frames by ID, not textures. The anchor got `relativeTo: undefined`, causing edges to fall back to the parent frame — completely wrong sizing.

**Plan:** Give each runtime texture a synthetic name `$tex:<id>`. `registry.resolveRelTo` now also checks `_textureNodes` and returns `"$tex:<id>"` for texture IDs. `textureNodeToIR` assigns `name: tex.name ?? "$tex:${tex.id}"` so the layout engine's `collectNames` registers the synthetic name and sibling anchors resolve correctly.

**Effort:** XS

---

## Cross-layer NineSlice layout

**Status:** ✅ Complete (2026-05-30)

**Problem:** The renderer called `layoutAll` separately for each draw layer. NineSlice places the Center in `BACKGROUND` and the corners/edges in `BORDER`. Because each layer's `layoutAll` only built a registry from its own objects, the Center's two opposing anchors (targeting BORDER-layer corners) were unresolvable — they fell back to the viewport rect, producing a negative-size rect. The Center then rendered at atlas intrinsic size (64×64) at the wrong position instead of spanning the tooltip interior.

**Implementation:** Before rendering any layer, `renderFrame` now collects all layer objects via `flatMap` and runs a single `layoutAll` over the combined list. Each texture's synthetic `$tex:<id>` name is registered once; cross-layer anchor resolution works because all textures share the same registry and rect map.

---

## Atlas manifest prefix-aware lookup in `resolveAtlasInTexture`

**Status:** ✅ Complete (2026-05-30)

**Problem:** `resolveAtlasInTexture` in `panel.ts` and `live-panel.ts` stripped the `_`/`!` tiling-hint prefix from atlas names before looking them up in the manifest. The manifest stores keys with the prefix intact (`"_tooltip-nineslice-edgetop"`), so edge textures returned no manifest entry — `resolvedAtlas` stayed undefined, `tex.size` was never pre-filled, and the constrained axis (height for horizontal edges, width for vertical edges) collapsed to 0.

**Implementation:** Lookup now tries the original lowercased name first (`manifest[origLower]`), then the stripped variants as fallback. Edge textures now resolve correctly: `size: {x:16, y:7}` for top/bottom edges and `size: {x:7, y:16}` for left/right edges, giving them the correct thickness and proper position.

---

## `useAtlasSize` render-time dimension override in `applyAsset`

**Status:** ✅ Complete (2026-05-30)

**Problem:** When an atlas image loaded asynchronously, `applyAsset` in `main.ts` checked `crop.useAtlasSize` and, if true, overrode the element's CSS `width`/`height` to the atlas sprite dimensions. The layout engine had already computed correct sizes via opposing anchors (NineSlice Center: 234×154 for a 240×160 frame), but `applyAsset` shrank it back to the raw atlas size (64×64), making the Center appear as a small square at the top-left of the frame.

**Implementation:** Removed the `useAtlasSize` dimension override from `applyAsset`. The function now always uses `el.offsetWidth`/`el.offsetHeight` (the layout-computed CSS size) for the background-scale calculation, with `crop.width`/`crop.height` as a fallback only when `offsetWidth` is zero. This makes atlas images fill their layout-assigned element regardless of the original atlas sprite size.

---

## `Color:GenerateHexColor` stub — unblocks `sharedcolorconstants.lua`

**Status:** ✅ Done (2026-05-30)

**Problem:** `sharedcolorconstants.lua` fails on load: `attempt to call a nil value (method 'GenerateHexColor')`. This file defines the global color constants every WoW addon relies on — `NORMAL_FONT_COLOR`, `HIGHLIGHT_FONT_COLOR`, `RED_FONT_COLOR`, etc. Because the file is skipped, these constants are nil when user addons run, breaking any addon that uses standard WoW text coloring.

**What was built:**

`src/lua/wow-api.ts` — Added a full `ColorMixin` table and `CreateColor(r, g, b, a)` function to the SharedXML pre-stubs block. Uses `setmetatable({}, { __index = ColorMixin })` rather than `Mixin()` to avoid a dependency on `frame-class.lua` at stub-load time. Methods implemented: `GenerateHexColor()` (AARRGGBB, 8 hex chars), `GenerateHexColorMarkup()` (`|cAARRGGBB`), `WrapTextInColorCode(text)`, `GetRGB()`, `GetRGBA()`, `GetRGBAsBytes()`, `GetRGBAAsBytes()`, `SetRGB()`, `SetRGBA()`, `IsEqualTo()`. Also added `GenerateHexColorFromHexValues(r, g, b)` (byte values 0–255) and `WrapTextInColorCode(text, hexStr)` as standalone globals. The faction color table stubs (`PLAYER_FACTION_COLOR_HORDE` / `PLAYER_FACTION_COLOR_ALLIANCE`) were updated to use `CreateColor` instead of bare tables. When the real `Color.lua` loads from the Blizzard asset cache, it overrides these stubs.

8 tests added in `test/lua/wow-api.test.ts`.

**Effort:** XS

---

## `FlagsUtil` stub — unblocks `scrollutil.lua`

**Status:** ✅ Done (2026-05-30)

**Problem:** `scrollutil.lua` fails: `attempt to index a nil value (global 'FlagsUtil')`. `FlagsUtil` is a table of bit-flag utilities used by scroll frame code. Its absence also chains into `scrollbox.lua`, which depends on scroll utilities. Both files being skipped means `ScrollBox`, `ScrollUtil`, and associated frame templates are unavailable.

**What was built:** Added `FlagsMixin` (table with `OnLoad`/`Set`/`Clear`/`Toggle`/`IsSet` using `bit.*`) and `FlagsUtil.MakeFlags(...)` (assigns sequential power-of-2 values to named flags) to `src/lua/wow-api.ts`. `scrollutil.lua` uses only `FlagsUtil.MakeFlags`; `FlagsMixin` is also used by `minimalslider.lua`. 4 tests added in `test/lua/wow-api.test.ts`.

**Effort:** XS–S

---

## `MathUtil.Epsilon` constant — unblocks `scrollbox.lua`

**Status:** ✅ Done

**Problem:** `scrollbox.lua` fails: `attempt to perform arithmetic on a nil value (field 'Epsilon')`. This is `MathUtil.Epsilon`, a small floating-point constant (typically `1e-5`) used in scroll-position comparisons. `scrollbox.lua` failing blocks `ScrollBox` frame templates from loading.

**Plan:** Added `Epsilon = 1e-5` to the existing `MathUtil` stub in `src/lua/wow-api.ts`. The field is used by `scrollbox.lua`, `scrollcontroller.lua`, `scrollutil.lua`, and `scrollbar.lua` — all resolved by the same constant.

**Effort:** XS

---

## `EventRegistry` stub — unblocks `gamerulesutil.lua`

**Status:** ✅ Done (2026-05-30)

**Problem:** `gamerulesutil.lua` fails: `attempt to index a nil value (global 'EventRegistry')`. `EventRegistry` is the Blizzard global event-registration table used by several Blizzard shared utilities. The actual `gamerulesutil.lua` content (game rule query helpers) is unlikely to be needed for addon preview, but its failure at load time means any other file that `#include`s it or depends on it also skips.

**Plan:** Add a minimal `EventRegistry = {}` stub with `EventRegistry:RegisterCallback(...)` and `EventRegistry:TriggerEvent(...)` as no-ops. These are the methods the file calls at module level.

**Effort:** XS

---

## `UnitSex` stub — unblocks `modelframemixin.lua`

**Status:** ✅ Done (2026-05-30)

**Problem:** `modelframemixin.lua` fails: `attempt to call a nil value (global 'UnitSex')`. `UnitSex` returns the gender of a unit (1 = male, 2 = female) and is used in model frame setup. Without it, 3D model frame functionality (e.g. character dressing room frames) cannot initialise.

**Plan:** Add `UnitSex = function(unit) return 2 end` to the WoW API stubs — a constant stub is sufficient since Scryer has no real unit state. Low priority since model frames are rarely used by typical addon UIs being previewed.

**Effort:** XS

---

## `C_ScriptedAnimations.GetAllScriptedAnimationEffects` stub — unblocks `scriptedanimationeffects.lua`

**Status:** ✅ Done (2026-05-30)

**Problem:** `scriptedanimationeffects.lua` fails: `attempt to get length of a nil value (local 'effectDescriptions')`. `C_ScriptedAnimations` is stubbed as an empty namespace table, so `GetAllScriptedAnimationEffects` is `nil`; calling it returns `nil`, then `#nil` crashes at module level before `ScriptedAnimationEffectsUtil` is defined.

**Plan:** Add `C_ScriptedAnimations.GetAllScriptedAnimationEffects = function() return {} end` in `wow-api.ts` after the C\_\* namespace tables are set up.

**Effort:** XS
