# Backlog — Outstanding Tasks Without a Milestone

Cross-cutting items deferred from completed milestones, or tooling debt that doesn't fit a feature milestone. Review this file at the start of each milestone to see if anything should be scheduled.

---

## Blizzard FrameXML template corpus loading (pre-M4)

**Status: Done** (2026-05-26)

**What was built:**

`src/parser/blizzard-registry.ts` — `loadBlizzardRegistry(addonsDir, cacheDir)` scans `Blizzard_SharedXML` and `Blizzard_FrameXML` via their TOC files, following `<Include>` chains to collect all virtual frame definitions into a `Map<string, FrameIR>`. Result is serialised to `.scryer-cache/blizzard-registry.json` and validated against TOC file mtimes on every call (fast on cache hit: 4 stat/read ops).

`src/parser/collect-textures.ts` — `collectTexturePaths(frames)` walks the resolved frame tree (layers, button textures, children) and returns every distinct `TextureIR.file` path.

`AssetService.loadBlizzardTemplates()` — convenience wrapper that computes the addons dir from `scryer.extractedAssetsDir/Interface/AddOns/` and delegates to `loadBlizzardRegistry`.

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

- `AssetService.extractMissing(paths)` is reimplemented without spawning a subprocess. Given a list of WoW-relative texture paths, it opens the CASC storage at `scryer.installDir`, reads the requested files, writes them into `extractedAssetsDir` (or directly into the cache), and returns.
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
- BLP decode + PNG compression dominates: N=10 (all buttons) ~34 ms; N=11 including `ui-background-rock.blp` (514 KB DXT, ~1024×1024) ~4 s due to `PNG.sync.write` compression time.
- Combined cost tracks texture decode; addon reads are effectively free alongside it.
- **Implication:** PNG compression of large textures is the main cost. Any preload or batch strategy should account for the outsized decode time of large background textures vs small icon textures.

---

## WoW build version tracking and cache invalidation

**Problem:** WoW is updated automatically by the Battle.net launcher. After a game update, previously extracted files in `.wow-assets/` and `.scryer-cache/` may be stale — textures or addon code that changed in the patch will not match what the extension is serving. The user has no signal that their extract is out of date, and there is no mechanism to invalidate the cache on update.

**Goal:** Detect when the WoW install has been updated since the last extraction and prompt the user to re-extract (or invalidate the cache automatically).

**Plan:**

WoW writes a `.build.info` file at the root of the install directory (e.g. `$WOW_DIR/.build.info`). It is rewritten by the Battle.net launcher on every patch.

Three viable detection approaches (pick simplest that works):

- **Version string:** Parse the `BuildText` field from `.build.info` (e.g. `11.1.7.60000`) and store it in a stamp file after extraction. Compare on startup — if changed, prompt re-extraction.
- **`.build.info` mtime:** Store the mtime of `.build.info` at extraction time. On startup, `stat` the file and compare. No parsing needed.
- **Data file mtime/size:** `stat` the actual CASC archive files (retail: `_retail_/Data/*.idx` or the data archives themselves; classic: the loose files under `Interface/`) and store their aggregate mtime or size. This catches ninja patches — silent background updates that modify game data without bumping the version string or touching `.build.info`.

Either way:

1. After a successful extraction, write the stamp (version string or mtime) to `.wow-assets/.build-stamp`.
2. At extension startup (or on first preview render), compare the current `.build.info` against the stamp.
3. If they differ, surface a notification: _"Your WoW install was updated. Re-run extraction to get current Blizzard addon files and textures."_ with a button to trigger re-extraction.
4. If `scryer.installDir` is not configured, skip silently.

The stamp file lives in `.wow-assets/` (gitignored) alongside the extracted files — wiping and re-extracting naturally refreshes it.

**Effort:** XS — a stat or single-field text parse, one file write, and a VSCode notification.

---

## Preload workspace textures at startup

**Problem:** When a WoW XML file is first opened, textures are resolved and decoded on-demand as the webview requests them. This means the first render is slow — each texture causes a round-trip from webview → extension → disk/cache → decode → response before it appears.

**Goal:** Scan the workspace (and any configured `scryer.extractedAssetsDir`) at extension startup and pre-warm the asset cache so textures are already decoded when the first preview renders.

**Plan:**

1. At extension activation, glob `scryer.extractedAssetsDir` for all BLP and TGA files (PNG files are already fast, but can be indexed too).
2. Decode each file through the existing `AssetService` pipeline (BLP→PNG, TGA→PNG) and populate the in-memory cache.
3. Run this preload in the background (don't block activation); use a VSCode progress notification or output channel message to indicate it is happening.
4. Limit concurrency to avoid pegging the CPU (e.g. a queue of 4–8 parallel decode workers).
5. Persist the decoded PNG bytes to `.scryer-cache/` (already done per-file on first decode) so subsequent sessions benefit from disk cache even without a full re-scan.

**Stretch:** Watch `scryer.extractedAssetsDir` for new files (VSCode `FileSystemWatcher`) and decode them as they arrive, so a fresh extraction populates the cache incrementally.

**Effort:** S — the decode pipeline already exists; this is parallelizing it over a directory listing at startup. The main complexity is worker concurrency and not blocking the extension host.

---

## Configurable preload scope setting

**Problem:** A single preload strategy doesn't fit all users. A contributor working on one addon wants fast previews for their workspace textures only. A power user with a full extraction wants everything pre-warmed. There's no way to express this preference today.

**Goal:** Add a `scryer.preloadScope` dropdown setting with graduated tiers so the user controls how aggressively Scryer pre-warms the asset cache at startup.

**Proposed tiers (`scryer.preloadScope` enum):**

| Value         | Label            | Behavior                                                                                         |
| ------------- | ---------------- | ------------------------------------------------------------------------------------------------ |
| `"none"`      | Disabled         | No preload — decode on demand only (current default behavior)                                    |
| `"workspace"` | Workspace only   | Scan textures referenced in XML files found in the current workspace                             |
| `"extracted"` | Extracted assets | Preload everything already present in `scryer.extractedAssetsDir`                                |
| `"full"`      | Full extraction  | Trigger extraction of all known Interface textures from the WoW install, then preload the result |

Default: `"extracted"` — preload whatever is already on disk, no auto-extraction triggered.

**Notes:**

- `"workspace"` scope requires parsing open XML files to collect texture paths before decoding — a lighter scan than indexing the whole asset dir.
- `"full"` is only available when `scryer.installDir` is set; the setting should be grayed out or warn if the install dir is missing. This tier depends on the in-process CASC reader (see [[in-process-casc-reader]]) to be practical for end users.
- The preload worker pool (concurrency, progress notification) is shared with the parent preload task — this is just a scope gate on top of that work.
- All tiers still respect `.scryer-cache/` — already-decoded files are served from disk cache without re-decoding.

**Effort:** XS–S — the dropdown is a one-line `package.json` contribution; the `"workspace"` XML-scan path is the only novel logic. `"full"` scope is a stretch goal gated on the CASC reader milestone.

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
