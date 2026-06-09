# Milestone 8 — TOC Execution Pipeline

## Goal

Wire together the `scryer.openLive` command with the full TOC load sequence: parse the `.toc`, bootstrap the sandbox, execute files in order, and fire `ADDON_LOADED` + `PLAYER_LOGIN`. After this milestone, opening a real simple addon from `_live/` renders its frames.

## Status: ✅ Complete (2026-05-29)

## Command: `scryer.openLive`

```jsonc
// package.json contributions
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

**Note on `.toc` language registration:** `resourceExtname == .toc` is sufficient for M8. A proper `toc` language contribution (syntax highlighting, `resourceLangId == toc`) is a future enhancement.

## Load Sequence

1. Parse the `.toc` file (M4 `TocFile`).
2. Bootstrap sandbox: M5 compat shim + M6 stubs.
3. Pre-populate `SavedVariables` globals as empty tables (no persistence; hot-reload re-injection deferred to M11).
4. For each file in `TocFile.files` in order:
   - `.lua` → execute in sandbox with current `_G`.
   - `.xml` → M1 parse; register virtual templates; instantiate concrete frames.
5. After all files loaded, fire `ADDON_LOADED` event for the addon name.
6. Fire `PLAYER_LOGIN` to trigger post-init code.

## XML Files in the TOC

When a `.xml` file is encountered, `importXmlFile` in `src/lua/xml-importer.ts`:

1. Parses the XML to get a `UiDocument`.
2. Accumulates virtual frames in the addon-local template map for cross-file template resolution.
3. Calls `resolveInheritance` with blizzard templates + accumulated addon templates.
4. Generates Lua code for each non-virtual frame: `CreateFrame` + property setters + inline scripts.
5. Inline scripts are injected via temporary Lua globals (`__xs0`, `__xs1`, …) to avoid any quoting issues; each is nil'd out in Lua immediately after `load()`.
6. OnLoad scripts fire via explicit `pcall` after children are created (matches WoW XML load order).

Frames created from XML are accessible by name in Lua `_G`, and Lua code in later TOC files can read and mutate them.

## Event Dispatch

Two changes to `frame-class.lua` support ADDON_LOADED / PLAYER_LOGIN dispatch:

1. **`_scripts` Lua-side table** (`{ [frameId] = { [event] = fn } }`) — `SetScript`/`GetScript`/`HookScript` now also read/write this table. This avoids the wasmoon null crash that occurs when Lua functions are round-tripped through JS (`GetScript` → JS → Lua) via `PromiseTypeExtension.pushValue`.

2. **`_event_listeners` Lua-side registry** (`{ [eventName] = { frame, … } }`) — `RegisterEvent`/`UnregisterEvent`/`UnregisterAllEvents` maintain this table alongside the existing TS-side attribute map. `__scryer_fire_event(eventName, ...)` iterates `_event_listeners` and dispatches `OnEvent` handlers from `_scripts` directly.

## Error Handling

- Parse errors in `.lua` files → logged to output channel; remaining files continue loading.
- Parse errors in `.xml` files → same.
- Lua runtime errors → logged with error message; load continues.
- Missing files listed in `.toc` → warned and skipped.
- Lua execution timeout → `doStringWithTimeout` (via `opts.timeout`) kills the call after a configurable deadline (default 5 000 ms from `defaults.json → sandboxTimeout`). Detected by `isLuaTimeout(e)` and reported as a distinct "[TOC] Lua timeout in …" message. See the wasmoon reference for why `engine.doString` alone cannot protect against tight loops.

## ScryerLivePanel Lifecycle

- Accepts a `.toc` URI (replacing the previous single-Lua-file mode).
- Panel title updated from `## Title:` (WoW color codes stripped).
- Re-renders when any `.lua`, `.xml`, or `.toc` file in the addon directory changes.
- Each render creates a fresh sandbox + registry (full re-run from scratch).

## Files Changed / Created

| File                          | Change                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lua/wow-api.ts`          | Initialize `__scryer_event_listeners = {}` at end of `registerWowApi`                                                                             |
| `src/lua/frame-class.lua`     | `_scripts` Lua table; updated `SetScript`/`GetScript`/`HookScript`/`RegisterEvent`/`UnregisterEvent`/`UnregisterAllEvents`; `__scryer_fire_event` |
| `src/lua/xml-importer.ts`     | New — XML file → Lua code generation + execution                                                                                                  |
| `src/lua/toc-runner.ts`       | New — TOC load sequence orchestration; `opts.timeout` wires per-call deadline to `doStringWithTimeout`                                            |
| `src/lua/sandbox.ts`          | `doStringWithTimeout` + `isLuaTimeout` — hook-based tight-loop killer; `createSandbox` accepts `opts.timeout` for `functionTimeout`               |
| `src/live-panel.ts`           | Rewritten — accepts `.toc` URI, uses `runTocAddon`; passes `flavorConfig.sandboxTimeout`                                                          |
| `src/extension.ts`            | `scryer.openLive` now validates `.toc` extension                                                                                                  |
| `package.json`                | Added `scryer.openLive` command + `.toc` context menus                                                                                            |
| `test/lua/toc-runner.test.ts` | New — integration tests for full TOC pipeline                                                                                                     |
| `test/fixtures/SimpleAddon/`  | New — hand-crafted test addon (.toc + .xml + .lua)                                                                                                |

## Testing

Integration tests in `test/lua/toc-runner.test.ts`:

- Lua file executed and frame created ✅
- XML frame created and accessible by name in Lua `_G` ✅
- XML frame appears in registry `serialize()` ✅
- `ADDON_LOADED` event dispatched to XML and Lua registered frames ✅
- `PLAYER_LOGIN` event dispatched ✅
- Missing TOC files warned and skipped ✅

## Dependencies

**M4** (TOC parser); **M7** (frame object model + ScryerLivePanel).

## Rough Effort

**S** — wiring; the hard parts (parser, sandbox, frame model) were already done.

## Known Issues / Follow-up

- `HookScript` in `_scripts` table currently stores only the last hook (not a chain); full chaining deferred to M9.
- Template application in `CreateFrame`'s 4th arg remains pending (todo item).
- Inline XML scripts with `method` attribute (Mixin method calls) not yet supported.
