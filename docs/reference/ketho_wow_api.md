# Reference — ketho.wow-api (`_reference/vscode-wow-api/`)

**License:** MIT  
**Source:** `_reference/vscode-wow-api/` (read-only)  
**Purpose:** Editor-time LuaLS extension providing WoW API completions. We reuse its _data corpus_ as a bounded, machine-readable source for API availability, event signatures, and the Lua compat shim. We do not duplicate its completion functionality.

---

## Key Files and Their Role in This Project

### `src/data/flavor.ts`

**7218 API function entries** mapping each function name to a bitflag indicating which WoW game flavors it is present in.

```ts
// Flavor bits
mainline = 0x1; // Retail / The War Within (current)
mists = 0x2; // Mists of Pandaria Classic (current progression)
bcc = 0x4; // Burning Crusade Classic
classic_era = 0x8; // Classic Era (perpetual 1.x)
```

Usage for API availability:

```ts
function isAvailable(apiName: string, flavor: keyof typeof FLAVOR_BITS): boolean {
  const entry = flavorData[apiName];
  if (entry === undefined) return false;
  return (entry & FLAVOR_BITS[flavor]) !== 0;
}
```

**Maintenance note:** The Classic-progression flavor (`mists` today) rotates with Blizzard's seasonal schedule. Pin a versioned copy; track which ketho release was used. When a new Classic expansion launches, update.

**Deprecated functions** (`deprecated.ts`) have their `mainline` bit cleared but Classic bits set. The flavor model handles this automatically — no separate deprecated list needed at stub time.

### `src/data/event.ts`

**1739 typed WoW events** with full argument signatures (7648 lines total). Example shape:

```ts
BAG_UPDATE: [bagID: number];
PLAYER_LOGIN: [];
COMBAT_LOG_EVENT_UNFILTERED: [...args: unknown[]];
```

Used in M7: a typed TypeScript `fireEvent` helper for the host-side headless test runner, validated against these signatures at build time. Not needed for the untyped Lua-side `T.fireEvent` in M4.

### `src/data/globalapi.ts`

**261 C\_\* namespace definitions** (the full WoW C API surface). Used at M4 sandbox init to generate the namespace skeleton — iterate all entries, install only those available for the active flavor (via `flavor.ts` mask), stub the rest with "not available in this version" returns.

### `src/data/deprecated.ts`

Functions deprecated since WoW 10.0.0. Their `mainline` bit is cleared in `flavor.ts` so they are absent from Retail stubs automatically. Classic bits remain set, so they appear in Classic stubs. No separate handling needed.

### `src/data/globalstring/enUS.ts`

**GlobalStrings** — the in-game string constant table (`ATTACK`, `CANCEL`, `LOGOUT`, etc.). Inject into the sandbox's `_G` at startup as a read-only table. This prevents nil errors on addons that reference `GLOBAL_STRING_NAME` directly.

---

## Lua Annotation Files (Core/ only)

Only the `Core/` annotation tree is in scope. `FrameXML/` contains stubs for Blizzard's own addon code (ActionBars, UIParent, etc.) — not needed for the runtime.

### `Annotations/Core/Lua/compat.lua` (64 lines)

The canonical WoW Lua shim. Provides exactly what WoW adds on top of base Lua 5.1:

```lua
-- Degree-based trig (CRITICAL — WoW trig takes degrees, not radians)
cos  = function(x) return math.cos(math.rad(x)) end
sin  = function(x) return math.sin(math.rad(x)) end
tan  = function(x) return math.tan(math.rad(x)) end
acos = function(x) return math.deg(math.acos(x)) end
asin = function(x) return math.deg(math.asin(x)) end
atan = function(x, y) return math.deg(math.atan(x, y)) end
atan2 = function(y, x) return math.deg(math.atan(y, x)) end

-- Math aliases
abs  = math.abs
ceil = math.ceil
floor = math.floor
max  = math.max
min  = math.min
mod  = math.fmod
sqrt = math.sqrt
-- ... (full list in source)

-- String aliases
format = string.format
strtrim = ...
strsplit = ...
strjoin = ...
-- ... (full list in source)

-- Table/misc
tinsert = table.insert
tremove = table.remove
wipe = function(t) ... end
unpack = table.unpack  -- Lua 5.1 compat
```

**CRITICAL:** `cos`/`sin`/`atan2` take **degrees**, not radians. Providing standard radian functions under these names causes silent rendering errors (frames appear in wrong positions, rotations are wrong). This shim must be installed before any addon code runs.

### `Annotations/Core/Lua/bit.lua`

The `bit` library (Lua 5.1's bitwise operations, absent in 5.3/5.4 standard library):

```lua
bit.band(a, b)    -- bitwise AND
bit.bor(a, b)     -- bitwise OR
bit.bxor(a, b)    -- bitwise XOR
bit.bnot(a)       -- bitwise NOT
bit.lshift(a, n)  -- left shift
bit.rshift(a, n)  -- logical right shift
bit.arshift(a, n) -- arithmetic right shift
bit.mod(a, b)     -- modulo
```

Many addons use `bit.band`/`bit.bor` for flag checking. Must be present.

### `Annotations/Core/Lua/basic.lua`

Additional WoW Lua globals (beyond compat.lua):

```lua
-- Lua 5.1 compat
unpack = table.unpack
select = select

-- Type introspection
type = type
pairs = pairs
ipairs = ipairs
next = next
rawget = rawget
rawset = rawset
rawequal = rawequal
rawlen = rawlen

-- Error handling
error = error
assert = assert
pcall = pcall
xpcall = xpcall
```

### `Annotations/Core/Widget/` (519 files)

LuaLS annotation files for the full WoW widget hierarchy. Not directly executed, but useful as the authoritative list of frame methods and properties that need stubs in M4's frame object model. Key types: `Frame`, `Button`, `CheckButton`, `StatusBar`, `EditBox`, `ScrollFrame`, `Texture`, `FontString`, `AnimationGroup`.

---

## Open Risk: `setfenv`/`getfenv`

These Lua 5.1 functions (per-function environment control) were removed in Lua 5.2 and are absent in both fengari (5.3) and wasmoon (5.4). Some addon code uses them for sandboxing within the addon itself. There is no clean emulation; the best approach is:

1. Provide no-op stubs that warn on use.
2. Track which addons in `_live/` call them.
3. Assess whether full emulation is needed based on corpus.

This is the one remaining Lua fidelity risk not covered by the shim.

---

## Annotation Scope Decision

| Tree                     | In scope? | Reason                                              |
| ------------------------ | --------- | --------------------------------------------------- |
| `Core/Lua/`              | Yes       | WoW Lua shim (`compat.lua`, `bit.lua`, `basic.lua`) |
| `Core/Widget/`           | Yes       | Frame method stubs for M4                           |
| `Core/Events/`           | Yes (M7)  | Typed event signatures for test runner              |
| `FrameXML/`              | No        | Blizzard's own addon stubs — not needed             |
| `Annotations/Libraries/` | Partial   | LibStub stub needed (M4); others as discovered      |
