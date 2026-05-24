# ADR 003 — Hot-Reload State Preservation

**Status:** Accepted  
**Date:** 2026-05-24

## Context

Hot-reload is the headline feature of this tool — live preview on file save, without the 2–5 s `/reload` round-trip WoW itself requires. The question is: what Lua and UI state should survive a reload?

The initial plan said "full Lua sandbox reset on any Lua change" for correctness. This matches what real WoW's `/reload` does. The concern was that preserving state would introduce subtle correctness bugs, while a full reset would make the tool feel disruptive (frames jumping back to default positions, addon databases resetting mid-session).

## The Problem with Partial Lua State Preservation

Full Lua sandbox reset is not conservative caution — it is technically required for shared-`_G` WoW addon Lua. The hazards are real and verified against the live corpus:

- **Double-registered events:** re-running `frame:RegisterEvent("PLAYER_LOGIN")` without unregistering first fires handlers twice per occurrence. DBM-Core, Auctionator, and most addons register events at file-eval time.
- **LibStub version-guard no-ops:** `LibStub:NewLibrary("Foo", 1)` returns `nil` on re-run if the old version is still registered. The changed file is silently ignored; old code stays live. LibStub is present in a large fraction of the 152-addon corpus.
- **Stale closures over init-block locals:** new code expects the new local; preserved `_G` holds the old value.
- **No module system:** WoW addon Lua shares `_G` entirely. There are no ES-module-style boundaries to swap, so true hot-module replacement (HMR) cannot be made safe as a default.

## Reframe: "Experience State" vs "Execution State"

The state users _actually notice_ resetting is not Lua execution state — it is three categories of display/persistence state that live outside the Lua execution graph:

| Category        | What it is                            | Where it lives                                                  |
| --------------- | ------------------------------------- | --------------------------------------------------------------- |
| SavedVariables  | Addon databases, config               | Named Lua globals declared in `## SavedVariables` TOC directive |
| Frame positions | Where the user dragged movable frames | Renderer-side (CSS position), not Lua semantics                 |
| UI visibility   | Which panels/tabs are open            | `Show()`/`Hide()` state, keyed by stable frame ID               |

All three can be safely captured and re-applied across a full Lua sandbox reset.

## Decision

**Full Lua sandbox reset as the default, plus selective re-application of experience state.**

### What is reset

All Lua execution state: globals, closures, LibStub registry, metatables, in-flight `C_Timer` callbacks, event registrations, virtual clock. Non-negotiable for correctness.

### What is preserved (captured before reset, re-applied after)

1. **SavedVariables:** snapshot the named globals declared in `## SavedVariables` and `## SavedVariablesPerCharacter` before teardown → re-inject into the fresh sandbox's `_G` _before_ addon files run. This mirrors exactly what WoW does across `/reload` and sessions, and is the correct semantic.

2. **Frame positions:** capture current pixel position of any user-moved frame (by stable frame ID) in the renderer → re-apply `SetPoint` overrides after reload. Stable ID = frame `name` attribute or dotted `parentKey` path; skip re-apply if ID is absent or changed.

3. **Open/closed visibility:** capture `IsShown()` state of named frames → re-apply via `Show()`/`Hide()` after reload. Skip if frame ID changed; fall back to addon's default visibility.

### Reload algorithm

```
on save (debounced 100–150 ms):
  if .toc changed:
    → full reload (recompute load order, no state capture)
  elif only .xml changed:
    → XML fast path: re-parse subtree, ID-stable diff, repaint. NO Lua re-exec.
  else (.lua changed):
    1. CAPTURE: SavedVariables snapshot + frame positions + visibility
    2. TEARDOWN: cancel timers, unregister events, dispose frame registry,
                 reset virtual clock, rebuild sandbox
    3. RE-INJECT: SavedVariables into fresh _G before files run
    4. RE-RUN: TOC load order → fire ADDON_LOADED → PLAYER_LOGIN
    5. RE-APPLY: frame positions + visibility for stable IDs (skip changed IDs)
    6. UX: show "Reloading..." overlay; success flash; error toast with file:line
```

## True Lua HMR — Deferred

Incremental Lua reload (re-execute only the changed file, preserve the rest) is deferred as a future opt-in experimental mode with mandatory fallback to full reset on any error. It is not feasible as a default because:

- WoW addon Lua has no module system — side effects on `_G` from the changed file cannot be cleanly undone.
- Other files may have cached `local` handles to tables the changed file redefines — those locals are invisible to the reload mechanism.
- LibStub's version-guard makes re-running a lib file a silent no-op by design.

If implemented, it must: (a) be opt-in, (b) be labeled "experimental / best-effort," (c) catch any Lua error or detected state inconsistency and immediately fall back to full reset.

## Consequences

- The TOC parser must expose `savedVariables` and `savedVariablesPerChar` arrays (already in the planned `TocFile` interface).
- Frames need stable IDs in the renderer — derived from `name` attribute or dotted `parentKey` path. Frames without stable IDs cannot have their positions/visibility restored.
- The virtual clock must be resettable to 0 as part of teardown.
- The `C_Timer` queue must be fully clearable on teardown.
- SavedVariables snapshot/re-inject provides the foundation for a future "SavedVariables emulation" feature (persist across extension sessions using VSCode workspace state).

## References

- [plan/006_hot_reload.md](../plan/006_hot_reload.md)
- [plan/004_lua_runtime.md](../plan/004_lua_runtime.md)
