# Scryer — Project Overview

## Vision and End State

A VSCode extension that renders WoW addon UI frames (`.xml` + `.lua`) directly in the editor, evolving from a static frame previewer into a full interactive addon development runtime — a headless WoW UI sandbox with hot-reload and automated testing that real WoW cannot offer.

End state: open any addon folder, pick a version target (Mainline/MoP Classic/Classic Era), get a live webview of the addon's frames driven by actual Lua execution of its code, reloading on save, with a headless test runner for CI.

## Milestone Table

Each milestone has its own section. Completed `↳` rows appear before pending `↳` rows within each section. Pending `↳` rows are placed under the milestone that enables or most naturally precedes the work. See [backlog.md](backlog.md) for full detail on each item.

**Table conventions:**

- **Adding a pending ↳:** attach it under the milestone that enables or most naturally precedes it.
- **Completing a ↳:** change status to `✅ Done (YYYY-MM-DD)` and move it above any pending ↳ rows in the same section.
- **Completing a milestone:** update its Status cell; keep it in place — do not move its section.

### M1 — WoW XML Parser

<table>
<thead><tr><th>#</th><th>Name</th><th>Status</th><th>Description</th><th>Effort</th><th>Depends on</th></tr></thead>
<tbody>
<tr>
  <td>1</td>
  <td><strong><a href="001_xml_parser.md">WoW XML Parser</a></strong></td>
  <td>✅ Complete (2026-05-24)</td>
  <td>Parse <code>.xml</code> → typed IR; resolve templates/inheritance</td>
  <td>M</td>
  <td>—</td>
</tr>
<tr>
  <td>↳</td>
  <td colspan="5">✅ <a href="backlog.md#ci-safe-committed-fixtures-deferred-from-m1">CI-safe committed fixtures</a></td>
</tr>
</tbody>
</table>

### M2 — Static XML Preview

<table>
<thead><tr><th>#</th><th>Name</th><th>Status</th><th>Description</th><th>Effort</th><th>Depends on</th></tr></thead>
<tbody>
<tr>
  <td>2</td>
  <td><strong><a href="002_static_xml_preview.md">Static XML Preview</a></strong></td>
  <td>✅ Complete (2026-05-24)</td>
  <td>Render IR in a DOM webview with WoW anchor layout</td>
  <td>M</td>
  <td>1</td>
</tr>
<tr>
  <td>↳</td>
  <td colspan="5">✅ <a href="backlog.md#relativekey-anchor-targets-deferred-from-m2">relativeKey anchor resolution</a>, <a href="backlog.md#css-inset--relativekey-renderer-fixes-deferred-from-m2">CSS inset + relativeKey renderer fixes</a>, <a href="backlog.md#texcoords-sprite-sheet-slicing-in-the-dom-renderer-deferred-from-m2">TexCoords sprite-sheet slicing</a>, <a href="backlog.md#fontstring-rendering-fidelity">FontString rendering fidelity</a>, <a href="backlog.md#pixel-ruler-overlay-in-the-preview-panel">Pixel ruler overlay</a>, <a href="backlog.md#texture-placeholder-hover-tooltip">Texture placeholder hover tooltip</a>, <a href="backlog.md#all-preview-chrome-values-configurable-via-defaultsjson">All preview chrome values in defaults.json</a>, <a href="backlog.md#canvas-scroll-in-all-directions-and-always-show-scrollbars">Canvas scroll in all directions + always-show scrollbars</a>, <a href="backlog.md#center-frame-content-on-open">Center frame content on open</a>, <a href="backlog.md#grab-pan-and-zoom-on-the-preview-canvas">Grab pan and zoom on the preview canvas</a></td>
</tr>
<tr>
  <td>↳</td>
  <td><a href="backlog.md#preview-background-philosophy">Preview background philosophy</a></td>
  <td>📋 Pending</td>
  <td>Codify "no game graphics" scope; principled placeholder design; write ADR</td>
  <td>XS</td>
  <td>—</td>
</tr>
</tbody>
</table>

### M3 — Asset Pipeline

<table>
<thead><tr><th>#</th><th>Name</th><th>Status</th><th>Description</th><th>Effort</th><th>Depends on</th></tr></thead>
<tbody>
<tr>
  <td>3</td>
  <td><strong><a href="003_asset_pipeline.md">Asset Pipeline</a></strong></td>
  <td>✅ Complete (2026-05-25)</td>
  <td>BLP→PNG conversion, path/atlas resolution, cache</td>
  <td>M</td>
  <td>2</td>
</tr>
<tr>
  <td>↳</td>
  <td colspan="5">✅ <a href="backlog.md#devextractsh--wow-asset-extraction-for-contributors-deferred-from-m3">dev/extract.sh contributor script</a>, <a href="backlog.md#on-demand-texture-extraction-from-the-preview-deferred-from-m3">On-demand texture extraction</a>, <a href="backlog.md#extract-blizzard-interface-addon-files-from-users-wow-installation">Extract Blizzard addon files</a>, <a href="backlog.md#blizzard-framexml-template-corpus-loading-pre-m4">Blizzard FrameXML corpus loading</a>, <a href="backlog.md#output-channel-logging-and-scryer.loglevel-setting">Output channel logging</a>, <a href="backlog.md#tsconfig-solution-style-refactor-ide-tooling-debt">tsconfig solution-style refactor</a>, <a href="backlog.md#extraction-benchmarks">Extraction benchmarks</a>, <a href="backlog.md#addon-texture-manifest-builder">Addon texture manifest builder</a>, <a href="backlog.md#progressive-tier-execution-for-scryer.startupcontent">Progressive startupContent tier execution</a>, <a href="backlog.md#wow-build-version-tracking-and-cache-invalidation">WoW build version tracking</a>, <a href="backlog.md#dynamic-flavor-detection-from-buildinfo">Dynamic flavor detection</a>, <a href="backlog.md#flavor-configuration-file--per-flavor-display-defaults">Flavor configuration file</a>, <a href="backlog.md#atlas-texture-resolution">Atlas texture resolution</a>, <a href="backlog.md#js-entry-point-runners-replace-dev-shell-scripts">JS entry-point runners</a>, <a href="backlog.md#listfile-pre-filter-rustydemon-era">Listfile pre-filter</a>, <a href="backlog.md#wow-font-loading-frizqtttf-from-casc">WoW font loading</a>, <a href="backlog.md#in-app-asset-setup-guidance-for-end-users-deferred-from-m3">In-app asset setup guidance</a>, <a href="backlog.md#preload-settings--scryer.startupcontent--scryer.useraddonpreload">Preload settings</a></td>
</tr>
<tr>
  <td>↳</td>
  <td><a href="backlog.md#tga-texture-decode-deferred-from-m3">TGA texture decode</a></td>
  <td>📋 Pending</td>
  <td>Decode <code>.tga</code> textures via pure-JS decoder</td>
  <td>S</td>
  <td>—</td>
</tr>
<tr>
  <td>↳</td>
  <td><a href="backlog.md#user-visible-loading-notifications">User-visible loading notifications</a></td>
  <td>📋 Pending</td>
  <td>Progress notifications for atlas gen, extraction, preload</td>
  <td>S</td>
  <td>—</td>
</tr>
<tr>
  <td>↳</td>
  <td><a href="backlog.md#in-process-javascript-casc-reader-replace-extractsh--rustydemon-cli">In-process CASC reader</a></td>
  <td>📋 Pending</td>
  <td>Read WoW CASC archives in-process, no external binary</td>
  <td>L</td>
  <td>—</td>
</tr>
<tr>
  <td>↳</td>
  <td><a href="backlog.md#preload-workspace-textures-at-startup">Preload workspace textures</a></td>
  <td>📋 Pending</td>
  <td>Pre-warm asset cache at extension startup</td>
  <td>S</td>
  <td>—</td>
</tr>
<tr>
  <td>↳</td>
  <td><a href="backlog.md#direct-proprietary-texture-serving-in-the-webview-blptga-decode-bypass">Direct BLP/TGA serving in webview</a></td>
  <td>📋 Pending (research)</td>
  <td>Feasibility: skip PNG compression by serving raw RGBA</td>
  <td>XS</td>
  <td>—</td>
</tr>
<tr>
  <td>↳</td>
  <td><a href="backlog.md#atlas-manifest-from-db2-replace-wagotools">Atlas manifest from DB2</a></td>
  <td>📋 Pending</td>
  <td>Parse UiTextureAtlas DB2 files directly; no outbound HTTP</td>
  <td>M</td>
  <td>—</td>
</tr>
<tr>
  <td>↳</td>
  <td><a href="backlog.md#listfile-fast-index-in-process--post-rustydemon-era">Listfile fast index</a></td>
  <td>📋 Pending</td>
  <td>SQLite/binary index for atlas-gen FileDataID lookups; prereq: in-process CASC reader</td>
  <td>S–M</td>
  <td>—</td>
</tr>
<tr>
  <td>↳</td>
  <td><a href="backlog.md#listfile-source-and-capitalization-strategy">Listfile source + capitalization strategy</a></td>
  <td>📋 Pending</td>
  <td>Switch to wowdev/wow-listfile releases; use verified listfile; decide capitalization</td>
  <td>XS–S</td>
  <td>—</td>
</tr>
<tr>
  <td>↳</td>
  <td><a href="backlog.md#filtered-listfile-build-version-stamping">Filtered listfile build-version stamping</a></td>
  <td>📋 Pending</td>
  <td>Tie filtered listfile to WoW build number; skip re-filter when build unchanged; pay filter cost once per patch cycle</td>
  <td>XS</td>
  <td>—</td>
</tr>
</tbody>
</table>

### M4 — TOC Parser

<table>
<thead><tr><th>#</th><th>Name</th><th>Status</th><th>Description</th><th>Effort</th><th>Depends on</th></tr></thead>
<tbody>
<tr>
  <td>4</td>
  <td><strong><a href="004_toc_parser.md">TOC Parser</a></strong></td>
  <td>✅ Complete (2026-05-29)</td>
  <td>Parse <code>.toc</code> → <code>TocFile</code> IR; file load order for XML and Lua execution</td>
  <td>XS</td>
  <td>1</td>
</tr>
</tbody>
</table>

### M5 — Lua Sandbox + 5.1 Shim

<table>
<thead><tr><th>#</th><th>Name</th><th>Status</th><th>Description</th><th>Effort</th><th>Depends on</th></tr></thead>
<tbody>
<tr>
  <td>5</td>
  <td><strong><a href="005_lua_sandbox.md">Lua Sandbox + 5.1 Shim</a></strong></td>
  <td>✅ Complete (2026-05-29)</td>
  <td>wasmoon embed; disable-and-replace stdlib; <code>setfenv</code>/<code>getfenv</code> shim; compat aliases; <code>bit</code></td>
  <td>S–M</td>
  <td>—</td>
</tr>
<tr>
  <td>↳</td>
  <td colspan="5">✅ <a href="backlog.md#globalstrings-population-deferred-from-m5">GlobalStrings population</a></td>
</tr>
<tr>
  <td>↳</td>
  <td><a href="backlog.md#typescripttolua-integration-investigation">TypeScriptToLua integration investigation</a></td>
  <td>📋 Pending</td>
  <td>Research: does TSTL lualib conflict with 5.1 shim? source map support? addon detection?</td>
  <td>XS–S</td>
  <td>—</td>
</tr>
</tbody>
</table>

### M6 — WoW API Stubs

<table>
<thead><tr><th>#</th><th>Name</th><th>Status</th><th>Description</th><th>Effort</th><th>Depends on</th></tr></thead>
<tbody>
<tr>
  <td>6</td>
  <td><strong><a href="006_wow_api_stubs.md">WoW API Stubs</a></strong></td>
  <td>✅ Complete (2026-05-29)</td>
  <td>TypeScript stubs into sandbox; C_* scaffolding from <code>globalapi.ts</code>; LibStub; C_Timer</td>
  <td>S</td>
  <td>5</td>
</tr>
<tr>
  <td>↳</td>
  <td colspan="5">✅ <a href="backlog.md#c_texturegetatlasinfo-full-field-set"><code>C_Texture.GetAtlasInfo</code> full field set</a>, <a href="backlog.md#atlas-manifest-prefix-aware-lookup-in-resolveatlasintexture">Atlas manifest prefix-aware lookup</a>, <a href="backlog.md#useatlassize-render-time-dimension-override-in-applyasset"><code>useAtlasSize</code> render-time override fix</a>, <a href="backlog.md#colorgeneratehexcolor-stub--unblocks-sharedcolorconstantslua"><code>Color:GenerateHexColor</code> stub</a>, <a href="backlog.md#flagsutil-stub--unblocks-scrollutillua"><code>FlagsUtil</code> stub</a>, <a href="backlog.md#mathutilEpsilon-constant--unblocks-scrollboxlua"><code>MathUtil.Epsilon</code> constant</a>, <a href="backlog.md#eventregistry-stub--unblocks-gamerulesutillua"><code>EventRegistry</code> stub</a>, <a href="backlog.md#unitsex-stub--unblocks-modelframemixinlua"><code>UnitSex</code> stub</a>, <a href="backlog.md#c_scriptedanimationsgetallscriptedanimationeffects-stub--unblocks-scriptedanimationeffectslua"><code>C_ScriptedAnimations.GetAllScriptedAnimationEffects</code> stub</a></td>
</tr>
</tbody>
</table>

### M7 — Frame Object Model

<table>
<thead><tr><th>#</th><th>Name</th><th>Status</th><th>Description</th><th>Effort</th><th>Depends on</th></tr></thead>
<tbody>
<tr>
  <td>7</td>
  <td><strong><a href="007_frame_object_model.md">Frame Object Model</a></strong></td>
  <td>✅ Complete (2026-05-29)</td>
  <td><code>CreateFrame</code> proxy; core widget methods; <code>ScryerLivePanel</code>; full re-render on mutation</td>
  <td>M</td>
  <td>2, 5, 6</td>
</tr>
<tr>
  <td>↳</td>
  <td colspan="5">✅ <a href="backlog.md#parentkey--parentarray-wiring-for-runtime-frames-deferred-from-m7">parentKey / parentArray wiring</a>, <a href="backlog.md#template-application-in-runtime-createframe-deferred-from-m7">Template application in runtime CreateFrame</a>, <a href="backlog.md#texture-tiling-on-dynamically-created-textures-nineslice-stub-follow-up">Texture tiling on dynamic textures</a>, <a href="backlog.md#setdrawlayer-on-dynamically-created-textures-nineslice-stub-follow-up">SetDrawLayer on dynamic textures</a>, <a href="backlog.md#texture-to-texture-setpoint-anchor-resolution">Texture-to-texture SetPoint anchors</a>, <a href="backlog.md#cross-layer-nineslice-layout">Cross-layer NineSlice layout</a></td>
</tr>
<tr>
  <td>↳</td>
  <td><a href="backlog.md#live-panel-frame-diffing-deferred-from-m4">Live panel frame diffing</a></td>
  <td>📋 Pending</td>
  <td>Incremental frame-tree diffs to webview; full re-render used in M7</td>
  <td>S–M</td>
  <td>—</td>
</tr>
<tr>
  <td>↳</td>
  <td><a href="backlog.md#statusbar-fill-texture-rendering-deferred-from-m7">StatusBar fill texture rendering</a></td>
  <td>📋 Pending</td>
  <td>Synthesise fill bar from value/min/max at serialization; apply color/texture</td>
  <td>S</td>
  <td>—</td>
</tr>
<tr>
  <td>↳</td>
  <td><a href="backlog.md#wysiwyg-widget-placement">WYSIWYG widget placement</a></td>
  <td>📋 Pending</td>
  <td>Drag frames in preview; emit anchor deltas as XML/Lua <code>SetPoint</code> calls</td>
  <td>L</td>
  <td>7, 9</td>
</tr>
</tbody>
</table>

### M8 — TOC Execution Pipeline

<table>
<thead><tr><th>#</th><th>Name</th><th>Status</th><th>Description</th><th>Effort</th><th>Depends on</th></tr></thead>
<tbody>
<tr>
  <td>8</td>
  <td><strong><a href="008_toc_execution.md">TOC Execution Pipeline</a></strong></td>
  <td>✅ Complete (2026-05-29)</td>
  <td><code>scryer.openLive</code> command; TOC load sequence; <code>ADDON_LOADED</code>; <code>PLAYER_LOGIN</code></td>
  <td>S</td>
  <td>4, 7</td>
</tr>
<tr>
  <td>↳</td>
  <td colspan="5">✅ <a href="backlog.md#lua-sandbox-execution-timeout-deferred-from-m6">Lua sandbox execution timeout</a>, <a href="backlog.md#full-blizzard_sharedxml-lua-corpus-loading">Full Blizzard_SharedXML Lua corpus loading</a></td>
</tr>
<tr>
  <td>↳</td>
  <td><a href="backlog.md#xml--lua-coupling-in-static-preview">XML + Lua coupling in static preview</a></td>
  <td>📋 Pending</td>
  <td>How much Lua to run for static XML preview; design boundary between static/live modes</td>
  <td>S</td>
  <td>—</td>
</tr>
<tr>
  <td>↳</td>
  <td><a href="backlog.md#f5-run-mode">F5 run mode — full environment VM</a></td>
  <td>📋 Pending</td>
  <td><code>scryer.run</code> command + F5 keybinding to launch full TOC execution pipeline</td>
  <td>S</td>
  <td>8, 9</td>
</tr>
</tbody>
</table>

### M9 — Script Events

<table>
<thead><tr><th>#</th><th>Name</th><th>Status</th><th>Description</th><th>Effort</th><th>Depends on</th></tr></thead>
<tbody>
<tr>
  <td>9</td>
  <td><strong><a href="009_script_events.md">Script Events</a></strong></td>
  <td>✅ Complete (2026-05-29)</td>
  <td><code>OnLoad</code> through <code>OnUpdate</code>; <code>RegisterEvent</code>; webview→Lua event bridge; <code>OnUpdate</code> watchdog</td>
  <td>S–M</td>
  <td>8</td>
</tr>
<tr>
  <td>↳</td>
  <td><a href="backlog.md#preview-settings-toolbar">Preview settings toolbar</a></td>
  <td>📋 Pending</td>
  <td>In-panel toolbar for quick access to common settings: resolution, scale, flavor</td>
  <td>S</td>
  <td>—</td>
</tr>
<tr>
  <td>↳</td>
  <td><a href="backlog.md#keyboard-input-handling-in-preview">Keyboard input handling in preview</a></td>
  <td>📋 Pending</td>
  <td>Key event routing; ESC menu override; WoW default keybinding recreation</td>
  <td>S–M</td>
  <td>9</td>
</tr>
</tbody>
</table>

### M10 — Multi-Version Targets

<table>
<thead><tr><th>#</th><th>Name</th><th>Status</th><th>Description</th><th>Effort</th><th>Depends on</th></tr></thead>
<tbody>
<tr>
  <td>10</td>
  <td><strong><a href="010_version_targets.md">Multi-Version Targets</a></strong></td>
  <td>⬜ Pending</td>
  <td>Selectable Classic/Cata/Retail API profiles</td>
  <td>S–M</td>
  <td>6</td>
</tr>
</tbody>
</table>

### M11 — Hot Reload

<table>
<thead><tr><th>#</th><th>Name</th><th>Status</th><th>Description</th><th>Effort</th><th>Depends on</th></tr></thead>
<tbody>
<tr>
  <td>11</td>
  <td><strong><a href="011_hot_reload.md">Hot Reload</a></strong> <em>(stretch)</em></td>
  <td>⬜ Pending</td>
  <td>Re-parse/re-run on save with minimal repaint</td>
  <td>M</td>
  <td>2, 9</td>
</tr>
</tbody>
</table>

### M12 — Test Suite

<table>
<thead><tr><th>#</th><th>Name</th><th>Status</th><th>Description</th><th>Effort</th><th>Depends on</th></tr></thead>
<tbody>
<tr>
  <td>12</td>
  <td><strong><a href="012_test_suite.md">Test Suite</a></strong> <em>(stretch)</em></td>
  <td>⬜ Pending</td>
  <td>Headless addon test runner + reporter</td>
  <td>M</td>
  <td>9</td>
</tr>
<tr>
  <td>↳</td>
  <td><a href="backlog.md#addon-state-emulation">Addon state emulation (addons testing addons)</a></td>
  <td>📋 Pending</td>
  <td>Secondary Lua API to drive simulated game state; test one addon's reaction through another</td>
  <td>M–L</td>
  <td>12</td>
</tr>
</tbody>
</table>

### Miscellaneous

<table>
<thead><tr><th>#</th><th>Name</th><th>Status</th><th>Description</th><th>Effort</th><th>Depends on</th></tr></thead>
<tbody>
</tbody>
</table>

## Recommended Tech Stack

| Layer           | Choice                   | Rationale                                                             |
| --------------- | ------------------------ | --------------------------------------------------------------------- |
| Language        | TypeScript               | VSCode extension API is TS-first; existing repo tooling intent        |
| Bundler         | esbuild                  | Fast; two-entry build (host + webview)                                |
| XML parser      | fast-xml-parser          | Zero native deps; preserves attribute order; configurable             |
| Lua interpreter | wasmoon                  | Official Lua C source → WASM; no subproject to own; + 5.1 compat shim |
| Lua fallback    | fengari → Lua 5.1 WASM   | Fengari (pure JS 5.3) then self-compiled 5.1 if wasmoon blocked       |
| UI renderer     | DOM (M2), Canvas (later) | DOM = easy debug/inspect; Canvas = atlas slicing fidelity             |
| BLP decoder     | js-blp 1.0.5 (pure JS)   | Zero external binary; CLI blp2png as optional fallback                |

**Lua version note:** WoW has been on Lua 5.1 since approximately WoW version 2 and is not expected to change — all three live flavors (Retail, Classic, Classic Era) use the same embed. A Babel-style Lua transpiler is not worth the effort (see [ADR 009](../decisions/009_lua_version_and_tooling.md)). Neither wasmoon (5.4) nor fengari (5.3) is a perfect match; a 5.1 compatibility shim (`unpack`, `setfenv`/`getfenv`, `math.mod`, etc.) is required.

## Architecture (ASCII)

```
        VSCode Extension Host (Node)                        Webview (sandboxed)
  +----------------------------------------+          +-----------------------------+
  |  Activation / Commands                 |          |  Renderer (DOM divs)        |
  |  Workspace + target config (M10)       |          |   - anchor/layout engine    |
  |                                        |          |   - strata/layer z-order    |
  |  Parser (M1) -----> IR/AST             | <=msg=>  |   - placeholder textures    |
  |  Include/TOC resolver                  |  JSON    |   - FontString (webfonts)   |
  |                                        |          |                             |
  |  Lua Runtime (M5–M9)                   |          |  Input -> events (OnClick)  |
  |   - wasmoon (M5 sandbox)              |          +-----------------------------+
  |   - WoW API stubs (M6)                |                      ^
  |   - frame model + panel (M7)          |           asset:// (PNG from cache)
  |   - TOC execution (M8)                |
  |   - script events (M9)                |
  |                                        |                      |
  |  Asset Pipeline (M3)                   |          +-----------------------------+
  |   - BLP->PNG, atlas, cache             | -------> |  cacheRoot/derived/ (PNG)   |
  +----------------------------------------+          +-----------------------------+
              |                  ^
    reads (read-only)          file save -> Hot Reload (M11)
              v                  |
    WOW_DIR install / _live/Addons    Headless runner (M12, no webview)
```

## Cross-Cutting Concerns

- **Multi-version runtime (M10):** single IR format with a swappable API profile per target version; TOC interface-version field validates against the selected target.
- **Asset pipeline (M3):** BLP is proprietary; conversion and caching are shared by both the webview renderer and the headless test runner.
- **Security sandbox:** webview CSP locks origins; Lua sandbox removes `io`/`os.execute`; all filesystem reads restricted to user-configured `WOW_DIR` and workspace paths; no network requests.
- **Relationship to `ketho.wow-api`:** `ketho.wow-api` (already recommended in `.vscode/extensions.json`) is an _editor-time_ extension (LuaLS completions). We are a _runtime_ extension (execution + preview). The two are complementary — recommend installing both via an `extensionPack` entry. We reuse ketho's _data corpus_ (not its live LuaLS settings): `flavor.ts` for per-flavor API availability, `event.ts` for typed event payloads, `globalapi.ts` for the C\_\* namespace list, and `compat.lua`/`bit.lua`/`basic.lua` as the canonical WoW Lua shim spec. Only the `Core/` annotation tree is in scope — `FrameXML/` Blizzard addon stubs are not needed.

## Stretch Goals

- **Hot reload (M11):** the headline DX win — live-reload on save is impossible in real WoW.
- **Test suite (M12):** headless, CI-friendly addon testing from within VSCode Test Explorer.
- Future: Canvas/WebGL renderer, animation groups, SavedVariables emulation, frame inspector/devtools, multi-monitor UI simulation.

## Known Risks and Open Questions

| Risk                                                 | Severity   | Mitigation                                                                                                                                               |
| ---------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lua 5.1 vs 5.4 semantic gaps (wasmoon)               | Low        | Finite shim from `compat.lua`/`bit.lua`/`basic.lua`; `setfenv`/`getfenv` solved via debug library upvalue shim (known work, not open risk) — see ADR 008 |
| BLP decoding coverage in JS                          | Medium     | Pure-JS primary; CLI blp2png fallback; log unsupported variants                                                                                          |
| Retail assets live in CASC (not loose files)         | Medium     | Target an extracted-assets dir; document WoW.export/CASCExplorer                                                                                         |
| WoW API surface gaps                                 | Low–Medium | `flavor.ts` (7218 entries) + `globalapi.ts` (261 C\_\* namespaces) bound the surface; safe-default nil-return stubs for the rest                         |
| Blizzard template corpus (DefaultPanelTemplate etc.) | Medium     | Lazy-load from `_reference/wow-ui-source`; warn when missing                                                                                             |
| Atlas manifest acquisition per game build            | Medium     | JSON manifest generated from extracted data; version-tag it                                                                                              |
| Rotating Classic-progression flavor                  | Low        | Pin a versioned copy of `flavor.ts`; update when Classic season advances                                                                                 |

**Open questions:**

- ~~Custom editor provider vs side WebviewPanel — which gives better UX first?~~ Resolved (M2): `WebviewPanel` beside the active editor. Upgrade to `CustomTextEditorProvider` deferred until the UX is proven.

**Known tooling debt:** see [backlog.md](backlog.md).
