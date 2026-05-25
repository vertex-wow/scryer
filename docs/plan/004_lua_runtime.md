# Milestone 4 — Lua Shim Runtime

## Goal

Execute addon Lua in a sandbox with WoW API stubs, a frame object model that proxies to the renderer's frame tree, TOC load ordering, mixins, and script events — enough to make addons actually build and drive their UI.

## Approach

1. Embed a Lua interpreter in the extension host.
2. Disable all stock Lua standard libraries; re-provide WoW-flavored versions.
3. Implement `CreateFrame` and the widget object model backed by IR/render nodes.
4. Parse `.toc`, load `Script`/files in order; fire `OnLoad` after frame creation.
5. Bridge webview input events (clicks/enter/leave) to Lua script handlers.

## Entry Point — "Open Scryer Live View"

The live view is entered from a `.toc` file, not an individual XML or Lua file. The `.toc` defines the addon boundary and load order — it is the natural unit of execution.

**Command:** `scryer.openLive` — "Open Scryer Live View"

**Trigger:** right-click context menu on a `.toc` file tab, mirroring the existing `scryer.open` ("Open Scryer Preview") pattern used for XML files. Also appears in the Explorer context menu.

```jsonc
// package.json contributions (additions for M4)
"commands": [
  { "command": "scryer.openLive", "title": "Open Scryer Live View", "category": "Scryer", "icon": "$(run)" }
],
"menus": {
  "editor/title/context": [
    { "command": "scryer.openLive", "when": "resourceExtname == .toc", "group": "1_open" }
  ],
  "explorer/context": [
    { "command": "scryer.openLive", "when": "resourceExtname == .toc", "group": "navigation" }
  ]
}
```

**Note on `.toc` language registration:** VSCode has no built-in language ID for `.toc` files. Two options:

- `resourceExtname == .toc` in `when` clauses — simple, no language contribution needed.
- Contribute a `toc` language in `package.json` (grammars, file associations) — enables `resourceLangId == toc`, plus potential syntax highlighting.

For M4, `resourceExtname` is sufficient. A proper language contribution can follow.

**What happens on open:**

1. Parse the `.toc` to get file load order.
2. Execute the full Lua + XML load sequence (see TOC Load Order below).
3. Open a new `ScryerLivePanel` webview (distinct from `ScryerPanel` — the live panel receives frame diffs via the object model, not a single parsed IR dump).

## TOC File Parser

The `.toc` file parser is the entry point for loading an addon. It must be implemented here (or alongside M1 as a shared utility — recommended) because it defines the file load order for both XML includes (M1) and Lua execution (M4).

**TOC format:**

```
## Interface: 120000, 50501, 11507
## Title: MyAddon |cFF69CCF0by Author|r
## Version: 1.0.0
## SavedVariables: MyAddonDB
## SavedVariablesPerCharacter: MyAddonCharDB

Libs\LibStub\LibStub.lua
Core\Init.lua
MyAddon.xml
```

**Parse rules:**

- Lines starting with `##` are metadata directives (`key: value`).
- `## Interface:` is comma-separated multi-version (map each to flavor target — see M5).
- `## SavedVariables` / `## SavedVariablesPerCharacter` declare global tables (stub as empty tables in the sandbox; no persistence initially).
- Non-comment, non-empty lines are file paths (backslash → forward slash); order is load order.
- File extensions: `.lua` → execute in sandbox; `.xml` → M1 parse + instantiate frames.
- Empty lines and `# comments` (single `#`) are ignored.
- Directives are case-insensitive and allow arbitrary spaces around `:`.

**Activation-time detection (lightweight, before full parse):**
Before fully parsing, use a loose check to confirm the file is a WoW TOC: any line `startsWith("##")` AND (lowercased) `includes("interface")` AND `includes(":")`. This mirrors the pattern from `ketho.wow-api/src/extension.ts:hasTocFile()`. Do NOT fully parse every TOC during activation — only on preview open.

**TOC parser output:**

```ts
interface TocFile {
  interfaceVersions: number[];
  title: string;
  version?: string;
  savedVariables: string[];
  savedVariablesPerChar: string[];
  files: { path: string; type: "lua" | "xml" }[];
  rawMeta: Record<string, string>;
  sourceFile: string;
}
```

The parser lives in `src/parser/toc.ts` alongside `src/parser/xml.ts` (M1).

## Lua Interpreter Options (Decision)

**Key constraint:** WoW uses **Lua 5.1** internally. The workspace already pins `Lua.runtime.version: "Lua 5.1"` (set by `ketho.wow-api` via `src/luals.ts`).

| Option                              | Lua version | Runtime | Pros                               | Cons                                                          |
| ----------------------------------- | ----------- | ------- | ---------------------------------- | ------------------------------------------------------------- |
| **wasmoon** _(recommended primary)_ | 5.4         | WASM    | Fast; good Node interop; in-host   | 5.4 ≠ 5.1 (goto, `//`, bitwise, `table.unpack`, no `setfenv`) |
| **fengari** _(fallback)_            | 5.3         | Pure JS | Runs in webview too; closer to 5.1 | Slower than WASM; also not 5.1                                |
| lua.vm.js                           | 5.1         | asm.js  | True 5.1                           | Unmaintained; poor interop                                    |

**Decision: wasmoon primary** (performance + active maintenance) with an **enumerated 5.1 compatibility shim** (see section below). Use **fengari** only if in-webview Lua becomes necessary.

## WoW API Sandbox

**Model: disable stock Lua builtins; re-provide WoW versions.** This mirrors the approach confirmed in `ketho.wow-api/src/luals.ts`:

```ts
// ketho disables ALL standard Lua builtins:
const builtin = {
  basic: "disable",
  debug: "disable",
  io: "disable",
  math: "disable",
  os: "disable",
  package: "disable",
  string: "disable",
  table: "disable",
  utf8: "disable",
};
```

In our wasmoon/fengari sandbox, remove or replace the corresponding globals before executing any addon code. Then re-provide WoW's versions via the bootstrap sequence below.

**What is re-provided (not the raw Lua stdlib):**

- `string.*` — stock string functions + WoW extensions (`string.trim`, `string.split`, `string.join`, `string.concat`)
- `table.*` — stock table functions + WoW extensions (`table.wipe`)
- `math.*` — stock math functions (but the _global_ trig aliases use degrees — see shim section)
- `basic` functions allowed: `select`, `pairs`/`ipairs`, `next`, `type`, `tostring`/`tonumber`, `pcall`/`xpcall`, `error`, `assert`, `setmetatable`/`getmetatable`, `rawget`/`rawset`/`rawequal`, `coroutine`, controlled `print`
- **Removed entirely:** `io`, `os.execute`/`os.exit`, `package`, `loadfile`/`dofile`, `debug.sethook`

## WoW Lua 5.1 Compatibility Shim

The complete shim is **now fully enumerated** from `_reference/vscode-wow-api/Annotations/Core/Lua/`. This converts the former "High severity open-ended risk" into a finite implementation checklist.

### Source files (read-only reference)

- `Annotations/Core/Lua/compat.lua` — WoW's global alias layer (64 lines)
- `Annotations/Core/Lua/bit.lua` — WoW's `bit` library
- `Annotations/Core/Lua/basic.lua` — Lua 5.1 surface delta (header: "added: gcinfo / edited: xpcall, getfenv / removed: dofile, load, loadfile, module, rawlen, warn")

### Table aliases (from compat.lua)

```lua
tinsert = table.insert;  tremove = table.remove;  wipe = table.wipe
sort = table.sort;  foreach = table.foreach;  foreachi = table.foreachi;  getn = table.getn
```

Note: `table.wipe`, `table.foreach`, `table.foreachi`, `table.getn` are WoW extensions — must be provided before compat aliases resolve.

### String aliases (from compat.lua)

```lua
strbyte=string.byte;  strchar=string.char;  strfind=string.find;  format=string.format
gmatch=string.gmatch;  gsub=string.gsub;  strlen=string.len;  strlower=string.lower
strmatch=string.match;  strrep=string.rep;  strrev=string.reverse;  strsub=string.sub
strupper=string.upper;  strtrim=string.trim;  strsplit=string.split
strjoin=string.join;  strconcat=string.concat
```

Note: `string.trim`, `string.split`, `string.join`, `string.concat` are WoW extensions — must be provided before compat aliases resolve.

### Math aliases — **CRITICAL: WoW uses degrees, not radians**

```lua
-- These globals take and return DEGREES, not radians:
cos   = function(x) return math.cos(math.rad(x)) end
sin   = function(x) return math.sin(math.rad(x)) end
tan   = function(x) return math.tan(math.rad(x)) end
acos  = function(x) return math.deg(math.acos(x)) end
asin  = function(x) return math.deg(math.asin(x)) end
atan  = function(x) return math.deg(math.atan(x)) end
atan2 = function(x,y) return math.deg(math.atan2(x,y)) end
-- Standard numeric globals (no unit change):
abs=math.abs;  ceil=math.ceil;  floor=math.floor;  max=math.max;  min=math.min
mod=math.fmod;  log10=math.log10;  exp=math.exp;  sqrt=math.sqrt
PI=math.pi;  random=math.random
```

**Providing standard radian trig here would cause silent, incorrect rendering** (wrong rotation angles, wrong radial layouts, wrong cooldown sweeps) with no error message. This must be exact.

### `bit` library (from bit.lua)

```lua
bit.band, bit.bor, bit.bxor, bit.bnot, bit.lshift, bit.rshift, bit.arshift, bit.mod
```

wasmoon (Lua 5.4) has no `bit` table — provide it as a Lua table in the bootstrap.

### Remaining 5.1 gap: `setfenv`/`getfenv`

These were removed in Lua 5.2. WoW's `basic.lua` documents `getfenv` as "edited" (present but modified). Many WoW libs (LibStub, AceAddon, AceEvent) use `setfenv`/`getfenv` for sandboxing module environments. There is no clean emulation in Lua 5.4. Options:

- Best-effort shim using `_ENV` upvalue manipulation (may cover common cases)
- If wasmoon makes this intractable, evaluate fengari (5.3, closer to 5.1's environment model)

This is the **one remaining genuine open risk** after the compat.lua enumeration. Test against LibStub and AceAddon from `_live/Addons/` early to assess severity.

### GlobalStrings

Addons use global string constants like `OKAY`, `CANCEL`, `CLOSE`, and `RAID_CLASS_COLORS` that WoW injects into `_G`. Pre-populate from `_reference/vscode-wow-api/src/data/globalstring/enUS.ts` (name→value). This covers `FontString text="GLOBAL_STRING"` and Lua calls like `button:SetText(CLOSE)`. Locale-awareness (12 locales exist) is a future concern; enUS is sufficient for M4.

**Note:** `globals.ts` (47k lines of boolean name map) is NOT useful for the runtime — it's an editor-completions source for undefined-global diagnostics. Do not attempt to ingest it.

## Priority Stubs

Based on frequency in `_live/Addons/`. **Deprecated functions must still be stubbed** — deprecated-since-10.0 means removed from `mainline` but still present in Classic flavors (bcc/classic_era), and many mainline addons still call them via compat layers.

| API                                                        | Stub behavior                                              |
| ---------------------------------------------------------- | ---------------------------------------------------------- |
| `CreateFrame(type, name, parent, template)`                | Returns a frame object proxy; registers by name            |
| `UIParent`, `WorldFrame`                                   | Pre-created frame objects                                  |
| `GetTime()`                                                | Returns virtual clock time                                 |
| `date(fmt, time)`                                          | Wraps JS `Date`                                            |
| `C_Timer.After(seconds, fn)`                               | Queues `fn` on virtual clock; returns `FunctionContainer`  |
| `C_Timer.NewTicker(interval, fn, iterations)`              | Repeating timer; returns `FunctionContainer`               |
| `RegisterEvent` / `UnregisterEvent`                        | Per-frame event subscription                               |
| `LibStub(lib, optional)`                                   | Library registry — must be provided before other libs load |
| `print(...)` / `DEFAULT_CHAT_FRAME:AddMessage`             | → VSCode output channel                                    |
| `C_*` namespaces (wide, shallow)                           | Return safe defaults (nil, 0, {}, false) — see below       |
| `IsAddOnLoaded(name)` _(deprecated mainline)_              | Returns true for loaded addons                             |
| `GetAddOnMetadata(name, key)` _(deprecated mainline)_      | Reads from parsed TOC                                      |
| `UnitAura`/`UnitBuff`/`UnitDebuff` _(deprecated mainline)_ | Stub returning nil                                         |

**`FunctionContainer` return object** — `C_Timer.After` / `C_Timer.NewTicker` (and many other callback-registration APIs) return a `FunctionContainer`. Addons store and call `:Cancel()`:

```lua
-- FunctionContainer (from Annotations/Core/Type/FunctionContainer.lua)
{ Cancel(), IsCancelled() -> boolean, Invoke() }
```

Omitting this causes nil-method crashes in any addon that cancels its timers.

**Wide shallow stubs:** all 261 `C_*` namespaces from `_reference/vscode-wow-api/src/data/globalapi.ts` should be pre-generated as empty stub tables where every function returns `nil` (with optional debug log). Which specific functions are present per version is controlled by M5's flavor-bit model. See `docs/reference/ketho_wow_api.md` for the data sources.

## Frame Object Model

Lua frame objects proxy to IR/render nodes. Mutations push diffs to the webview.

**Core widget methods (all frame types):**

- Size/pos: `GetWidth`/`SetWidth`, `GetHeight`/`SetHeight`, `SetSize(w,h)`, `GetSize()`.
- Anchors: `SetPoint(point, [relativeTo, relativePoint, x, y])`, `ClearAllPoints()`, `SetAllPoints([frame])`, `GetRect()`.
- Visibility: `Show()`, `Hide()`, `IsShown()`, `IsVisible()`, `SetShown(bool)`, `SetAlpha(a)`, `GetAlpha()`.
- Hierarchy: `GetParent()`, `SetParent(frame)`, `GetName()`, `GetID()`.
- Scripts: `SetScript(event, fn)`, `GetScript(event)`, `HookScript(event, fn)`.
- Children: `CreateTexture([name, layer, inherits, subLevel])`, `CreateFontString([name, layer, inherits])`.

**Texture methods:** `SetTexture(path)`, `SetAtlas(atlasName, useAtlasSize)`, `SetTexCoord(...)`, `SetVertexColor(r,g,b,a)`, `SetColorTexture(r,g,b,a)`, `SetBlendMode(mode)`.

**FontString methods:** `SetText(text)`, `GetText()`, `SetTextColor(r,g,b,a)`, `SetFont(face, height, flags)`.

**Button methods:** `SetNormalTexture(path)`, `GetPushedTexture()`, `SetText(text)`, `GetText()`, `Click()` (fires OnClick).

**`parentKey` wiring:** when the XML IR has `parentKey="Icon"`, the runtime sets `parent.Icon = frameObject` after creation. `parentArray` appends to `parent.Icons` table.

## TOC Load Order

1. Parse `.toc` (see TOC File Parser above).
2. Execute sandbox bootstrap: disable stock builtins → load WoW compat shim → load stub tables.
3. For each file in order:
   - `.lua` → execute in sandbox with current `_G`.
   - `.xml` → M1 parse; register virtual templates; instantiate concrete frames (fire `OnLoad` per frame after creation).
4. After all files are loaded, fire `ADDON_LOADED` event for the addon name.
5. Fire `PLAYER_LOGIN` to trigger post-init code.
6. Declared `SavedVariables` globals → pre-populated as empty tables (or re-injected snapshots on hot-reload — see M6).

## Mixin System

```lua
-- WoW built-ins to provide:
Mixin(target, source1, source2, ...)           -- copy fields onto target, return target
CreateFromMixins(mixin1, mixin2, ...)          -- create new table, apply mixins
CreateAndInitFromMixin(mixin, ...)             -- create + call :Init(...)
secureMixin(target, source1, ...)              -- stub ok (secure taint not simulated)
```

When a frame has `mixin="FooMixin"`, after creation:

1. Look up `FooMixin` in `_G` (must be defined before use in TOC load order).
2. Copy all mixin fields onto the frame's Lua table.
3. Run `OnLoad` if defined.

## Script Events

| Event                        | Trigger                                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------------- |
| `OnLoad`                     | After a frame (and all children) are created and mixins applied                                     |
| `OnShow` / `OnHide`          | On `Show()`/`Hide()` call; also on `SetShown`                                                       |
| `OnSizeChanged(w, h)`        | On `SetSize`, `SetWidth`, `SetHeight`                                                               |
| `OnClick(button, down)`      | From webview `frameEvent` message (user clicks in preview)                                          |
| `OnEnter` / `OnLeave`        | From webview mouse-over events                                                                      |
| `OnUpdate(elapsed)`          | Throttled tick loop (virtual clock); protect against infinite loops                                 |
| `OnEvent(event, ...)`        | From the event dispatcher. Generic `...` args for M4; typed payloads via `event.ts` deferred to M7. |
| `OnValueChanged(value, ...)` | StatusBar / Slider value changes                                                                    |

**Inline scripts** compiled as: `load("return function(self, ...) " .. body .. " end")()(frame, ...)`.
**`method=`** resolves against the frame's mixin table. **`function=`** resolves against `_G`.
**`inherit="prepend|append|none"`** controls merging with inherited script bodies.

## Multi-Version API Differences

The sandbox loads a **flavor profile** (defined in M5) that controls which stubs are present. The flavor model uses bitflags from `_reference/vscode-wow-api/src/data/flavor.ts`:

- `mainline (0x1)` — Retail / The War Within: full `C_*`, `EventRegistry`, intrinsic frames
- `mists (0x2)` — Mists of Pandaria Classic (current Classic-progression client)
- `bcc (0x4)` — Burning Crusade Classic
- `classic_era (0x8)` — Classic Era

An API is available for a target if `(flavor.data[apiName] & targetBit) !== 0`. See M5 for details.

## Key Technical Decisions

- **wasmoon** (perf) + enumerated 5.1 shim; **fengari** only if in-webview Lua becomes necessary.
- Run all Lua in the **extension host** (full Node, not the sandboxed webview). Serialize frame diffs to the webview via the message protocol defined in M2.
- **Sandbox model: disable-and-replace** (mirrors ketho's LuaLS builtin approach).
- **WoW API stubs authored in Lua** — loaded as a bootstrap script into the sandbox. Contributors extend API coverage in the Lua 5.1 dialect they already know (Neovim model).
- **API availability via flavor bitflags** (flavor.ts) — not hand-authored profile JSON. See M5.

## Foreseen Hurdles

- **`setfenv`/`getfenv`** — the one remaining 5.1 gap after compat.lua enumeration. No clean emulation in Lua 5.4. Test against LibStub and AceAddon early.
- **Degree-based trig correctness** — silent rendering errors if the global `cos`/`sin`/`atan2` etc. are provided with radian semantics instead of degree semantics. High visual impact, no error thrown.
- **`OnUpdate` performance** — need instruction-count watchdog or throttle.
- **Infinite loops / stalled coroutines** — add a step-count limit (configurable).
- **LibStub** — must be provided before other libs load; simple (a registry table) but ordering matters.
- **Secure frame taint model** — ignore initially; protected hardware-event actions will not be faithfully simulated.

## Dependencies

**M1** (XML IR), **M2** (render tree to proxy). Feeds **M5** (flavor profiles), **M6** (hot reload), **M7** (test suite).

## Rough Effort

**M** (revised from L). The compat.lua/bit.lua/basic.lua corpus fully enumerates the shim; the `globalapi.ts` + `flavor.ts` data drives auto-generated stubs. Hand-authored work narrows to: `setfenv`/`getfenv` shim, ~40–60 behavior-bearing widget methods, `CreateFrame` object wiring, event dispatch, and C_Timer/FunctionContainer.
