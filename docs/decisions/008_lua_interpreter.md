# ADR 008 — Lua Interpreter Choice

**Status:** Accepted  
**Date:** 2026-05-29

## Context

M4 (Lua Shim Runtime) requires embedding a Lua interpreter in the extension host. WoW uses Lua 5.1 internally. The workspace already pins `Lua.runtime.version: "Lua 5.1"` via `ketho.wow-api`. No mainstream, actively maintained npm package ships true Lua 5.1 — WoW and a small number of embedded game engines are the only remaining 5.1 users, and they predate large-scale WASM projects.

The core tension: ideal fidelity points toward Lua 5.1, but maintaining an interpreter subproject is a significant ongoing cost. Every option requires some shim work to bridge the version gap.

## Options Considered

### lua5.1.js (self-maintained Lua 5.1 WASM)

A fork of an Emscripten build of Lua 5.1 ([logiceditor-com/lua5.1.js](https://github.com/logiceditor-com/lua5.1.js)). Community preview v0.9.1, 2 releases, single contributor, last meaningful commits in ~3 days of work. MIT license, could fork. Also evaluated: [daurnimator/lua.vm.js](https://github.com/daurnimator/lua.vm.js) (Lua 5.2, superseded by Fengari), `lua5.1.js` asm.js port (2013, historical interest only).

**Verdict:** True 5.1 semantics, zero shimming. But: we would own the WASM build pipeline, the C API JS bindings, TypeScript types, and maintenance — all work that wasmoon and Fengari already solved. Lua 5.1 is a frozen target so maintenance is low, but it is not zero. Deferred as last resort.

### Fengari (Lua 5.3, pure JS)

A Lua VM reimplemented in JavaScript, designed for JS/DOM interoperability. Same garbage collector as JS (no GC leaks). Pure JS means it runs in both Node and the webview sandbox. 5.3 is closer to 5.1 than 5.4.

**Verdict:** The 5.3 vs 5.4 delta against 5.1 is not meaningfully different for WoW addon code — the same shims (`setfenv`/`getfenv`, `unpack`, `bit`, `math.mod`, `loadstring`) are required in both cases. Being a reimplementation in JS carries implicit correctness risk that does not exist in the official C source. Benchmark against wasmoon: ~25x slower for pure Lua computation. Retained as first fallback if wasmoon hits unresolvable 5.1 compat issues.

### wasmoon (Lua 5.4, WASM)

The official Lua C source compiled to WebAssembly via Emscripten, with a TypeScript abstraction layer for JS↔Lua interoperability. Claims equivalent no-GC-leak interop story to Fengari. Runs in Node.js, Deno, and browser environments. Actively maintained, good TypeScript types.

**Benchmark:** 15ms vs 390ms (heap sort, 2k elements, 10x) vs Fengari. Wasmoon acknowledges heavy JS↔Lua interop workloads reduce this advantage.

## Decision

**wasmoon** as primary, with a documented escalation ladder:

1. **wasmoon** (primary) — official Lua C source via WASM, best maintained, no interpreter subproject
2. **Fengari** (first fallback) — if wasmoon proves unworkable for 5.1 compat
3. **Self-compiled Lua 5.1 WASM** (last resort) — fork lua5.1.js, borrow wasmoon's interop model; only if both JS-based options hit 5.1 compat roadblocks that cannot be shimmed

The version difference (5.3 vs 5.4) is irrelevant: both Fengari and wasmoon require the same finite shim list to reach 5.1 semantics. Given that, wasmoon's performance advantage and official-source correctness win.

## The `setfenv`/`getfenv` Question

These were removed in Lua 5.2. Both wasmoon and Fengari lack them natively. They are **known work with a known solution**, not an open risk:

```lua
local function findenv(f)
    local i = 1
    repeat
        local name, val = debug.getupvalue(f, i)
        if name == "_ENV" then return i, val end
        i = i + 1
    until name == nil
end

getfenv = function(f)
    if type(f) == "number" then
        f = debug.getinfo(f + 1, "f").func
        if f == nil then return _G end
    end
    local _, env = findenv(f)
    return env or _G
end

setfenv = function(f, t)
    if type(f) == "number" then
        f = debug.getinfo(f + 1, "f").func
    end
    local level = findenv(f)
    if level then debug.setupvalue(f, level, t) end
    return f
end
```

In Lua 5.4, every chunk loaded via `load()` has `_ENV` as an explicit upvalue. The `SETTABUP`/`GETTABUP` bytecode instructions look up the upvalue at runtime, not compile time — so `debug.setupvalue` to change `_ENV` takes effect for all subsequent global accesses in that function. This covers:

- `setfenv(1, setmetatable({}, {__index = _G}))` — the module isolation pattern
- AceAddon per-module environments
- Closures defined after the setfenv call that access globals (they share the `_ENV` upvalue slot with the parent chunk)

**Sandbox implication:** `debug.getupvalue`, `debug.setupvalue`, and `debug.getinfo` must remain available. All other `debug.*` functions (`sethook`, `getregistry`, `traceback`, etc.) are stripped from the sandbox.

## Full 5.1 Shim Surface

The complete list of shims required on top of wasmoon (5.4) to reach WoW Lua 5.1 semantics:

| Item                                                          | Solution                                                                                     |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `setfenv`/`getfenv`                                           | debug library shim (see above)                                                               |
| `unpack` global                                               | `unpack = table.unpack`                                                                      |
| `loadstring`                                                  | `loadstring = load`                                                                          |
| `math.mod` global                                             | `mod = math.fmod`                                                                            |
| `table.wipe`, `table.foreach`, `table.foreachi`, `table.getn` | WoW extensions, provided before compat aliases                                               |
| `string.trim`, `string.split`, `string.join`, `string.concat` | WoW string extensions                                                                        |
| `bit` library                                                 | Lua table implementation of `bit.band`/`bor`/`bxor`/`bnot`/`lshift`/`rshift`/`arshift`/`mod` |
| Degree-based trig globals                                     | `cos`/`sin`/`tan`/`acos`/`asin`/`atan`/`atan2` wrap `math.*` with degree conversion          |
| `goto` statement (5.2+ syntax)                                | Not needed — WoW addon code targeting 5.1 won't use it                                       |
| Bitwise operators (`&`, `\|`, `~`) (5.3+ syntax)              | Not needed — addons use `bit.band()` etc.                                                    |

Source of truth: `_reference/vscode-wow-api/Annotations/Core/Lua/compat.lua`, `bit.lua`, `basic.lua`.

## Consequences

- Bootstrap sequence must load the shim before any addon code runs.
- The `debug` library must be partially retained in the sandbox — stripped to the three functions needed for `setfenv`/`getfenv`, removing the rest.
- Test early against LibStub and AceAddon from `_live/Addons/` to confirm shim coverage before building the full frame model on top.
- If wasmoon is on Lua 5.5 (latest as of 2026-05-29), audit the 5.4→5.5 changelog for any new semantic shifts relevant to WoW addon code before finalising the shim list.

## References

- [ADR 001 — Language Stack](001_language_stack.md)
- [plan/004_toc_parser.md](../plan/004_toc_parser.md) through [plan/009_script_events.md](../plan/009_script_events.md)
- `_reference/vscode-wow-api/Annotations/Core/Lua/` (compat.lua, bit.lua, basic.lua)
