# Scryer — Project Overview

## Vision and End State

A VSCode extension that renders WoW addon UI frames (`.xml` + `.lua`) directly in the editor, evolving from a static frame previewer into a full interactive addon development runtime — a headless WoW UI sandbox with hot-reload and automated testing that real WoW cannot offer.

End state: open any addon folder, pick a version target (Mainline/MoP Classic/Classic Era), get a live webview of the addon's frames driven by actual Lua execution of its code, reloading on save, with a headless test runner for CI.

## Milestone Table

Completed `↳` rows appear in chronological order before the first pending milestone. Pending `↳` rows are grouped under the milestone they relate to. See [backlog.md](backlog.md) for full detail on each.

| #   | Name                                                                                                                   | Status                      | Description                                                                                   | Effort | Depends on |
| --- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------- | ------ | ---------- |
| 1   | WoW XML Parser                                                                                                         | ✅ Complete (2026-05-24)    | Parse `.xml` → typed IR; resolve templates/inheritance                                        | M      | —          |
| ↳   | [CI-safe committed fixtures](backlog.md#ci-safe-committed-fixtures-deferred-from-m1)                                   | ✅ Done (2026-05-24)        | Replace live-fixture tests with inline cookbook fixtures                                      | Done   | —          |
| 2   | Static XML Preview                                                                                                     | ✅ Complete (2026-05-24)    | Render IR in a DOM webview with WoW anchor layout                                             | M      | 1          |
| ↳   | [relativeKey anchor resolution](backlog.md#relativekey-anchor-targets-deferred-from-m2)                                | ✅ Done (2026-05-26)        | Resolve `$parent.Key` anchors in the layout engine                                            | Done   | —          |
| 3   | Asset Pipeline                                                                                                         | ✅ Complete (2026-05-25)    | BLP→PNG conversion, path/atlas resolution, cache                                              | M      | 2          |
| ↳   | [dev/extract.sh contributor script](backlog.md#devextractsh--wow-asset-extraction-for-contributors-deferred-from-m3)   | ✅ Done (2026-05-26)        | Shell script for extracting WoW textures + addon files (superseded by JS entry-point runners) | Done   | —          |
| ↳   | [On-demand texture extraction](backlog.md#on-demand-texture-extraction-from-the-preview-deferred-from-m3)              | ✅ Done (2026-05-26)        | Extract missing textures on demand from preview panel                                         | Done   | —          |
| ↳   | [Extract Blizzard addon files](backlog.md#extract-blizzard-interface-addon-files-from-users-wow-installation)          | ✅ Done (2026-05-26)        | `--type interface` for Blizzard SharedXML/FrameXML                                            | Done   | —          |
| ↳   | [Blizzard FrameXML corpus loading](backlog.md#blizzard-framexml-template-corpus-loading-pre-m4)                        | ✅ Done (2026-05-26)        | Load Blizzard template registry from extracted addons                                         | Done   | —          |
| ↳   | [Output channel logging + logLevel](backlog.md#output-channel-logging-and-scryer.loglevel-setting)                     | ✅ Done (2026-05-26)        | Route warnings to output panel; add `scryer.logLevel`                                         | S      | —          |
| ↳   | [tsconfig solution-style refactor](backlog.md#tsconfig-solution-style-refactor-ide-tooling-debt)                       | ✅ Done (2026-05-26)        | Fix IDE type resolution for test files                                                        | XS     | —          |
| ↳   | [Extraction benchmarks](backlog.md#extraction-benchmarks)                                                              | ✅ Done (2026-05-27)        | Benchmark extraction pipeline at varying concurrency                                          | S      | —          |
| ↳   | [Addon texture manifest builder](backlog.md#addon-texture-manifest-builder)                                            | ✅ Done (2026-05-27)        | `collectAddonTexturePaths` + `collect-textures` CLI                                           | S      | —          |
| ↳   | [Progressive startupContent tier execution](backlog.md#progressive-tier-execution-for-scryer.startupcontent)           | ✅ Done (2026-05-27)        | Execute each cache tier in order up to the configured one                                     | XS     | —          |
| ↳   | [WoW build version tracking](backlog.md#wow-build-version-tracking-and-cache-invalidation)                             | ✅ Done (2026-05-27)        | Per-flavor cache; auto-wipe on .build.info version change                                     | XS     | —          |
| ↳   | [Dynamic flavor detection from `.build.info`](backlog.md#dynamic-flavor-detection-from-buildinfo)                      | ✅ Done (2026-05-27)        | Derive available flavors from install rather than hardcode                                    | S      | —          |
| ↳   | [Flavor configuration file](backlog.md#flavor-configuration-file--per-flavor-display-defaults)                         | ✅ Done (2026-05-28)        | Per-flavor font/size/resolution defaults; user override                                       | M      | —          |
| ↳   | [CSS inset + relativeKey renderer fixes](backlog.md#css-inset--relativekey-renderer-fixes-deferred-from-m2)            | ✅ Done (2026-05-28)        | Fix texture positioning and sibling-anchor resolution                                         | S      | —          |
| ↳   | [TexCoords sprite-sheet slicing](backlog.md#texcoords-sprite-sheet-slicing-in-the-dom-renderer-deferred-from-m2)       | ✅ Done (2026-05-28)        | Apply UV crop via CSS background-position/size                                                | S      | —          |
| ↳   | [Pixel ruler overlay](backlog.md#pixel-ruler-overlay-in-the-preview-panel)                                             | ✅ Done (2026-05-28)        | Optional sticky rulers along top/left edges of the preview                                    | XS–S   | —          |
| ↳   | [Atlas texture resolution](backlog.md#atlas-texture-resolution)                                                        | ✅ Done (2026-05-28)        | Resolve atlas names via manifest; apply UV crop in renderer                                   | S–M    | —          |
| ↳   | [JS entry-point runners (replace dev shell scripts)](backlog.md#js-entry-point-runners-replace-dev-shell-scripts)      | ✅ Done (2026-05-28)        | `src/` is source of truth; dev/ scripts are thin TS shims                                     | S      | —          |
| 4   | Lua Shim Runtime                                                                                                       | ⬜ Pending                  | Sandboxed Lua exec + WoW API stubs + frame object model                                       | M      | 1, 2       |
| 5   | Multi-Version Targets                                                                                                  | ⬜ Pending                  | Selectable Classic/Cata/Retail API profiles                                                   | S–M    | 4          |
| 6   | Hot Reload _(stretch)_                                                                                                 | ⬜ Pending                  | Re-parse/re-run on save with minimal repaint                                                  | M      | 2, 4       |
| 7   | Test Suite _(stretch)_                                                                                                 | ⬜ Pending                  | Headless addon test runner + reporter                                                         | M      | 4          |
| ↳   | [User-visible loading notifications](backlog.md#user-visible-loading-notifications)                                    | 📋 Pending                  | Progress notifications for atlas gen, extraction, preload                                     | S      | —          |
| ↳   | [TGA texture decode](backlog.md#tga-texture-decode-deferred-from-m3)                                                   | 📋 Pending                  | Decode `.tga` textures via pure-JS decoder                                                    | S      | —          |
| ↳   | [In-app asset setup guidance](backlog.md#in-app-asset-setup-guidance-for-end-users-deferred-from-m3)                   | 📋 Pending                  | One-time notification when no assets are configured                                           | S      | —          |
| ↳   | [In-process CASC reader](backlog.md#in-process-javascript-casc-reader-replace-extractsh--rustydemon-cli)               | 📋 Pending                  | Read WoW CASC archives in-process, no external binary                                         | L      | —          |
| ↳   | [Preload workspace textures](backlog.md#preload-workspace-textures-at-startup)                                         | 📋 Pending                  | Pre-warm asset cache at extension startup                                                     | S      | —          |
| ↳   | [Preload settings](backlog.md#preload-settings--scryer.startupcontent--scryer.useraddonpreload)                        | 🔧 Partial (settings added) | `scryer.startupContent` + `scryer.userAddonPreload` enums                                     | S      | —          |
| ↳   | [Direct BLP/TGA serving in webview](backlog.md#direct-proprietary-texture-serving-in-the-webview-blptga-decode-bypass) | 📋 Pending (research)       | Feasibility: skip PNG compression by serving raw RGBA                                         | XS     | —          |
| ↳   | [Atlas manifest from DB2 (replace wago.tools)](backlog.md#atlas-manifest-from-db2-replace-wagotools)                   | 📋 Pending                  | Parse UiTextureAtlas DB2 files directly; no outbound HTTP                                     | M      | —          |
| ↳   | [Listfile cache speed-up](backlog.md#listfile-cache-speed-up-sqlite-or-equivalent)                                     | 📋 Pending                  | SQLite/binary index; cut 25 s CSV parse to sub-millisecond                                    | S–M    | —          |
| ↳   | [Apply logLevel setting to output channel](backlog.md#apply-scryer.loglevel-setting-to-logoutputchannel-log-level)     | 📋 Pending                  | Set `channel.logLevel` from setting; remove manual gating                                     | XS     | —          |
| ↳   | [Texture placeholder hover tooltip](backlog.md#texture-placeholder-hover-tooltip)                                      | 📋 Pending                  | `title` attribute on placeholders so full name shows on hover when truncated                  | XS     | —          |

## Recommended Tech Stack

| Layer           | Choice                   | Rationale                                                      |
| --------------- | ------------------------ | -------------------------------------------------------------- |
| Language        | TypeScript               | VSCode extension API is TS-first; existing repo tooling intent |
| Bundler         | esbuild                  | Fast; two-entry build (host + webview)                         |
| XML parser      | fast-xml-parser          | Zero native deps; preserves attribute order; configurable      |
| Lua interpreter | wasmoon (primary)        | WASM Lua 5.4; good Node perf; + 5.1 compat shim                |
| Lua fallback    | fengari                  | Pure JS Lua 5.3; runs in webview sandbox if needed             |
| UI renderer     | DOM (M2), Canvas (later) | DOM = easy debug/inspect; Canvas = atlas slicing fidelity      |
| BLP decoder     | js-blp 1.0.5 (pure JS)   | Zero external binary; CLI blp2png as optional fallback         |

**Lua version note:** WoW uses Lua 5.1 internally (confirmed by `.vscode/extensions.json` pinning `ketho.wow-api` + workspace `Lua.runtime.version: "Lua 5.1"`). Neither wasmoon (5.4) nor fengari (5.3) is a perfect match. A 5.1 compatibility shim (`unpack`, `setfenv`/`getfenv`, `math.mod`, etc.) is required.

## Architecture (ASCII)

```
        VSCode Extension Host (Node)                        Webview (sandboxed)
  +----------------------------------------+          +-----------------------------+
  |  Activation / Commands                 |          |  Renderer (DOM divs)        |
  |  Workspace + target config (M5)        |          |   - anchor/layout engine    |
  |                                        |          |   - strata/layer z-order    |
  |  Parser (M1) -----> IR/AST             | <=msg=>  |   - placeholder textures    |
  |  Include/TOC resolver                  |  JSON    |   - FontString (webfonts)   |
  |                                        |          |                             |
  |  Lua Runtime (M4)                      |          |  Input -> events (OnClick)  |
  |   - wasmoon / fengari                  |          +-----------------------------+
  |   - WoW API sandbox + frame model      |                      ^
  |   - mixins, C_Timer, events            |           asset:// (PNG from cache)
  |                                        |                      |
  |  Asset Pipeline (M3)                   |          +-----------------------------+
  |   - BLP->PNG, atlas, cache             | -------> |  cacheRoot/derived/ (PNG)   |
  +----------------------------------------+          +-----------------------------+
              |                  ^
    reads (read-only)          file save -> Hot Reload (M6)
              v                  |
    WOW_DIR install / _live/Addons    Headless runner (M7, no webview)
```

## Cross-Cutting Concerns

- **Multi-version runtime (M5):** single IR format with a swappable API profile per target version; TOC interface-version field validates against the selected target.
- **Asset pipeline (M3):** BLP is proprietary; conversion and caching are shared by both the webview renderer and the headless test runner.
- **Security sandbox:** webview CSP locks origins; Lua sandbox removes `io`/`os.execute`; all filesystem reads restricted to user-configured `WOW_DIR` and workspace paths; no network requests.
- **Relationship to `ketho.wow-api`:** `ketho.wow-api` (already recommended in `.vscode/extensions.json`) is an _editor-time_ extension (LuaLS completions). We are a _runtime_ extension (execution + preview). The two are complementary — recommend installing both via an `extensionPack` entry. We reuse ketho's _data corpus_ (not its live LuaLS settings): `flavor.ts` for per-flavor API availability, `event.ts` for typed event payloads, `globalapi.ts` for the C\_\* namespace list, and `compat.lua`/`bit.lua`/`basic.lua` as the canonical WoW Lua shim spec. Only the `Core/` annotation tree is in scope — `FrameXML/` Blizzard addon stubs are not needed.

## Stretch Goals

- **Hot reload (M6):** the headline DX win — live-reload on save is impossible in real WoW.
- **Test suite (M7):** headless, CI-friendly addon testing from within VSCode Test Explorer.
- Future: Canvas/WebGL renderer, animation groups, SavedVariables emulation, frame inspector/devtools, multi-monitor UI simulation.

## Known Risks and Open Questions

| Risk                                                 | Severity   | Mitigation                                                                                                                              |
| ---------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Lua 5.1 vs 5.3/5.4 semantic gaps                     | Medium     | Mirror `compat.lua`/`bit.lua`/`basic.lua` shim from ketho (finite, enumerated); residual risk isolated to `setfenv`/`getfenv` emulation |
| BLP decoding coverage in JS                          | Medium     | Pure-JS primary; CLI blp2png fallback; log unsupported variants                                                                         |
| Retail assets live in CASC (not loose files)         | Medium     | Target an extracted-assets dir; document WoW.export/CASCExplorer                                                                        |
| WoW API surface gaps                                 | Low–Medium | `flavor.ts` (7218 entries) + `globalapi.ts` (261 C\_\* namespaces) bound the surface; safe-default nil-return stubs for the rest        |
| Blizzard template corpus (DefaultPanelTemplate etc.) | Medium     | Lazy-load from `_reference/wow-ui-source`; warn when missing                                                                            |
| Atlas manifest acquisition per game build            | Medium     | JSON manifest generated from extracted data; version-tag it                                                                             |
| Rotating Classic-progression flavor                  | Low        | Pin a versioned copy of `flavor.ts`; update when Classic season advances                                                                |

**Open questions:**

- ~~Custom editor provider vs side WebviewPanel — which gives better UX first?~~ Resolved (M2): `WebviewPanel` beside the active editor. Upgrade to `CustomTextEditorProvider` deferred until the UX is proven.

**Known tooling debt:** see [backlog.md](backlog.md).
