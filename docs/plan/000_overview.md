# Scryer — Project Overview

## Vision and End State

A VSCode extension that renders WoW addon UI frames (`.xml` + `.lua`) directly in the editor, evolving from a static frame previewer into a full interactive addon development runtime — a headless WoW UI sandbox with hot-reload and automated testing that real WoW cannot offer.

End state: open any addon folder, pick a version target (Mainline/MoP Classic/Classic Era), get a live webview of the addon's frames driven by actual Lua execution of its code, reloading on save, with a headless test runner for CI.

## Milestone Table

Each milestone has its own section. Completed `↳` rows appear before pending `↳` rows within each section. Pending `↳` rows are placed under the milestone that enables or most naturally precedes the work. See [todo.md](todo.md) for full detail on each item.

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
  <td colspan="5">✅ <a href="todo-archive.md#ci-safe-committed-fixtures-deferred-from-m1">CI-safe committed fixtures</a>, <a href="todo-archive.md#xml-texture-template-inheritance">XML texture template inheritance</a></td>
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
  <td colspan="5">✅ <a href="todo-archive.md#relativekey-anchor-targets-deferred-from-m2">relativeKey anchor resolution</a>, <a href="todo-archive.md#css-inset--relativekey-renderer-fixes-deferred-from-m2">CSS inset + relativeKey renderer fixes</a>, <a href="todo-archive.md#texcoords-sprite-sheet-slicing-in-the-dom-renderer-deferred-from-m2">TexCoords sprite-sheet slicing</a>, <a href="todo-archive.md#fontstring-rendering-fidelity">FontString rendering fidelity</a>, <a href="todo-archive.md#pixel-ruler-overlay-in-the-preview-panel">Pixel ruler overlay</a>, <a href="todo-archive.md#texture-placeholder-hover-tooltip">Texture placeholder hover tooltip</a>, <a href="todo-archive.md#all-preview-chrome-values-configurable-via-defaultsjson">All preview chrome values in defaults.json</a>, <a href="todo-archive.md#canvas-scroll-in-all-directions-and-always-show-scrollbars">Canvas scroll in all directions + always-show scrollbars</a>, <a href="todo-archive.md#center-frame-content-on-open">Center frame content on open</a>, <a href="todo-archive.md#grab-pan-and-zoom-on-the-preview-canvas">Grab pan and zoom on the preview canvas</a>, <a href="todo-archive.md#webview-snapshot--golden-image-regression">Webview snapshot / golden-image regression</a>, <a href="todo-archive.md#eyedropper-color-picker-in-preview">Eyedropper color picker in preview</a>, <a href="todo-archive.md#nineslice-border-rendering-fidelity-diamondmetal">NineSlice border rendering fidelity (DiamondMetal)</a></td>
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
  <td colspan="5">✅ <a href="todo-archive.md#devextractsh--wow-asset-extraction-for-contributors-deferred-from-m3">dev/extract.sh contributor script</a>, <a href="todo-archive.md#on-demand-texture-extraction-from-the-preview-deferred-from-m3">On-demand texture extraction</a>, <a href="todo-archive.md#extract-blizzard-interface-addon-files-from-users-wow-installation">Extract Blizzard addon files</a>, <a href="todo-archive.md#blizzard-framexml-template-corpus-loading-pre-m4">Blizzard FrameXML corpus loading</a>, <a href="todo-archive.md#output-channel-logging-and-scryer.loglevel-setting">Output channel logging</a>, <a href="todo-archive.md#tsconfig-solution-style-refactor-ide-tooling-debt">tsconfig solution-style refactor</a>, <a href="todo-archive.md#extraction-benchmarks">Extraction benchmarks</a>, <a href="todo-archive.md#addon-texture-manifest-builder">Addon texture manifest builder</a>, <a href="todo-archive.md#progressive-tier-execution-for-scryer.startupcontent">Progressive startupContent tier execution</a>, <a href="todo-archive.md#wow-build-version-tracking-and-cache-invalidation">WoW build version tracking</a>, <a href="todo-archive.md#dynamic-flavor-detection-from-buildinfo">Dynamic flavor detection</a>, <a href="todo-archive.md#flavor-configuration-file--per-flavor-display-defaults">Flavor configuration file</a>, <a href="todo-archive.md#atlas-texture-resolution">Atlas texture resolution</a>, <a href="todo-archive.md#js-entry-point-runners-replace-dev-shell-scripts">JS entry-point runners</a>, <a href="todo-archive.md#listfile-pre-filter-rustydemon-era">Listfile pre-filter</a>, <a href="todo-archive.md#wow-font-loading-frizqtttf-from-casc">WoW font loading</a>, <a href="todo-archive.md#in-app-asset-setup-guidance-for-end-users-deferred-from-m3">In-app asset setup guidance</a>, <a href="todo-archive.md#preload-settings--scryer.startupcontent--scryer.useraddonpreload">Preload settings</a>, <a href="todo-archive.md#preload-workspace-textures-at-startup">Preload workspace textures</a>, <a href="todo-archive.md#user-visible-loading-notifications">User-visible loading notifications</a>, <a href="todo-archive.md#listfile-source-and-capitalization-strategy">Listfile source + capitalization strategy</a>, <a href="todo-archive.md#filtered-listfile-build-version-stamping">Filtered listfile build-version stamping</a>, <a href="todo-archive.md#standardize-on-lowercase-extraction-paths">Lowercase extraction paths</a>, <a href="todo-archive.md#asset-loading-priority-queue">Asset loading priority queue</a>, <a href="todo-archive.md#casc-asset-service-replace-extractsh--rustydemon-cli">CASC Asset Service</a></td>
</tr>
<tr>
  <td>↳</td>
  <td><a href="todo.md#tga-texture-decode-deferred-from-m3">TGA texture decode</a></td>
  <td>📋 Pending</td>
  <td>Decode <code>.tga</code> textures via pure-JS decoder</td>
  <td>S</td>
  <td>—</td>
</tr>
<tr>
  <td>↳</td>
  <td><a href="todo.md#direct-proprietary-texture-serving-in-the-webview-blptga-decode-bypass">Direct BLP/TGA serving in webview</a></td>
  <td>📋 Pending (research)</td>
  <td>Feasibility: skip PNG compression by serving raw RGBA</td>
  <td>XS</td>
  <td>—</td>
</tr>
<tr>
  <td>↳</td>
  <td><a href="todo.md#atlas-manifest-from-db2-replace-wagotools">Atlas manifest from DB2</a></td>
  <td>📋 Pending</td>
  <td>Parse UiTextureAtlas DB2 files directly; no outbound HTTP</td>
  <td>M</td>
  <td>—</td>
</tr>
<tr>
  <td>↳</td>
  <td><a href="todo.md#listfile-fast-index-in-process--post-rustydemon-era">Listfile fast index</a></td>
  <td>📋 Pending</td>
  <td>SQLite/binary index for atlas-gen FileDataID lookups; prereq: M15 CASC Asset Service</td>
  <td>S–M</td>
  <td>15</td>
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
  <td colspan="5">✅ <a href="todo-archive.md#globalstrings-population-deferred-from-m5">GlobalStrings population</a></td>
</tr>
<tr>
  <td>↳</td>
  <td><a href="todo.md#typescripttolua-integration-investigation">TypeScriptToLua integration investigation</a></td>
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
  <td colspan="5">✅ <a href="todo-archive.md#c_texturegetatlasinfo-full-field-set"><code>C_Texture.GetAtlasInfo</code> full field set</a>, <a href="todo-archive.md#atlas-manifest-prefix-aware-lookup-in-resolveatlasintexture">Atlas manifest prefix-aware lookup</a>, <a href="todo-archive.md#useatlassize-render-time-dimension-override-in-applyasset"><code>useAtlasSize</code> render-time override fix</a>, <a href="todo-archive.md#colorgeneratehexcolor-stub--unblocks-sharedcolorconstantslua"><code>Color:GenerateHexColor</code> stub</a>, <a href="todo-archive.md#flagsutil-stub--unblocks-scrollutillua"><code>FlagsUtil</code> stub</a>, <a href="todo-archive.md#mathutilEpsilon-constant--unblocks-scrollboxlua"><code>MathUtil.Epsilon</code> constant</a>, <a href="todo-archive.md#eventregistry-stub--unblocks-gamerulesutillua"><code>EventRegistry</code> stub</a>, <a href="todo-archive.md#unitsex-stub--unblocks-modelframemixinlua"><code>UnitSex</code> stub</a>, <a href="todo-archive.md#c_scriptedanimationsgetallscriptedanimationeffects-stub--unblocks-scriptedanimationeffectslua"><code>C_ScriptedAnimations.GetAllScriptedAnimationEffects</code> stub</a></td>
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
  <td colspan="5">✅ <a href="todo-archive.md#parentkey--parentarray-wiring-for-runtime-frames-deferred-from-m7">parentKey / parentArray wiring</a>, <a href="todo-archive.md#template-application-in-runtime-createframe-deferred-from-m7">Template application in runtime CreateFrame</a>, <a href="todo-archive.md#texture-tiling-on-dynamically-created-textures-nineslice-stub-follow-up">Texture tiling on dynamic textures</a>, <a href="todo-archive.md#setdrawlayer-on-dynamically-created-textures-nineslice-stub-follow-up">SetDrawLayer on dynamic textures</a>, <a href="todo-archive.md#texture-to-texture-setpoint-anchor-resolution">Texture-to-texture SetPoint anchors</a>, <a href="todo-archive.md#cross-layer-nineslice-layout">Cross-layer NineSlice layout</a></td>
</tr>
<tr>
  <td>↳</td>
  <td><a href="todo.md#live-panel-frame-diffing-deferred-from-m4">Live panel frame diffing</a></td>
  <td>📋 Pending</td>
  <td>Incremental frame-tree diffs to webview; full re-render used in M7</td>
  <td>S–M</td>
  <td>—</td>
</tr>
<tr>
  <td>↳</td>
  <td><a href="todo.md#statusbar-fill-texture-rendering-deferred-from-m7">StatusBar fill texture rendering</a></td>
  <td>📋 Pending</td>
  <td>Synthesise fill bar from value/min/max at serialization; apply color/texture</td>
  <td>S</td>
  <td>—</td>
</tr>
<tr>
  <td>↳</td>
  <td><a href="todo.md#wysiwyg-widget-placement">WYSIWYG widget placement</a></td>
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
  <td colspan="5">✅ <a href="todo-archive.md#lua-sandbox-execution-timeout-deferred-from-m6">Lua sandbox execution timeout</a>, <a href="todo-archive.md#full-blizzard_sharedxml-lua-corpus-loading">Full Blizzard_SharedXML Lua corpus loading</a></td>
</tr>
<tr>
  <td>↳</td>
  <td><a href="todo.md#xml--lua-coupling-in-static-preview">XML + Lua coupling in static preview</a></td>
  <td>📋 Pending</td>
  <td>How much Lua to run for static XML preview; design boundary between static/live modes</td>
  <td>S</td>
  <td>—</td>
</tr>
<tr>
  <td>↳</td>
  <td><a href="todo.md#f5-run-mode">F5 run mode — full environment VM</a></td>
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
  <td colspan="5">✅ <a href="todo-archive.md#preview-settings-toolbar">Preview settings toolbar</a>, <a href="todo-archive.md#customizable-keyboard-shortcuts-for-toolbar-actions">Customizable keyboard shortcuts for toolbar actions</a></td>
</tr>
<tr>
  <td>↳</td>
  <td><a href="todo.md#keyboard-input-handling-in-preview">Keyboard input handling in preview</a></td>
  <td>📋 Pending</td>
  <td>Toolbar "Game Input" mode (controller icon): captures keystrokes into Lua event bridge; ESC always exits</td>
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
<tr>
  <td>↳</td>
  <td colspan="5">✅ <a href="todo-archive.md#featuresmd--rendering-features-table-per-flavor">features.md — rendering features per flavor</a></td>
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
  <td><a href="todo.md#addon-state-emulation">Addon state emulation (addons testing addons)</a></td>
  <td>📋 Pending</td>
  <td>Secondary Lua API to drive simulated game state; test one addon's reaction through another</td>
  <td>M–L</td>
  <td>12</td>
</tr>
</tbody>
</table>

### M13 — API Stub Autogeneration

<table>
<thead><tr><th>#</th><th>Name</th><th>Status</th><th>Description</th><th>Effort</th><th>Depends on</th></tr></thead>
<tbody>
<tr>
  <td>13</td>
  <td><strong><a href="013_api_stub_autogen.md">API Stub Autogeneration</a></strong></td>
  <td>✅ Complete (2026-06-08)</td>
  <td>dev/gen-api-stubs.ts extracts Blizzard_APIDocumentationGenerated, parses it, auto-generates src/lua/api-stubs/ per flavor</td>
  <td>M</td>
  <td>6</td>
</tr>
<tr>
  <td>↳</td>
  <td colspan="5">✅ <a href="todo-archive.md#typed-scalar-returns-in-generated-stubs">Typed scalar returns</a>, <a href="todo-archive.md#wow-type-system-generation">WoW type system generation</a>, <a href="todo-archive.md#event-name-constants-generation">Event name constants</a>, <a href="todo-archive.md#enum-stub-generation">Enum stub generation</a></td>
</tr>
</tbody>
</table>

### M14 — Placeholder 3D Graphics (stretch)

<table>
<thead><tr><th>#</th><th>Name</th><th>Status</th><th>Description</th><th>Effort</th><th>Depends on</th></tr></thead>
<tbody>
<tr>
  <td>14</td>
  <td><strong>Placeholder 3D Graphics</strong> <em>(stretch)</em></td>
  <td>⬜ Pending</td>
  <td>Render rudimentary 3D models directly from CASC to provide context for UI frames.</td>
  <td>XL</td>
  <td>3</td>
</tr>
<tr>
  <td>↳</td>
  <td><a href="todo.md#placeholder-3d-graphics-from-casc">Placeholder 3D Graphics from CASC</a></td>
  <td>📋 Pending</td>
  <td>Investigate extracting and rendering minimal 3D assets to verify frame positioning, without making Scryer a game emulator.</td>
  <td>XL</td>
  <td>—</td>
</tr>
</tbody>
</table>

### M15 — CASC Asset Service

<table>
<thead><tr><th>#</th><th>Name</th><th>Status</th><th>Description</th><th>Effort</th><th>Depends on</th></tr></thead>
<tbody>
<tr>
  <td>15</td>
  <td><strong><a href="015_casc_asset_service.md">CASC Asset Service</a></strong></td>
  <td>✅ Complete (2026-06-10)</td>
  <td>Standalone long-lived Rust server for CASC extraction; replaces <code>rustydemon-cli</code></td>
  <td>M–L</td>
  <td>3</td>
</tr>
<tr>
  <td>↳</td>
  <td colspan="5">✅ <a href="todo-archive.md#eliminate-listfile-dependency-tvfs-root-direct">Eliminate listfile dependency (TVFS/root direct)</a>, <a href="todo-archive.md#cdn-client-startup-caching">CDN client startup caching</a></td>
</tr>
<tr>
  <td>↳</td>
  <td>Re-enable listfile-skip once TVFS coverage confirmed</td>
  <td>📋 Pending</td>
  <td>Multi-segment TVFS loading in place but skip is disabled; verify retail coverage ≥ threshold then re-enable <code>load_listfile_optional</code> skip logic</td>
  <td>XS</td>
  <td>TVFS multi-segment load ✅</td>
</tr>
<tr>
  <td>↳</td>
  <td>Disk-cached lookup tables</td>
  <td>📋 Pending</td>
  <td>Serialize parsed tables to binary cache; cold start ~200 ms → ~50 ms</td>
  <td>S</td>
  <td>—</td>
</tr>
<tr>
  <td>↳</td>
  <td>Direct byte streaming over stdio</td>
  <td>📋 Pending</td>
  <td>Return raw file bytes over the protocol instead of writing to disk</td>
  <td>S</td>
  <td>—</td>
</tr>
<tr>
  <td>↳</td>
  <td>DB2 file reading support</td>
  <td>📋 Pending</td>
  <td>Expose <code>readFile</code> method for arbitrary CASC paths; unblocks Atlas from DB2</td>
  <td>S</td>
  <td>—</td>
</tr>
<tr>
  <td>↳</td>
  <td>Multi-platform CI build pipeline</td>
  <td>📋 Pending</td>
  <td>Cross-compile for linux-x64, darwin-x64, darwin-arm64, win32-x64</td>
  <td>S–M</td>
  <td>—</td>
</tr>
<tr>
  <td>↳</td>
  <td>Performance benchmarking (server vs rustydemon-cli)</td>
  <td>📋 Pending</td>
  <td>Head-to-head comparison; ADR evidence for the migration</td>
  <td>XS</td>
  <td>—</td>
</tr>
<tr>
  <td>↳</td>
  <td colspan="5">✅ <a href="todo-archive.md#rust-server-tier-1-protocol-serde-tests">Rust server: Tier 1 — protocol serde tests</a>, <a href="todo-archive.md#rust-server-tier-2-extraction-stats-mock-tests">Rust server: Tier 2 — extraction stats mock tests</a>, <a href="todo-archive.md#rust-server-tier-3-synthetic-casc-fixtures">Rust server: Tier 3 — synthetic CASC fixtures</a></td>
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
  |   - BLP->PNG, atlas, cache             | ------> |  cacheRoot/derived/ (PNG)   |
  |   - CascClient (M15) ----+            |          +-----------------------------+
  +----------------------------------------+
              |                ^ stdio/JSON |
    reads (read-only)          |            v
              v                |   +------------------------+
    WOW_DIR install            |   | scryer-asset-server    |
                               |   |  long-lived server     |
    file save -> Hot Reload    |   |  idle timeout → exit   |
    (M11)                      |   +------------------------+
                               |
    Headless runner (M12)
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

**Known tooling debt:** see [todo.md](todo.md).
