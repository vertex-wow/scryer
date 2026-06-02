# Backlog Archive — Completed Items

Completed items moved from [backlog.md](backlog.md). Historical record of what was built and when.

---

## Typed scalar returns in generated stubs

**Status: Done** (2026-06-02)

**What was built:**

`dev/gen-api-stubs.ts` — replaced `needsTableReturn` with `stubRef`, which returns the Lua helper identifier based on the first non-nilable return type: `_num` (number → 0), `_bool` (boolean → false), `_str` (string → ''), or `_tbl`/`_nil` as before. `computeSigHash` updated to use `stubRef` for accurate change detection on future regeneration runs.

`src/lua/api-stubs/index.ts` — prelude extended with `_num`, `_bool`, `_str` helper definitions.

Existing `src/lua/api-stubs/retail/*.ts` stubs — patched via a one-off Node.js script that parsed EmmyLua annotation files from `_reference/vscode-wow-api/Annotations/Core/Blizzard_APIDocumentationGenerated/`. 2096 assignments updated across 226 stub files based on first non-nilable `@return` type.

`test/lua/wow-api.test.ts` — updated to reflect new behavior: added `typed scalar stubs return default values` test; renamed and narrowed the nil check to use a void-returning function.

**Approach used:** Auto-detect from first non-nilable `Returns[0]` type. Enum types (e.g. `Enum.XYZ`) are not detected as scalar since annotations use the enum type name, not `number` — they remain `_nil`. A sidecar override mechanism was not implemented; auto-detect covers the primary `GetNumX()` crash case.

---

## WoW type system generation

**Status: Done** (2026-06-02)

**What was built:**

`dev/gen-api-stubs.ts` — added `buildEnumRegistry` (collects `Type = "Enumeration"` table names), `mapTsType` (maps WoW field types to TypeScript — primitives, struct refs, enum refs → `number`, arrays via `InnerType`), and `generateTypesContent` (emits one `export interface` per `Type = "Structure"` table, deduped by name). Called from `run()` for retail flavor runs only.

`src/lua/api-stubs/types.ts` (generated, 711 interfaces) — TypeScript interfaces for every Blizzard Structure. Fields use the correct TypeScript types: scalar primitives map to `number`/`string`/`boolean`; struct-typed fields reference the generated interface by name; typed arrays (`Type = "table"`, `InnerType = "Foo"`) emit `Foo[]`; known Enumeration names emit `number`; unrecognized types emit `unknown`. Nilable fields get `?`.

**Approach:** Single flat file — no imports needed since TypeScript interfaces support forward references within a file. Emit for retail only (retail is the struct superset; classic/classic_era runs skip it).

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

**Status: Done**

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

**Status: Done** (2026-05-31)

**What was built:**

On activation, `maybeShowSetupNotice()` in `extension.ts` fires a one-time `showInformationMessage` when the user has no usable extraction setup:

- Skipped if `scryer.installDir` is set AND `rustydemon-cli` is available (PATH or `scryer.cascToolPath`) — extraction will run automatically on first panel open.
- Skipped if `<sourceDir>/Interface/` already exists on disk (prior extraction ran).
- Gated by `workspaceState("scryer.assetSetupNoticeSeen")` — shown once per workspace, never re-nags.

Message text is conditioned on what's missing:

- Both `installDir` and tool absent → mentions both `scryer.installDir` and `scryer.cascToolPath`.
- Only `installDir` absent → mentions `scryer.installDir` only.

Buttons:

- **Open Settings** → `workbench.action.openSettings` filtered to `@ext:scryer`.
- **Learn More** → opens `docs/configuration.md` in VS Code's Markdown preview.

Output channel also gains startup `warn` lines when `installDir` is unset or `rustydemon-cli` is not found — both fire via `logAssetParams` at activation and on config change.

`AssetService` additions: `cascToolPath` getter, `isCascToolAvailable()` (synchronous PATH probe via `spawnSync which/where`), `hasExtractedAssets()` (async `fs.stat` on `<sourceDir>/Interface/`). The PATH probe logic is shared with `extract-core.ts` via new exported `isCascToolAvailable()`.

**Effort:** S — within estimate.

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

**Note:** This unblocked the `Blizzard FrameXML template corpus loading` item — the XML files are now available at `.wow-assets/Interface/AddOns/`. Long-term, once the in-process CASC reader lands, this extraction can happen on demand automatically.

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

**Status: Done** (2026-05-31)

**Background:** `ensureFilteredListfile` (added in the Listfile pre-filter item) runs `grep -F ';interface/'` to produce `listfile-interface.csv` whenever `listfile.csv` is newer. This pays the grep cost once per download, which is ~110 ms and already cheap. However, the validity of the filtered file is coupled only to file mtimes — if `listfile.csv` is re-downloaded for any reason (manual refresh, future CDN change, migration to per-release URLs), the filter re-runs unnecessarily even when the underlying WoW build is identical.

The official community listfile from [wowdev/wow-listfile](https://github.com/wowdev/wow-listfile) publishes per-release verified files tied to specific WoW build numbers. Our cached filtered file should match that granularity: one filtered file per WoW build, reused across all listfile re-downloads for that build.

**Problem:** The mtime-based skip logic in `ensureFilteredListfile` does not know what WoW build the filtered file was generated for. A listfile re-download (e.g. after switching to GitHub release URLs) triggers a re-filter even if the game data hasn't changed.

**Goal:** Tie the filtered listfile cache to the WoW build number read from `.build.info` so the filter cost is paid exactly once per patch cycle — not once per download.

**Plan:**

1. After filtering, write a stamp file alongside `listfile-interface.csv` (e.g. `listfile-interface.stamp`) containing the current flavor build text (from `readBuildText`).
2. In `ensureFilteredListfile`: read the stamp; if the stamp matches the current build text and `listfile-interface.csv` exists, skip filtering regardless of `listfile.csv` mtime.
3. If `scryer.installDir` is unset (no `.build.info` to read), fall back to the existing mtime check — no regression for users without a configured install.
4. Update `ensureFilteredListfile`'s signature to accept an optional `buildText?: string` so callers can pass the already-read build text without an extra disk read.

**Effort:** XS — ~30 lines in `extract-core.ts` (stamp read/write + build-text comparison). No new dependencies.

---

## Listfile source and capitalization strategy

**Status: Done** (2026-05-31)

Switched to `community-listfile-withcapitalization.csv` from the same `wowdev/wow-listfile` `releases/latest` URL. Path strings in the listfile now use WoW canonical capitalisation (`Interface/Buttons/UI-CheckBox-Check.blp`). The `filterListfile` grep patterns updated to `";Interface/"` / `";Fonts/"` to match.

`resolveCI` is unchanged — rustydemon-cli still lowercases output filenames on Linux regardless of the listfile content. `resolveCI` removal is deferred to [In-process CASC reader](backlog.md#in-process-javascript-casc-reader-replace-extractsh--rustydemon-cli) when we own the output path.

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

**Status: Done** (2026-05-31) — `userAddonPreload="workspace"` triggers at extension activation (not panel-open). Three passes run in the background, all git-ignore filtered:

1. **XML scan** — parses every workspace `.xml`, resolves inheritance against the Blizzard registry, and calls `assets.resolveToAbsPath` for every referenced texture path (including paths that resolve into extracted game files via inherited Blizzard templates).
2. **Loose BLP scan** — globs `**/*.blp` and pre-warms any addon-bundled textures not captured by the XML scan.
3. **SVG conversion** — globs `**/*.svg`; for each without a sibling `.png`, runs `rsvg-convert` to produce one; if a `.tga` is also absent and a flip tool (`gm` / `convert`, configurable via `scryer.imageConvertPath`) is available, flips the PNG vertically to TGA (the format WoW expects). The SVG→PNG and PNG→TGA logic lives in `src/assets/svg.ts` and is also used by `dev/assets.ts`.

Per-panel workspace scan removed from `panel.ts`.

---

## Preload settings — `scryer.startupContent` + `scryer.userAddonPreload`

**Status: Done** (2026-05-31) — All tiers and modes fully implemented; degradation warning added for texture tiers when source is unpopulated.

**Supersedes:** The earlier single-setting `scryer.preloadScope` design. That design conflated two orthogonal axes (static Blizzard library scope vs. dynamic per-edit addon scope) into one enum, making it impossible to express e.g. "all Blizz templates but on-demand for my addon."

---

### `scryer.startupContent` (default `"all-templates-shared-textures"`)

Controls what Blizzard template and asset content Scryer loads when the extension activates. This is a static, one-time load at startup — the Blizzard corpus is shared across all previews.

| Value                             | Behavior                                                                   |
| --------------------------------- | -------------------------------------------------------------------------- |
| `"none"`                          | Nothing preloaded                                                          |
| `"shared-templates"`              | Preload `Blizzard_SharedXML` template definitions                          |
| `"all-templates"`                 | Preload all Blizzard addon template definitions                            |
| `"all-templates-shared-textures"` | All templates + decodes shared BLPs (all three addons); ~2.4 MB, ~15s cold |
| `"all-templates-textures"`        | All templates + all Blizzard textures                                      |

---

### `scryer.userAddonPreload` (default `"current-file"`)

Controls how eagerly Scryer pre-warms texture assets for the addon currently being previewed. This is a dynamic, per-session scope that runs continuously as the user edits.

| Value            | Behavior                                                       |
| ---------------- | -------------------------------------------------------------- |
| `"on-demand"`    | Decode textures only when the webview requests them            |
| `"saved-file"`   | Pre-warm textures referenced by the currently saved file       |
| `"current-file"` | Pre-warm textures for the current file including unsaved edits |
| `"workspace"`    | Pre-warm textures for all WoW XML files in the workspace       |

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

**What was built:** A layered configuration system that defines per-flavor display defaults, ships with the extension for each known flavor, and lets users override or extend it via `scryer.flavorConfigPath`. See `src/flavors/defaults.json` and `docs/configuration.md`.

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

1. **Manifest format** — JSON at `<cacheRoot>/<flavor>/derived/atlas-manifest.json` mapping `atlasName → { file, x, y, width, height, sheetW, sheetH, tilesH, tilesV }`.
2. **`src/assets/atlas-manifest.ts`** — `AtlasEntry` / `AtlasManifest` types; `loadAtlasManifest(path)` disk loader.
3. **`AssetService.loadAtlasManifest()`** — reads from `<texturesConvDir>/../atlas-manifest.json`.
4. **IR enrichment in `panel.ts`** — fills `TextureIR.resolvedAtlas` from the manifest before sending the render message.
5. **Renderer** — emits `data-asset-path` + `data-atlas-crop` when `resolvedAtlas` is set.
6. **Webview `applyAsset`** — detects `data-atlas-crop` and computes `background-size`/`background-position` using pixel math.
7. **`dev/gen-atlas.mjs`** — generates the manifest JSON from UiTextureAtlas CSV exports (auto-downloaded from wago.tools) joined with the community listfile.
8. **Atlas name lookup** — case-insensitive with `-2x` suffix fallback.

**Post-completion fixes:** `dev/extract.sh` progress message redirect; atlas manifest generation retry on extraction; `package.json` cache-clear scripts.

---

## JS entry-point runners (replace dev shell scripts)

**Status: ✅ Done (2026-05-28)**

**What was built:**

`src/assets/atlas-gen.ts` — self-contained atlas manifest generation library. Exports `generateAtlasManifest(opts)`.

`src/assets/extract-core.ts` — self-contained extraction library. Exports `extractPaths()`, `extractBulk()`, and `ensureListfile()`.

`src/assets/extractor.ts` — replaced entirely. Now a thin vscode wrapper around the two core libraries.

`dev/extract.ts` — thin CLI shim replacing `dev/extract.sh`. `dev/gen-atlas.ts` — thin CLI shim replacing `dev/gen-atlas.mjs`.

`dev/config.json.example` — replaces `dev/config.sh.example`. `package.json` — added `pnpm run extract` and `pnpm run gen-atlas` scripts. Removed `scryer.extractScriptPath` setting.

**Architecture:** `src/` is the source of truth. `dev/` scripts are thin CLI entry points that import and call `src/` functions.

---

## User-visible loading notifications

**Status: Done** (2026-05-31)

**What was built:**

1. **In-panel loading indicator** — `{ type: "setStatus"; state: "idle" | "extracting" | "buildingAtlas" }` added to `HostMessage`. `main.ts` handles it: on non-idle states, replaces the `#debug` span with a spinner message; on `idle`, restores the last render message.

2. **Status bar spinner** — `ScryerPanel` gains `pendingOps: Set<"extracting" | "buildingAtlas">`. `startOp()`/`endOp()` sync both the webview status and a `loadingBar: vscode.StatusBarItem`.

3. **Startup preload notification** — `prewarmBlizzardTextures()` calls wrapped in `vscode.window.withProgress`.

---

## Texture placeholder hover tooltip

**Status: ✅ Done (2026-05-30)**

**What was built:**

- `src/webview/placeholder.ts` — `makePlaceholder` sets `div.dataset.phLabel` (the full un-truncated path or label) on the placeholder container div.
- `src/webview/main.ts` — a custom tooltip overlay div (`phTooltip`) positioned via `mousemove` and hidden via `mouseleave`. Detection uses `document.elementsFromPoint(x, y)` on every `mousemove`, which returns all elements at the cursor in z-order regardless of `pointer-events` — including placeholders visually beneath child frames.

---

## WoW font loading (FRIZQT\_\_.TTF from CASC)

**Status: ✅ Done (2026-05-28; non-blocking fix 2026-05-30)**

**What was built:**

- `src/assets/resolver.ts` — extended `AssetKind` to include `"font"` for `.ttf`/`.otf`.
- `src/assets/index.ts` — `_resolve()` passes `font` kind through directly; added `claimExtraction(rawPath)` dedup guard.
- `src/assets/extract-core.ts` — `extractRetailPaths()` switched to `ensureListfile` (full community listfile) for font paths outside `Interface/`.
- `src/panel.ts` — font resolution is **non-blocking**: `renderFile()` resolves the font from cache immediately (fast path), fires `extractAndSendFont()` as fire-and-forget if absent. When extraction completes, a `{ type: "fontResolved" }` message injects the `@font-face` rule without a full re-render.

**Why non-blocking matters:** The original blocking implementation caused a spurious third re-render after font extraction (~6 min cold) that wiped the DOM exactly as texture `assetResolved` messages were arriving, leaving the preview blank.

---

## All preview chrome values configurable via defaults.json

**Status: ✅ Done (2026-05-29)**

Extended `src/flavors/defaults.json` and related types to cover every previously hardcoded value in the preview. New fields: `uiParentHeight`, `fontLetterSpacing`, `autoFontSizeRatio`, `fontSmoothing`, viewport background/checker, ruler appearance, status bar, placeholder tiles, and layout solver parameters. All consumers updated to read from config. Documentation updated across `CLAUDE.md`, `docs/configuration.md`, `docs/advancedConfiguration.md`, and `README.md`.

---

## FontString rendering fidelity

**Status: ✅ Done (2026-05-28)**

Three fixes:

1. **`justifyH` default** — WoW defaults to `CENTER` (not `LEFT`). Applied `fs.justifyH ?? "CENTER"` and `fs.justifyV ?? "MIDDLE"`.
2. **Zero-width rect** — FontString with only a vertical anchor gets `left: 0; width: 100%` rather than explicit zero-width pixels.
3. **Letter-spacing fudge** — WoW's DirectWrite renderer produces ~6.3% wider advance widths than the browser's ClearType. Calibrated at `0.033em` applied as `letter-spacing` on the span.

---

## Center frame content on open

**Status: ✅ Done (2026-05-30)**

After `layoutAll` runs, compute the union bounding box of all top-level frame elements and derive a scroll offset that centers it within the visible panel. Scroll position persists across re-renders of the same file; centering only fires on a new file open (`msg.type === "render"`, not hot-reload).

---

## Grab pan and zoom on the preview canvas

**Status: ✅ Done (2026-05-31)**

CSS-transform model — `#viewport` uses `transform:translate(panX,panY) scale(panZoom)`. Two toolbar modes: **Grab** (default) and **Interact**. **Re-center** and **Zoom dropdown** (Fit / 25–400% presets) also added. Controls: drag/middle-drag/space+drag = pan; scroll = pan; Ctrl+scroll = zoom toward cursor; Ctrl+0 = fit; Ctrl+Shift+0 = reset 100%.

---

## Canvas scroll in all directions and always-show scrollbars

**Status: ✅ Done (2026-05-30)**

Body padding expanded to one UIParent dimension on each side. `overflow:scroll` ensures scrollbars are always visible. On initial render, `window.scrollTo(padH, padV)` places the WoW origin at the natural gutter position.

---

## Preview settings toolbar

**Status: ✅ Done (2026-05-31)**

Three quick-switch dropdowns added to the preview status bar: Flavor (`scryer.flavor`), Resolution (`scryer.screenResolution`, 13 presets), and Locale (`scryer.locale`, all 13 WoW client locales). Webview sends `{ type: "settingChange"; key; value }` → host writes config → `onDidChangeConfiguration` fires → re-render.

---

## Lua sandbox execution timeout (deferred from M6)

**Status: ✅ Complete (2026-05-29)**

`sandboxTimeout` option threaded through `createSandbox` (default value in `defaults.json`), passed as `functionTimeout` to `factory.createEngine`. `LuaTimeoutError` caught in the execution pipeline and surfaced to the output channel. Note: applies per JS→Lua call, not total session lifetime.

---

## parentKey / parentArray wiring for runtime frames (deferred from M7)

**Status: ✅ Done (2026-05-29)**

Wiring emitted in `src/lua/xml-importer.ts` during Lua code generation. After each texture, fontstring, or child frame is created, the importer emits `parent.Key = child` (parentKey) and `parent.Array = parent.Array or {}; table.insert(parent.Array, child)` (parentArray). Covered by 6 tests in `test/lua/xml-importer.test.ts`.

---

## Template application in runtime CreateFrame (deferred from M7)

**Status: ✅ Done (2026-05-29)**

**What was built:**

`src/lua/createframe.ts` — `registerFrameModel` gains optional `blizzardTemplates` parameter. `__scryer_apply_template(fid, templateStr)` TS callback resolves templates via `resolveInheritance` and generates Lua code applying layers, size, anchors, and scripts. Per-sandbox `templateCache` memoizes resolved templates.

`src/lua/frame-class.lua` — `CreateFrame` calls `_apply_template` when 4th arg is a non-empty string, runs the returned code string, then clears the helper global.

**Tests:** 7 tests in `test/lua/createframe.test.ts`.

**Remaining limitation:** Template child frames (nested `<Frame>` elements within a template's `<Frames>` block) are not instantiated.

---

## GlobalStrings population (deferred from M5)

**Status: ✅ Complete (2026-05-29)**

`dev/gen-globalstrings.ts` imports `enUS.ts` via esbuild and writes `src/lua/globalstrings.json` (23,955 entries, ~1.5 MB). `createSandbox` loads it via `require` and calls `lua.global.set(key, value)` for each entry. Run `pnpm run gen-globalstrings` to regenerate if the reference corpus updates.

---

## Texture tiling on dynamically created textures (NineSlice stub follow-up)

**Status: ✅ Complete (2026-05-30)**

Added `horizTile`/`vertTile` fields to `TextureNode` and `TextureIR`. Added `__scryer_tex_set_horiz_tile`/`__scryer_tex_set_vert_tile` host bindings in `createframe.ts`, wired through `frame-class.lua`. Renderer uses these flags to override atlas manifest `tilesH`/`tilesV` when set.

---

## `SetDrawLayer` on dynamically created textures (NineSlice stub follow-up)

**Status: ✅ Complete (2026-05-30)**

Added `__scryer_tex_set_draw_layer(id, layer, subLevel)` host binding in `createframe.ts`, wired through `frame-class.lua`. Updates `TextureNode.layer` and `TextureNode.subLevel` in the registry.

---

## Full Blizzard_SharedXML Lua corpus loading

**Status: ✅ Complete (2026-05-30)**

Added `blizzardAddonLuaFiles(addonsDir, addonName)` to `blizzard-registry.ts` — parses the addon's `_Mainline.toc` and returns all Lua file paths in TOC order. In `live-panel.ts`, replaced the hardcoded two-file list with a TOC-driven loop over `Blizzard_SharedXML`. Files that error at runtime are silently skipped.

---

## `C_Texture.GetAtlasInfo` full field set

**Status: ✅ Complete (2026-05-30)**

`C_Texture.GetAtlasInfo` now always overridden. Lookup strips `_`/`!` tiling-hint prefixes. Tiling flags are forced true from the prefix independent of manifest metadata. With manifest: returns full 8-field struct. Without manifest: returns `{ tilesHorizontally, tilesVertically }` from prefix so `SetAtlas` is still called.

---

## Texture-to-texture SetPoint anchor resolution

**Status: ✅ Complete (2026-05-30)**

Each runtime texture gets a synthetic name `$tex:<id>`. `registry.resolveRelTo` now also checks `_textureNodes`. `textureNodeToIR` assigns `name: tex.name ?? "$tex:${tex.id}"` so the layout engine's `collectNames` registers the synthetic name and sibling anchors resolve correctly.

---

## Cross-layer NineSlice layout

**Status: ✅ Complete (2026-05-30)**

Before rendering any layer, `renderFrame` now collects all layer objects via `flatMap` and runs a single `layoutAll` over the combined list. Cross-layer anchor resolution works because all textures share the same registry and rect map.

---

## Atlas manifest prefix-aware lookup in `resolveAtlasInTexture`

**Status: ✅ Complete (2026-05-30)**

Lookup now tries the original lowercased name first (`manifest[origLower]`), then stripped variants as fallback. Edge textures now resolve correctly with proper `size` values.

---

## `useAtlasSize` render-time dimension override in `applyAsset`

**Status: ✅ Complete (2026-05-30)**

Removed the `useAtlasSize` dimension override from `applyAsset`. The function now always uses `el.offsetWidth`/`el.offsetHeight` (the layout-computed CSS size) for the background-scale calculation, with `crop.width`/`crop.height` as a fallback only when `offsetWidth` is zero.

---

## `Color:GenerateHexColor` stub — unblocks `sharedcolorconstants.lua`

**Status: ✅ Done (2026-05-30)**

Added full `ColorMixin` table and `CreateColor(r, g, b, a)` function to `src/lua/wow-api.ts`. Methods: `GenerateHexColor`, `GenerateHexColorMarkup`, `WrapTextInColorCode`, `GetRGB`, `GetRGBA`, `GetRGBAsBytes`, `GetRGBAAsBytes`, `SetRGB`, `SetRGBA`, `IsEqualTo`. Also added `GenerateHexColorFromHexValues` and standalone `WrapTextInColorCode` globals. 8 tests added.

---

## `FlagsUtil` stub — unblocks `scrollutil.lua`

**Status: ✅ Done (2026-05-30)**

Added `FlagsMixin` (table with `OnLoad`/`Set`/`Clear`/`Toggle`/`IsSet` using `bit.*`) and `FlagsUtil.MakeFlags(...)` to `src/lua/wow-api.ts`. 4 tests added.

---

## `MathUtil.Epsilon` constant — unblocks `scrollbox.lua`

**Status: ✅ Done**

Added `Epsilon = 1e-5` to the existing `MathUtil` stub in `src/lua/wow-api.ts`.

---

## `EventRegistry` stub — unblocks `gamerulesutil.lua`

**Status: ✅ Done (2026-05-30)**

Added minimal `EventRegistry = {}` stub with `RegisterCallback` and `TriggerEvent` as no-ops.

---

## `UnitSex` stub — unblocks `modelframemixin.lua`

**Status: ✅ Done (2026-05-30)**

Added `UnitSex = function(unit) return 2 end` to the WoW API stubs.

---

## `C_ScriptedAnimations.GetAllScriptedAnimationEffects` stub — unblocks `scriptedanimationeffects.lua`

**Status: ✅ Done (2026-05-30)**

Added `C_ScriptedAnimations.GetAllScriptedAnimationEffects = function() return {} end` after the C\_\* namespace tables in `wow-api.ts`.
