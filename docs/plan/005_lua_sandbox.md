# Milestone 5 — Lua Sandbox + 5.1 Compat Shim

## Goal

Embed wasmoon in the extension host, disable all stock Lua standard libraries, and load a WoW-compatible Lua 5.1 environment: `setfenv`/`getfenv` shim, compat aliases, `bit` library, and GlobalStrings. No frames, no WoW API yet — just a correct, sandboxed Lua 5.1-like execution environment.

This is the **highest-risk step in the Lua runtime series** and must be validated before anything else is built on top.

## Interpreter Choice

**wasmoon** — official Lua C source compiled to WASM. See [ADR 008](../decisions/008_lua_interpreter.md) for the full rationale and fallback ladder (Fengari → self-compiled Lua 5.1 WASM).

## Sandbox Model: Disable and Replace

Remove or null out all stock Lua globals before executing any addon code, then re-provide WoW-flavored versions:

```ts
// Globals to remove entirely
const REMOVE = ["io", "os", "package", "loadfile", "dofile", "debug"];

// debug is partially retained — see setfenv shim below
```

**What is re-provided (WoW versions, not raw Lua stdlib):**

| Library                                                        | Treatment                                                                                                                                                                                            |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `string.*`                                                     | Stock + WoW extensions (`string.trim`, `string.split`, `string.join`, `string.concat`)                                                                                                               |
| `table.*`                                                      | Stock + WoW extensions (`table.wipe`, `table.foreach`, `table.foreachi`, `table.getn`)                                                                                                               |
| `math.*`                                                       | Stock math; global trig aliases use **degrees** (see critical note below)                                                                                                                            |
| Basic globals                                                  | `select`, `pairs`/`ipairs`, `next`, `type`, `tostring`/`tonumber`, `pcall`/`xpcall`, `error`, `assert`, `setmetatable`/`getmetatable`, `rawget`/`rawset`/`rawequal`, `coroutine`, controlled `print` |
| `debug`                                                        | Restricted to `getupvalue`, `setupvalue`, `getinfo` only — required for `setfenv`/`getfenv` shim                                                                                                     |
| `io`, `os.execute`, `os.exit`, `package`, `loadfile`, `dofile` | Removed entirely                                                                                                                                                                                     |

## WoW Lua 5.1 Compatibility Shim

Source of truth: `_reference/vscode-wow-api/Annotations/Core/Lua/` (`compat.lua`, `bit.lua`, `basic.lua`).

### `setfenv`/`getfenv` (debug library shim)

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

Works because Lua 5.4 chunks loaded via `load()` have `_ENV` as an explicit upvalue; `SETTABUP`/`GETTABUP` bytecode looks up the upvalue at runtime, so `setupvalue` takes effect for all subsequent global accesses.

### Table aliases (from compat.lua)

```lua
tinsert = table.insert;  tremove = table.remove;  wipe = table.wipe
sort = table.sort;  foreach = table.foreach;  foreachi = table.foreachi;  getn = table.getn
```

Note: `table.wipe`, `table.foreach`, `table.foreachi`, `table.getn` are WoW extensions — provided before these aliases resolve.

### String aliases (from compat.lua)

```lua
strbyte=string.byte;  strchar=string.char;  strfind=string.find;  format=string.format
gmatch=string.gmatch;  gsub=string.gsub;  strlen=string.len;  strlower=string.lower
strmatch=string.match;  strrep=string.rep;  strrev=string.reverse;  strsub=string.sub
strupper=string.upper;  strtrim=string.trim;  strsplit=string.split
strjoin=string.join;  strconcat=string.concat
```

Note: `string.trim`, `string.split`, `string.join`, `string.concat` are WoW extensions — provided before these aliases resolve.

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
-- Standard numeric globals:
abs=math.abs;  ceil=math.ceil;  floor=math.floor;  max=math.max;  min=math.min
mod=math.fmod;  log10=math.log10;  exp=math.exp;  sqrt=math.sqrt
PI=math.pi;  random=math.random
```

**Providing radian trig would cause silent, wrong rendering with no error.** This must be exact.

### `bit` library (from bit.lua)

wasmoon (Lua 5.4) has no `bit` table. Provide:

```lua
bit.band, bit.bor, bit.bxor, bit.bnot, bit.lshift, bit.rshift, bit.arshift, bit.mod
```

### Other 5.1 gaps

| Item            | Fix                                  |
| --------------- | ------------------------------------ |
| `unpack` global | `unpack = table.unpack`              |
| `loadstring`    | `loadstring = load`                  |
| `table.maxn`    | Provide WoW extension implementation |

## GlobalStrings

Pre-populate `_G` with WoW global string constants (`OKAY`, `CANCEL`, `CLOSE`, `RAID_CLASS_COLORS`, etc.) from `_reference/vscode-wow-api/src/data/globalstring/enUS.ts`. Covers `FontString text="GLOBAL_STRING"` and Lua calls like `button:SetText(CLOSE)`. Locale-awareness deferred; enUS sufficient for M5.

**Note:** `globals.ts` (47k lines) is a completions source for LuaLS — do not attempt to ingest it.

## Bootstrap Sequence

1. Create a new wasmoon Lua state.
2. Remove dangerous globals.
3. Restrict `debug` to the three required functions.
4. Register WoW string/table/math extensions (TypeScript → Lua globals via wasmoon API).
5. Execute the Lua compat bootstrap script (setfenv/getfenv, all aliases, bit library, GlobalStrings).
6. Sandbox is ready for WoW API stub registration (M6).

## Testing

Unit tests that exercise the shim surface directly:

- `setfenv(1, env)` inside a loaded chunk redirects subsequent global writes to `env`
- `getfenv(fn)` returns the function's `_ENV`
- `sin(90) == 1.0` (degree trig)
- `acos(1) == 0.0` (degree trig)
- `tinsert`, `tremove`, `wipe`, `sort` resolve
- `strsplit`, `strjoin`, `strtrim` resolve and behave correctly
- `bit.band(3, 1) == 1`
- `unpack({1,2,3}) == 1, 2, 3`
- `loadstring("return 1+1")() == 2`
- Dangerous globals are absent: `io`, `os.execute`, `debug.sethook`

## Dependencies

None — wasmoon is a new npm dependency; the sandbox is self-contained.

## Rough Effort

**S–M** — wasmoon setup is trivial; the shim is well-understood but has several dozen items to implement and test correctly.
