# Milestone Archive — Completed Milestones

Fully-completed milestones moved from [000_overview.md](000_overview.md). Historical record of what shipped and when.

---

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

---

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

---

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

---

### M5 — Lua Sandbox + 5.1 Shim

Open item moved to Miscellaneous: [TypeScriptToLua integration investigation](000_overview.md#miscellaneous).

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
</tbody>
</table>

---

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

---

### M7 — Frame Object Model

Open items moved to Miscellaneous: [Live panel frame diffing](000_overview.md#miscellaneous), [WYSIWYG widget placement](000_overview.md#miscellaneous).

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
  <td colspan="5">✅ <a href="todo-archive.md#parentkey--parentarray-wiring-for-runtime-frames-deferred-from-m7">parentKey / parentArray wiring</a>, <a href="todo-archive.md#template-application-in-runtime-createframe-deferred-from-m7">Template application in runtime CreateFrame</a>, <a href="todo-archive.md#texture-tiling-on-dynamically-created-textures-nineslice-stub-follow-up">Texture tiling on dynamic textures</a>, <a href="todo-archive.md#setdrawlayer-on-dynamically-created-textures-nineslice-stub-follow-up">SetDrawLayer on dynamic textures</a>, <a href="todo-archive.md#texture-to-texture-setpoint-anchor-resolution">Texture-to-texture SetPoint anchors</a>, <a href="todo-archive.md#cross-layer-nineslice-layout">Cross-layer NineSlice layout</a>, <a href="todo-archive.md#statusbar-fill-texture-rendering-deferred-from-m7">StatusBar fill texture rendering</a></td>
</tr>
</tbody>
</table>

---

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
  <td colspan="5">✅ <a href="todo-archive.md#featuresmd--rendering-features-table-per-flavor">features.md — rendering features per flavor</a>, <a href="todo-archive.md#m10-target-status-bar-item">Target status bar item</a>, <a href="todo-archive.md#m10-toc-interface-version-validation">TOC interface version validation</a>, <a href="todo-archive.md#m10-per-workspace-scryer-target-json">Per-workspace .scryer/target.json</a></td>
</tr>
</tbody>
</table>

---

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
