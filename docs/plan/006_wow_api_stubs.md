# Milestone 6 — WoW API Stubs

## Goal

Register TypeScript functions into the M5 sandbox that implement the WoW API: essential globals, auto-generated C\_\* namespace stubs, LibStub, FunctionContainer, and C_Timer. After this milestone, addon library code (LibStub, AceLibrary, etc.) loads without crashing.

## What was built

**`src/lua/wow-api.ts`** — `registerWowApi(lua, opts)` injects all WoW API stubs into an existing M5 sandbox. Also exports `VirtualClock` and `FunctionContainerHandle`.

### C\_\* Namespace Stubs

`_reference/vscode-wow-api/src/data/globalapi.ts` lists 208 `C_*` namespace names (not 261 as originally estimated — the estimate was stale). The namespace names are embedded as a static `const` array in `wow-api.ts`.

Each namespace is a real Lua table (not a JS proxy) with an `__index` metamethod that returns a nil-returning stub function for any key:

```lua
C_AccountInfo = setmetatable({}, { __index = function() return function() return nil end end })
```

This approach was chosen over enumerating per-namespace function names because:

- `globalapi.ts` contains only namespace names, not function signatures
- The `__index` approach is robust to undocumented or new functions
- `type(C_AccountInfo)` correctly returns `"table"` (important for addon compat checks)

`C_Timer` is excluded from this block and is given a real implementation below.

### Priority Stubs

| API                                                      | Behavior                                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `GetTime()`                                              | Returns `VirtualClock.now()`                                                    |
| `date(fmt, time)`                                        | Wraps JS `Date`; supports `"*t"` table, `"!"` UTC prefix, common `%` directives |
| `print(...)`                                             | Calls `opts.print` callback (defaults to `console.log`)                         |
| `DEFAULT_CHAT_FRAME:AddMessage`                          | Routes to the same print callback                                               |
| `IsAddOnLoaded(name)`                                    | Calls `opts.isAddonLoaded` callback; defaults to always-true                    |
| `GetAddOnMetadata(name, key)`                            | Calls `opts.getAddonMetadata` callback; defaults to nil                         |
| `securecall` / `securecallfunction`                      | pcall-style wrappers; swallow errors                                            |
| `hooksecurefunc` / `geterrorhandler` / `seterrorhandler` | No-op stubs to prevent nil crashes                                              |

`securecall` and the error handler stubs were not in the original plan but are required for CallbackHandler-1.0 (and by extension most Ace libraries) to parse without errors.

`DEFAULT_CHAT_FRAME` and `C_Timer` are built as real Lua tables (not JS proxies) to ensure `type() == "table"` and to avoid wasmoon's proxy method self-stripping behavior. See `docs/reference/wasmoon.md` for details.

### LibStub

Canonical LibStub implementation embedded as a Lua string constant (`LIBSTUB_LUA`). Loaded during `registerWowApi`. Supports `NewLibrary`, `GetLibrary`, `IterateLibraries`, and the `__call` metatable shortcut (`LibStub("name")`).

### VirtualClock

`VirtualClock` is a simple time counter with a timer queue. `advance(dt)` fires all due timers in chronological order; repeating timers (NewTicker) can fire multiple times per `advance` call. A one-pass approach was insufficient for large `dt` values — the implementation uses a loop that picks the earliest due timer on each iteration.

### C_Timer

Built as a real Lua table (see note above). Methods:

- `C_Timer.After(seconds, fn)` — one-shot; schedules via `VirtualClock.schedule`
- `C_Timer.NewTicker(interval, fn, iterations)` — repeating; defaults to a 10 000-iteration cap
- `C_Timer.NewTimer(seconds, fn)` — alias for `After`

All methods return a `FunctionContainerHandle` JS object with `Cancel()`, `IsCancelled()`, `Invoke()`. This object is a wasmoon proxy userdata in Lua; `type()` returns `"userdata"`, but colon-method calls work correctly because the methods take no meaningful arguments (wasmoon strips the implicit self).

## Testing

`test/lua/wow-api.test.ts` — covers:

- All C\_\* namespaces are Lua tables; any function call returns nil
- `GetTime` reflects clock advances
- `print` and `DEFAULT_CHAT_FRAME:AddMessage` capture output
- `date` with format strings and `"*t"` table (including UTC)
- `IsAddOnLoaded` / `GetAddOnMetadata` callbacks
- **LibStub** — NewLibrary / GetLibrary / IterateLibraries / `__call`; plus loading `_live/Addons/Altoholic/Libs/CallbackHandler-1.0/CallbackHandler-1.0.lua` and verifying it self-registers without error. (LibStub itself is not present as a standalone file in `_live/`; CallbackHandler is the earliest consumer available.)
- **C_Timer** — After fires, After(0) fires on next advance, Cancel prevents fire, IsCancelled reflects state, NewTicker fires correct iteration count, NewTicker:Cancel stops future fires
- **VirtualClock** — starts at 0, advance increments, one-shot fires once, repeating fires correct count

## wasmoon gotchas encountered

Several non-obvious wasmoon behaviors were discovered during implementation. All are documented in `docs/reference/wasmoon.md`. Key issues that affected the implementation:

- JS `null` return crashes PromiseTypeExtension — all stubs return `undefined` (void)
- JS objects set via `global.set` are Lua userdata — `DEFAULT_CHAT_FRAME` and `C_Timer` built as Lua tables
- Proxy colon-calls strip the Lua `self` argument — avoided via Lua table wrappers
- `doString` returns only the first return value — tests use single-value returns or tables

## Dependencies

**M5** (sandbox must be set up before stubs can be registered).

## Effort

**S** — as estimated. C\_\* generation was mechanical; wasmoon proxy behavior added unexpected complexity.
