# Milestone 9 — Script Events

## Goal

Implement the full WoW script event system: `OnLoad` through `OnUpdate`, the Lua event dispatcher (`RegisterEvent`/`UnregisterEvent`/`OnEvent`), and the webview→Lua bridge for user interaction events (`OnClick`, `OnEnter`, `OnLeave`). After this milestone, addon interactive UI works end-to-end.

## Script Handlers

Handlers are stored on the frame object during M7 (`SetScript`, `HookScript`). M9 dispatches them.

**Inline scripts** compiled as:

```lua
load("return function(self, ...) " .. body .. " end")()
```

**`method=`** resolves against the frame's mixin table. **`function=`** resolves against `_G`. **`inherit="prepend|append|none"`** controls merging with inherited script bodies.

## Event Table

| Event                        | Trigger                                                         |
| ---------------------------- | --------------------------------------------------------------- |
| `OnLoad`                     | After a frame (and all children) are created and mixins applied |
| `OnShow` / `OnHide`          | On `Show()`/`Hide()` call; also on `SetShown`                   |
| `OnSizeChanged(w, h)`        | On `SetSize`, `SetWidth`, `SetHeight`                           |
| `OnClick(button, down)`      | From webview `frameEvent` message (user clicks in preview)      |
| `OnEnter` / `OnLeave`        | From webview mouse-over events                                  |
| `OnUpdate(elapsed)`          | Throttled virtual clock tick; protected against infinite loops  |
| `OnEvent(event, ...)`        | From the event dispatcher                                       |
| `OnValueChanged(value, ...)` | StatusBar / Slider value changes                                |

## WoW Event Dispatcher

```ts
// Per-frame event subscription (TypeScript-backed):
lua.global.set("RegisterEvent", (frame, event) => eventBus.register(frame, event));
lua.global.set("UnregisterEvent", (frame, event) => eventBus.unregister(frame, event));

// Fire an event to all registered frames:
eventBus.fire("PLAYER_LOGIN"); // → each registered frame's OnEvent(self, "PLAYER_LOGIN")
eventBus.fire("BAG_UPDATE", 0); // → OnEvent(self, "BAG_UPDATE", 0)
```

Event argument types are generic in M9 (`...`). Typed payloads from `_reference/vscode-wow-api/src/data/event.ts` (1739 events, 7648 lines) are an M12 enhancement.

## Webview → Lua Event Bridge

The webview sends `frameEvent` messages to the extension host when the user interacts with the preview:

```ts
// webview message → extension host → Lua dispatch
case "frameEvent": {
    const frame = frameRegistry.get(msg.frameId);
    if (msg.type === "click") frame.fireScript("OnClick", msg.button, true);
    if (msg.type === "mouseenter") frame.fireScript("OnEnter");
    if (msg.type === "mouseleave") frame.fireScript("OnLeave");
}
```

The webview emits these events for frames that have script handlers registered (the render protocol can mark frames as interactive).

## OnUpdate — Throttle and Watchdog

`OnUpdate` handlers fire on a virtual tick loop. Without protection, a tight `OnUpdate` can freeze the extension host.

- **Throttle:** tick no faster than 60 Hz (configurable via `defaults.json`).
- **Instruction watchdog:** wasmoon supports a step-count hook; configure a per-tick limit. If exceeded, log a warning and skip the frame for that tick.
- **Infinite loop protection:** global instruction count cap per sandbox execution (configurable).

## HookScript

`HookScript(event, fn)` appends `fn` after the existing handler without replacing it. Maintain a handler chain per event per frame: `[originalHandler, ...hooks]`. Fire in order.

## Testing

- `frame:SetScript("OnLoad", fn)` — `fn` fires after addon loads
- `frame:SetScript("OnClick", fn)` — clicking the frame in the webview fires `fn`
- `RegisterEvent("PLAYER_LOGIN")` + `OnEvent` — handler fires on `PLAYER_LOGIN`
- `frame:SetScript("OnUpdate", fn)` — fn fires on each tick; instruction watchdog terminates a tight loop
- `HookScript` — both original and hook fire in order
- Inline script compilation: `<OnLoad>self:Hide()</OnLoad>` hides the frame after load

## Dependencies

**M8** (execution pipeline must be running for events to fire in context).

## Rough Effort

**S–M** — dispatcher and bridge logic are straightforward; `OnUpdate` watchdog and `HookScript` chain need care.
