# ADR 011 — Blizzard Lua Load Philosophy: C-Layer Stubs Only

## Context

Scryer pre-loads `Blizzard_SharedXMLBase` and `Blizzard_SharedXML` before running the user's addon, so that the shared utility library (mixins, color helpers, scroll utilities, etc.) is available in the Lua sandbox. These are real Blizzard Lua files extracted from the user's WoW installation.

The early implementation added "working stubs" in `src/lua/wow-api.ts` for things like `CallbackRegistryMixin`, `MathUtil`, `ColorMixin`, `FlagsMixin`, `CopyTable`, `EventRegistry`, and others. The intent was to prevent crashes when those Blizzard files failed to load. Over time, each time a Blizzard file failed, a new working stub was added — recreating the Blizzard Lua implementation inside Scryer.

This is unsustainable: the stubs diverge from the real implementations, must be maintained separately, and trend toward reimplementing the entire Blizzard shared library.

## Decision

**Only stub things that do not exist in any Blizzard Lua file.** Specifically:

- **Legitimate stubs** — APIs provided exclusively by the WoW C layer; no Blizzard Lua file defines them:
  - `C_*` namespaces (C bindings)
  - Core WoW globals: `Mixin`, `CreateFromMixins`, `issecure`, `issecretvalue`, `secureexecuterange`, `GenerateClosure`, `wipe` / `table.wipe`, `table.count`, string extensions (`string.trim`, `strtrim`, `strsplit`, `strjoin`)
  - Game state queries: `GetTime`, `GetLocale`, `UnitRace`, `UnitSex`, `IsAddOnLoaded`, etc.
  - Error/callstack internals: `SetErrorCallstackHeight`, `GetCallstackHeight`, `ProcessExceptionClient`, `AddSourceLocationExclude`
  - Globally-populated tables: `Enum`, `Constants` (populated by C, never defined in Lua)
  - WoW conventions: `SlashCmdList`, `nop`, `LibStub`

- **Not stubbed** — anything defined in a Blizzard Lua file we load. If the real file should provide it, the real file must succeed. No shadow implementation. Examples:
  - `CallbackRegistryMixin`, `EventRegistry` — `CallbackRegistry.lua` / `GlobalCallbackRegistry.lua`
  - `MathUtil`, `CopyTable`, `EnumUtil` — `MathUtil.lua`, `TableUtil.lua`, `EnumUtil.lua`
  - `ColorMixin`, `CreateColor` — `Color.lua`
  - `FlagsMixin`, `FlagsUtil` — `Flags.lua`
  - `CreateFramePool`, `CreateObjectPool` — `Pools.lua`
  - `GetFinalNameFromTextureKit` — `TextureUtil.lua`

## Load failure policy

- If a Blizzard file fails, it is a hard error logged to the user — not a silent skip.
- If a Blizzard file calls something from another addon not yet loaded, the fix is to load that addon first (fix load order), not to add a stub for the missing symbol.
- Files that cannot be loaded because they depend on addons Scryer deliberately does not load (e.g. UI addons like `Blizzard_Menu`) may be skipped with a debug log, but the symbols they provide must not be stubbed. If those symbols are needed for a user's addon to preview correctly, the solution is to expand the Blizzard preload list to include that addon.

## Load order

The correct preload order (each must fully succeed before the next):

1. `Blizzard_SharedXMLBase` — foundational mixins, utilities, colors base
2. `Blizzard_Colors` — color constants; required by `SharedColorConstants.lua` in SharedXML
3. `Blizzard_SharedXML` — NineSlice, scroll frames, shared templates

Files within each addon are loaded in the order specified by their `.toc` file.

## Rationale

- **Correctness** — the real Blizzard implementations are exact; any stub we write will diverge over time and across WoW versions.
- **Maintainability** — every stub added is code we own and must keep working. C-layer stubs are stable because the C API surface rarely changes; Lua shadow stubs chase a moving target.
- **Debuggability** — when a Blizzard file fails, a visible hard error surfaces the root cause immediately rather than masking it with a functioning stub that hides the gap.
- **Scope containment** — the stub list stays bounded at the C-layer surface. Without this rule, stubs grow without limit as each new Blizzard file failure triggers another stub addition.

## Consequences

- `mathUtilEpsilon` config option removed — the value is now provided by `MathUtil.lua` (which loads correctly once the C-layer stubs are in place).
- Any stub in `wow-api.ts` that shadows a Blizzard Lua function is a bug and should be removed, replacing it with either the correct C stub (if the issue is a missing C API) or a load-order fix (if the issue is a missing dependency).
- Tests that relied on the shadow stubs may need updating.
