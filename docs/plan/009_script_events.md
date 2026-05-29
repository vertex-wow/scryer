# Milestone 9 — Script Events

**Status:** ✅ Complete (2026-05-29)

## Goal

Implement the full WoW script event system: `OnLoad` through `OnUpdate`, the Lua event dispatcher (`RegisterEvent`/`UnregisterEvent`/`OnEvent`), and the webview→Lua bridge for user interaction events (`OnClick`, `OnEnter`, `OnLeave`). After this milestone, addon interactive UI works end-to-end.

## What Was Built

### Handler Chain (HookScript)

`_scripts[id][event]` is now an array `{ fn1, fn2, ... }`. A local `_fire_script(frame, event, ...)` iterates and pcall-wraps each handler. All dispatch sites use `_fire_script`.

- `SetScript(e, fn)` → sets chain to `{ fn }` (or clears to nil if fn is nil)
- `HookScript(e, fn)` → appends fn to existing chain (or creates `{ fn }` if no prior handler)
- `GetScript(e)` → returns `handlers[1]` (the primary, for API compatibility)

### Dispatched Script Events

| Event                      | Trigger                                                                      |
| -------------------------- | ---------------------------------------------------------------------------- |
| `OnLoad`                   | After frame (and all children) are created; dispatches all handlers in chain |
| `OnShow`                   | From `FrameMT:Show()`                                                        |
| `OnHide`                   | From `FrameMT:Hide()`                                                        |
| `OnSizeChanged(w, h)`      | From `SetSize`, `SetWidth`, `SetHeight`                                      |
| `OnValueChanged(v, false)` | From `StatusBarMT:SetValue`, `SliderMT:SetValue`                             |
| `OnClick(btn, down)`       | From `ButtonMT:Click()` or webview frameEvent                                |
| `OnEnter` / `OnLeave`      | From webview frameEvent                                                      |
| `OnUpdate(elapsed)`        | From `__scryer_tick(elapsed)` (EventEngine tick loop)                        |
| `OnEvent(event, ...)`      | From `__scryer_fire_event` (event bus)                                       |

### WoW Event Dispatcher

`RegisterEvent`/`UnregisterEvent`/`UnregisterAllEvents` maintain the `_event_listeners` table. `__scryer_fire_event(eventName, ...)` iterates registered frames and calls `_fire_script(frame, "OnEvent", eventName, ...)`.

### OnLoad

`xml-importer.ts` now calls `__scryer_dispatch_script(frame.__id, "OnLoad")` after registering OnLoad scripts, firing all handlers in the chain (instead of only the primary via `GetScript`).

### OnUpdate Tick Loop

- `_update_frames` / `_update_frame_set` track frames with active OnUpdate handlers (maintained by `SetScript`/`HookScript`)
- `__scryer_tick(elapsed)` global iterates `_update_frames` and calls `_fire_script(frame, "OnUpdate", elapsed)`
- `EventEngine` (`src/lua/event-engine.ts`) runs a `setInterval` at `onUpdateHz` (default 60 Hz, configurable via `defaults.json`)
- Per-tick budget: `onUpdateTimeout` (default 100ms); exceeded ticks are killed with a warning

### Webview → Lua Event Bridge

- `FrameIR` gains `interactive?: boolean` and `runtimeId?: number`; set when a frame has OnClick/OnEnter/OnLeave handlers in the registry
- `__scryer_dispatch_script(frameId, event, ...)` global looks up the frame by runtime ID and fires its script chain
- Webview renderer attaches `click`/`mouseenter`/`mouseleave` listeners to interactive frames; posts `frameEvent` messages to the host
- `live-panel.ts` routes `frameEvent` → `EventEngine.dispatchFrameEvent()`

### Live Session Architecture

`ScryerLivePanel` keeps the sandbox alive after TOC run (instead of closing it immediately). The `EventEngine` tick loop runs until the panel is disposed or re-rendered. On file save, the old session is torn down and a new one is created.

## Config Values Added

In `defaults.json` and `config.ts`:

| Key               | Default | Description                    |
| ----------------- | ------- | ------------------------------ |
| `onUpdateHz`      | 60      | OnUpdate tick rate (ticks/sec) |
| `onUpdateTimeout` | 100     | Per-tick Lua budget in ms      |

## New Files

- `src/lua/event-engine.ts` — `EventEngine` class (tick loop, frame event dispatch, dirty-flush)

## Testing

All 25 M9 tests pass in `test/lua/script-events.test.ts`. Full suite: 348/348.
