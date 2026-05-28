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

**Remaining limitation:** Code-driven templates (`NineSlicePanelTemplate` → `NineSliceCodeTemplate`) have no XML textures; nine-slice borders still require M4 (Lua runtime) to render correctly. All purely XML-defined templates (DefaultPanelTemplate, InsetFrameTemplate, BasicFrameTemplate, etc.) now render correctly.

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

## Output channel logging and `scryer.logLevel` setting

**Status: Done** (2026-05-26)

**What was built:**

`src/parser/inherit.ts` — `resolveInheritance` now accepts an options object `{ warnings?, pending?, warn? }` as its third parameter (replaces the old positional `warnings` + `pending` args). All `console.warn`/`console.log` calls removed; messages are routed through the optional `warn?: (msg: string) => void` callback instead. This keeps `inherit.ts` a pure module with no VSCode dependency and makes it fully testable without mocking.

`package.json` — Added `scryer.logLevel` enum setting (`"off"` / `"warn"` / `"verbose"`, default `"warn"`).

`src/panel.ts` — Switched to `vscode.LogOutputChannel` (`createOutputChannel("Scryer", { log: true })`). Two helpers: `logLevel()` reads `scryer.logLevel` and returns the matching `vscode.LogLevel` enum value; `isEnabled(messageLevel)` returns true when the current level is not `Off` and is ≤ `messageLevel`. All output calls use the typed channel methods (`output.warn`, `output.debug`, `output.error`) gated on `isEnabled`:

- `Warning` and above: unknown-template and asset-not-found messages via the `warnCb` passed to `resolveInheritance`, and direct `output.warn()` for missing assets.
- `Debug` and above: Blizzard registry size, per-render frame/texture counts, and per-frame template chains.
- `Error`: render errors (also calls `output.show(true)` to surface the panel).
- `Off`: nothing written.

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
rustydemon-cli export -a "$WOW_DIR" -l dev/listfile.csv -o .wow-assets -p "{$DIRS}/**" -j 8
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
- **Config keys (initial set):** `uiParentWidth`, `uiParentHeight` (reference resolution, default `1024` × `768`), `defaultFont` (WoW-relative path, e.g. `Fonts/FRIZQT__.TTF`), `defaultFontSize` (number), `defaultFontFlags` (e.g. `""`, `"OUTLINE"`, `"THICKOUTLINE"`), `defaultTextColor` (RGBA), `frameScale` (global preview scale).
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

**Status: 📋 Pending**

**Idea:** Add an optional pixel ruler to the preview webview — a graduated ruler strip along the top edge and another along the left edge, anchored (sticky) so they stay visible as the user scrolls the frame canvas. Toggled by a `scryer.showRuler` boolean setting (default `false`).

**Design:**

- Two `<div>` ruler strips injected into the webview HTML on initial render: `#ruler-top` (horizontal, spans the full width along the top) and `#ruler-left` (vertical, spans the full height along the left).
- `position: fixed` so they remain at the viewport edge regardless of how the canvas is scrolled. `#ruler-top` is `~20px` tall; `#ruler-left` is `~20px` wide. A small square corner filler sits at their intersection.
- Tick marks and labels drawn via a `<canvas>` element inside each strip (or CSS-generated content at regular intervals). Spacing follows the WoW logical-pixel coordinate system already established by `uiParentWidth`/`uiParentHeight` — ticks at every 10 or 50 logical pixels, labels at every 100.
- The canvas offset (frame canvas `scrollLeft`/`scrollTop`) is tracked via a `scroll` listener on the frame container; the ruler canvas is redrawn on each scroll event to update the visible tick range.
- Hide/show via a CSS class toggled when the webview receives a `setRuler` message from the extension host. The extension host sends this message when `scryer.showRuler` changes (via `onDidChangeConfiguration`), or immediately after initial render based on the current setting.
- A `StatusBarItem` (or a button in the webview's own toolbar/status strip) lets the user flip the ruler on/off without opening settings — clicking it toggles `scryer.showRuler` in workspace config, which fires `onDidChangeConfiguration` and propagates the change to the webview automatically.

**Implementation notes:**

- Ruler ticks are in logical WoW pixels (same coordinate space as the anchor layout engine), not CSS pixels — account for any `frameScale` applied to the canvas container.
- The ruler strips must clear the opposite ruler's width/height at the corner so tick labels don't overlap the intersection square.
- Low priority purely cosmetic feature; worth doing alongside any other webview polish work.

**Effort:** XS–S — pure webview HTML/CSS/JS with a small `onDidChangeConfiguration` handler in the extension host. No IR or asset pipeline changes required.
