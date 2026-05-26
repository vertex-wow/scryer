# Backlog — Outstanding Tasks Without a Milestone

Cross-cutting items deferred from completed milestones, or tooling debt that doesn't fit a feature milestone. Review this file at the start of each milestone to see if anything should be scheduled.

---

## Blizzard FrameXML template corpus loading (pre-M4)

**Problem:** `panel.ts` calls `resolveInheritance([doc])` with an empty Blizzard registry, so any frame that `inherits` a Blizzard-defined template (e.g. `NineSlicePanelTemplate`, `DefaultPanelTemplate`, `BasicFrameTemplate`) silently gets no template content applied. The resolver logs `Unknown template "…"` to the console and continues; the rendered frame is missing all template-contributed textures and children.

Confirmed broken by `.plan/test_tooltip.xml` — the child frame `inherits="NineSlicePanelTemplate"` renders with no nine-slice borders.

**Two-part limitation:**

1. **Templates not loaded** — fixable by parsing the relevant FrameXML files from `_reference/wow-ui-source/` and passing them as `blizzardRegistry` to `resolveInheritance`. `_reference/wow-ui-source/Interface/AddOns/Blizzard_SharedXML/` is the right starting point; it contains `SharedUIPanelTemplates.xml`, `SecureUIPanelTemplates.xml`, etc.

2. **Code-driven templates** — `NineSlicePanelTemplate` inherits `NineSliceCodeTemplate`, which has no XML textures; the nine-slice pieces are set entirely by Lua mixin code reading `layoutType`/`layoutTextureKit` key values. Loading the template corpus fixes part 1, but code-driven templates still require M4 (Lua runtime) to render correctly.

**Plan:** Load a subset of FrameXML templates from `_reference/wow-ui-source/` at extension startup (or lazily on first render). Parse each file with `parseXmlFile` and collect all virtual frames into the blizzard registry before calling `resolveInheritance`. The relevant file list can be seeded from the addon load order in `ui-toc-list.txt` — but a hand-curated list of the most common template files is sufficient for now (SharedXML is the priority).

Template files to load first:

- `Blizzard_SharedXML/SharedUIPanelTemplates.xml` (NineSlicePanelTemplate, InsetFrameTemplate, etc.)
- `Blizzard_SharedXML/SecureUIPanelTemplates.xml`
- `Blizzard_SharedXML/SharedTemplates.xml` (if present)

Path: resolve relative to the `_reference/wow-ui-source/Interface/AddOns/` symlink — or configurable via `scryer.blizzardSourceDir`.

**Effort:** S–M — parsing the files is trivial (reuse existing parser); the tricky part is handling inter-template dependencies (templates that inherit other templates across files) and deciding which files to load. A fixed hand-curated list avoids the dependency ordering problem for now.

**Note:** This does not fix code-driven templates like NineSlice. Those remain broken until M4.

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

## Extract Blizzard addon Lua files from user's WoW installation

**Problem:** When resolving frame inheritance, Blizzard addon Lua files are not available. Many templates and mixins are implemented entirely in Lua (e.g. `NineSliceCodeTemplate`, mixin functions set via `Mixin()`), meaning the extension cannot understand code-driven inheritance chains without access to the actual Lua source from the user's WoW install.

**Goal:** Extract Lua files from the Blizzard addon directories in the user's WoW installation so they can be indexed and referenced for inheritance resolution in a future Lua runtime milestone.

**Plan:**

- Extend `dev/extract.sh` (or add a companion script) to also extract `*.lua` files from the Blizzard addon directories (e.g. `Interface/AddOns/Blizzard_SharedXML/`, `Interface/AddOns/Blizzard_FrameXML/`).
- For retail (CASC), this means adding Lua paths to the extraction pass via `rustydemon-cli`.
- For classic (loose files), these Lua files already exist on disk under `$WOW_DIR/_classic_/Interface/AddOns/` and can be `rsync`'d directly.
- Output directory: `.wow-assets/Interface/AddOns/` (same root as textures, already gitignored).
- Once the in-process CASC reader is implemented (see above), this extraction can happen automatically on demand, the same way textures do.

**Why this is needed:** M4 (Lua runtime) will need to evaluate mixin code to correctly render code-driven templates. Having the source files available locally is a prerequisite for that work.

**Effort:** XS–S — the extraction pipeline already exists; this is adding Lua file paths to an existing pass. The harder dependency is the in-process CASC reader and M4 Lua runtime.

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

## tsconfig solution-style refactor (IDE tooling debt)

**Problem:** `tsconfig.json` includes a `"references"` entry to `tsconfig.test.json` intending VS Code to use the test config for `test/` files. In practice the language server falls back to the root config, which lacks `types: ["jest","node"]`, so Jest/Node globals appear unresolved in the IDE. No CI impact — typecheck uses `tsconfig.build.json` which excludes test files.

**Fix:** Convert to a solution-style layout:

- Rename current `tsconfig.json` → `tsconfig.src.json` (add `"composite": true`, keep `rootDir: "src"`, no `references`).
- Replace `tsconfig.json` with a solution file: `{ "files": [], "references": [{"path":"./tsconfig.src.json"}, {"path":"./tsconfig.test.json"}] }`.
- Update `tsconfig.test.json` to reference `tsconfig.src.json` instead of `tsconfig.json`.
- Update `tsconfig.build.json`, `package.json` scripts, and any other references to the renamed file.

VS Code reliably picks the correct per-file config in a solution-style layout.

**Effort:** XS — under an hour, mostly renaming and updating references.
