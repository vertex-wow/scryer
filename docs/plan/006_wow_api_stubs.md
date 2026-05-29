# Milestone 6 — WoW API Stubs

## Goal

Register TypeScript functions into the M5 sandbox that implement the WoW API: essential globals, auto-generated C\_\* namespace stubs, LibStub, FunctionContainer, and C_Timer. After this milestone, addon library code (LibStub, AceLibrary, etc.) loads without crashing.

## Stub Model

WoW's API lives in C++ and is exposed to the Lua VM via the C API. We do the same: TypeScript functions are registered into the wasmoon sandbox via its JS↔Lua API.

```ts
lua.global.set("GetTime", () => virtualClock.now());
lua.global.set("date", (fmt: string, time?: number) => formatDate(fmt, time));
lua.global.set("print", (...args: unknown[]) => outputChannel.appendLine(args.join("\t")));
```

## C\_\* Namespace Auto-Generation

All 261 `C_*` namespaces from `_reference/vscode-wow-api/src/data/globalapi.ts` are pre-generated as stub tables where every function returns `nil` (with optional debug log). Flavor-gated availability (M10) is layered on top later; for M6 all functions are present regardless of flavor.

```ts
// Auto-generated from globalapi.ts:
for (const [namespace, fns] of cNamespaces) {
  const table: Record<string, () => null> = {};
  for (const fn of fns) table[fn] = () => null;
  lua.global.set(namespace, table);
}
```

## Priority Stubs

Behavioral stubs (not just nil-return) required for any non-trivial addon to load:

| API                                                   | Behavior                         |
| ----------------------------------------------------- | -------------------------------- |
| `GetTime()`                                           | Returns virtual clock time       |
| `date(fmt, time)`                                     | Wraps JS `Date`                  |
| `print(...)` / `DEFAULT_CHAT_FRAME:AddMessage`        | Writes to VS Code output channel |
| `IsAddOnLoaded(name)` _(deprecated mainline)_         | Returns `true` for loaded addons |
| `GetAddOnMetadata(name, key)` _(deprecated mainline)_ | Reads from parsed `TocFile`      |

**Deprecated functions must still be stubbed** — deprecated-since-10.0 means removed from mainline but still present in Classic flavors, and many mainline addons call them via compat layers.

## LibStub

LibStub is a simple registry table. It must be present before any other library attempts to register itself:

```lua
LibStub = LibStub or {
    libs = {},
    minors = {},
}
function LibStub:NewLibrary(major, minor)
    -- standard LibStub implementation
end
function LibStub:GetLibrary(major, silent)
    -- standard LibStub implementation
end
```

Provide the canonical LibStub implementation as a Lua string loaded during bootstrap. Do not attempt to load LibStub from `_live/` — it must be present before any file in the TOC runs.

## FunctionContainer

`C_Timer.After` / `C_Timer.NewTicker` (and many other callback-registration APIs) return a `FunctionContainer`. Addons store and call `:Cancel()`:

```lua
-- FunctionContainer (from Annotations/Core/Type/FunctionContainer.lua)
{ Cancel(), IsCancelled() -> boolean, Invoke() }
```

Omitting this causes nil-method crashes in any addon that cancels its timers. Provide as a TypeScript-constructed Lua table.

## C_Timer

```ts
// C_Timer.After(seconds, fn) — queues fn on virtual clock
// C_Timer.NewTicker(interval, fn, iterations) — repeating; returns FunctionContainer
```

The virtual clock is a simple counter advanced explicitly during the execution loop. C_Timer callbacks fire when the clock advances past their scheduled time. Infinite ticker protection: respect the `iterations` parameter; default to a safe cap if omitted.

## Testing

- Load actual LibStub source from `_live/Addons/` and verify it self-registers without error
- `C_Timer.After(0, fn)` queues `fn`; advancing the clock fires it
- `C_Timer.NewTicker(0.1, fn, 3)`:Cancel()` stops after 3 iterations
- All C\_\* namespaces exist and their functions return nil without error
- `print("hello")` writes to output channel

## Dependencies

**M5** (sandbox must be set up before stubs can be registered).

## Rough Effort

**S** — C\_\* auto-generation is mechanical; behavioral stubs are few; LibStub and C_Timer are well-specified.
