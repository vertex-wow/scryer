# Milestone 7 — Frame Object Model + ScryerLivePanel

## Goal

Implement `CreateFrame` and the core widget object model backed by the render tree. Open a new `ScryerLivePanel` webview. On each Lua mutation, send the full frame tree to the webview for rendering. First visual payoff: frames created in Lua appear in the preview.

## ScryerLivePanel

A **new, separate panel** — not a reuse of `ScryerPanel`. The static preview panel (`scryer.open`) is a fast "fake it" tool and stays around as-is. The live panel is the beginning of a full sandbox that will diverge significantly as later milestones are added.

Fork `panel.ts` as a starting point if convenient; the two panels share the same webview HTML shell, asset-serving protocol, and message types from M2. Diverge freely from there.

**Full re-render on mutation:** on each Lua mutation, serialize the complete frame tree to the webview as a JSON message — no diffing. Frame-diff optimization is a future backlog item. This is correct, simple, and sufficient for M7's goal.

## CreateFrame

`CreateFrame(type, name, parent, template)` is the primary entry point for all Lua-driven UI.

```ts
// TypeScript side: CreateFrame registered as a Lua global via wasmoon
lua.global.set("CreateFrame", (type, name, parent, template) => {
  const frame = frameRegistry.create(type, name, parent, template);
  return frame.luaProxy; // a Lua table with method callbacks
});
```

Each frame object is a Lua table whose methods are TypeScript functions registered via wasmoon. Mutations update the TypeScript frame tree and schedule a re-render.

## Frame Registry

- `UIParent` and `WorldFrame` are pre-created at bootstrap.
- Named frames are registered by name in a global map; `GetFrame("name")` returns them.
- Anonymous frames (no name) exist only via Lua variable references.

## Core Widget Methods (all frame types)

**Size/position:**
`GetWidth`/`SetWidth`, `GetHeight`/`SetHeight`, `SetSize(w,h)`, `GetSize()`

**Anchors:**
`SetPoint(point, [relativeTo, relativePoint, x, y])`, `ClearAllPoints()`, `SetAllPoints([frame])`, `GetRect()`

**Visibility:**
`Show()`, `Hide()`, `IsShown()`, `IsVisible()`, `SetShown(bool)`, `SetAlpha(a)`, `GetAlpha()`

**Hierarchy:**
`GetParent()`, `SetParent(frame)`, `GetName()`, `GetID()`

**Scripts (wired in M9):**
`SetScript(event, fn)`, `GetScript(event)`, `HookScript(event, fn)` — store handlers on the frame object; dispatch is M9.

**Children:**
`CreateTexture([name, layer, inherits, subLevel])`, `CreateFontString([name, layer, inherits])`

## Widget-Type-Specific Methods

**Texture:** `SetTexture(path)`, `SetAtlas(atlasName, useAtlasSize)`, `SetTexCoord(...)`, `SetVertexColor(r,g,b,a)`, `SetColorTexture(r,g,b,a)`, `SetBlendMode(mode)`

**FontString:** `SetText(text)`, `GetText()`, `SetTextColor(r,g,b,a)`, `SetFont(face, height, flags)`

**Button:** `SetNormalTexture(path)`, `GetPushedTexture()`, `SetText(text)`, `GetText()`, `Click()` (fires OnClick — M9)

## parentKey / parentArray Wiring

When a frame has `parentKey="Icon"`, set `parent.Icon = frameObject` after creation. `parentArray` appends to `parent.Icons` table. This mirrors the XML IR parentKey logic from M1 and is required for any addon that references child frames by key.

## Mixin System

```lua
-- WoW built-ins to provide (registered as TypeScript Lua globals):
Mixin(target, source1, source2, ...)           -- copy fields onto target, return target
CreateFromMixins(mixin1, mixin2, ...)          -- create new table, apply mixins
CreateAndInitFromMixin(mixin, ...)             -- create + call :Init(...)
secureMixin(target, source1, ...)              -- stub ok (secure taint not simulated)
```

When a frame has `mixin="FooMixin"`:

1. Look up `FooMixin` in `_G` (must be defined before use in TOC load order).
2. Copy all mixin fields onto the frame's Lua table.
3. `OnLoad` fires if defined (M9 for full dispatch; M7 can call it directly at creation time as a bootstrap convenience).

## Render Protocol

On each Lua mutation (SetPoint, SetSize, Show, Hide, SetTexture, etc.), collect the updated frame tree and send it to the webview via the existing M2 message protocol. The webview re-renders the full tree. No per-mutation diffs.

The existing M2 renderer (`src/webview/`) handles layout and painting — no webview-side changes needed for M7 beyond ensuring the full-tree message format is compatible.

## Testing

- `CreateFrame("Frame", "MyFrame", UIParent)` returns a Lua object with methods
- `frame:SetPoint("CENTER")` — frame appears centered in the webview
- `frame:SetSize(200, 100)` — frame dimensions update
- `frame:Hide()` / `frame:Show()` — frame toggles visibility
- `frame:CreateTexture()` returns a Texture object; `texture:SetColorTexture(1,0,0,1)` renders a red rect
- `parentKey` wiring: `parent.Icon` is set correctly after child creation
- `Mixin` copies fields onto a target table

## Dependencies

**M2** (renderer + DOM; render protocol); **M5** (sandbox); **M6** (stubs; UIParent/WorldFrame registered there).

## Rough Effort

**M** — the largest step in the series. ~40–60 widget methods across several frame types, plus the proxy wiring, mixin system, and panel fork.
