# Milestone 7 — Frame Object Model + ScryerLivePanel

## Status

**Complete (2026-05-29)**

## Goal

Implement `CreateFrame` and the core WoW widget object model backed by the render tree. Open a new `ScryerLivePanel` webview. On each Lua mutation, send the full frame tree to the webview for rendering. First visual payoff: frames created in Lua appear in the preview.

## What was built

### FrameRegistry (`src/lua/frame-registry.ts`)

Manages all mutable runtime state:

- Sequential ID space shared across frames, textures, font strings.
- `UIParent` (viewport-sized) and `WorldFrame` pre-created at construction.
- Named-frame lookup via `_nameIndex` map.
- `serialize()` walks UIParent's subtree and returns `FrameIR[]` for the renderer.
- Dirty flag for tracking mutations.

### Frame/Texture/FontString nodes (`src/lua/frame-model.ts`)

Mutable TypeScript state objects with `toIR()` serialization to `FrameIR` / `TextureIR` / `FontStringIR`. Textures and font strings are embedded in their owner's arrays (not separate top-level nodes).

### Lua class bootstrap (`src/lua/frame-class.lua`)

Real Lua tables (not userdata proxies) for all frame types:

- `Frame`, `Button`, `CheckButton`, `StatusBar`, `ScrollFrame`, `Slider`, `EditBox`, `GameTooltip` metatables — all inheriting `FrameMT`.
- `Texture` and `FontString` metatables.
- All JS helpers captured as upvalues in a `do...end` block then cleared from `_G`.
- `CreateFrame(type, name, parent, template)` global.
- `UIParent`, `WorldFrame` Lua tables with pre-assigned `__id` from the registry.
- `Mixin`, `CreateFromMixins`, `CreateAndInitFromMixin`, `GetFrameMetatable`, `nop`/`noop`/`donothing`.

### registerFrameModel (`src/lua/createframe.ts`)

Injects ~60 JS helper globals then calls `lua.doString(frameClassLua)`. Accepts an optional `blizzardTemplates` map; when provided, a `__scryer_apply_template` TS callback resolves template names via `resolveInheritance` and generates Lua code to apply the template's layers, size, anchors, and scripts to the newly created frame (see [template application todo entry](todo.md#template-application-in-runtime-createframe-deferred-from-m7)). Helpers cover:

- Frame: `SetPoint`, `ClearAllPoints`, `SetAllPoints`, `SetSize`, `Show/Hide`, `SetAlpha/Scale`, `SetFrameStrata/Level`, `SetScript/GetScript/HookScript`, `RegisterEvent`, `SetAttribute`, `GetChildren`, `CreateTexture`, `CreateFontString`.
- Button: `SetText/GetText`, `Enable/Disable`, `SetNormalTexture`.
- StatusBar: `SetMinMaxValues`, `SetValue`, `SetStatusBarTexture`, `SetStatusBarColor`, `SetOrientation`.
- Texture: `SetTexture`, `SetAtlas`, `SetTexCoord` (4- and 8-float forms), `SetVertexColor`, `SetColorTexture`, `SetBlendMode`, `SetAlpha`, `Show/Hide`, `SetSize`, `SetPoint`.
- FontString: `SetText`, `SetTextColor`, `SetFont`, `SetJustifyH/V`, `SetAlpha`, `Show/Hide`, `SetSize`, `SetPoint`.

### ScryerLivePanel (`src/live-panel.ts`)

- Opens on a `.lua` file via `scryer.openLive` command.
- Per-render cycle: fresh sandbox + registry, `registerWowApi` + `registerFrameModel`, execute Lua source, advance clock 1ms, serialize frame tree.
- Re-renders on file change (400ms debounce).
- Asset pipeline (atlas, texture resolve/extract) identical to `ScryerPanel`.
- Same webview HTML shell as `ScryerPanel`.

### jest.config.mjs

Added `"^(\\.{1,2}/.+)\\.js$": "$1"` moduleNameMapper so that `.js` extension imports in source files resolve correctly in Jest tests.

## Key design decisions

### Lua table objects (not userdata proxies)

All objects are real Lua tables (`setmetatable({__id = n}, MT)`): `type(frame) == "table"`, `pairs` works, addon code can set arbitrary fields.

### Single shared ID space

Frames, textures, and font strings share a sequential counter. The Lua-side `_refs` table caches all objects for `GetParent()` / `GetChildren()`.

### Full re-render on mutation

Each `runAndRender()` serializes the entire frame tree. No diffing — see [todo](todo.md#live-panel-frame-diffing-deferred-from-m4).

### Fresh sandbox per render

A new sandbox is created each render cycle. Avoids accumulated state; startup cost is paid on each save. Optimization deferred.

### SetAllPoints → two explicit anchors

Expands to TOPLEFT/TOPLEFT + BOTTOMRIGHT/BOTTOMRIGHT anchor pairs (same as the XML parser).

## Files changed

| File                              | Change                                                  |
| --------------------------------- | ------------------------------------------------------- |
| `src/lua/frame-model.ts`          | New                                                     |
| `src/lua/frame-registry.ts`       | New                                                     |
| `src/lua/frame-class.lua`         | New                                                     |
| `src/lua/createframe.ts`          | New; template application added post-completion         |
| `src/live-panel.ts`               | New; passes `blizzardTemplates` to `registerFrameModel` |
| `src/extension.ts`                | Added `scryer.openLive` command                         |
| `jest.config.mjs`                 | Added `.js` moduleNameMapper                            |
| `test/lua/frame-registry.test.ts` | New (25 tests)                                          |
| `test/lua/createframe.test.ts`    | New; template tests added post-completion (44 tests)    |

## Out of scope / deferred

- Script event dispatch (OnLoad, OnEvent, OnUpdate) → M9
- TOC load sequence → M8
- ~~parentKey / parentArray wiring~~ → ✅ done (2026-05-29)
- ~~Template application in CreateFrame~~ → ✅ done (2026-05-29)
- Incremental frame tree diffing → [todo](todo.md#live-panel-frame-diffing-deferred-from-m4)
- StatusBar fill texture rendering → [todo](todo.md#statusbar-fill-texture-rendering-deferred-from-m7)
- GlobalStrings population → ✅ done (2026-05-29)

## Dependencies

M2 (renderer + webview protocol), M5 (sandbox), M6 (WoW API stubs).
