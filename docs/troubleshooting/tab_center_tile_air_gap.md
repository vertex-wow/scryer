# Tab center tile air gap (PanelTabButtonTemplate)

**Symptom:** The middle section of a `PanelTabButtonTemplate` tab button renders with a
visible air gap — the center tile texture (MiddleActive / Middle) is invisible even though
the left and right cap textures appear correctly.

**Affected template:** `PanelTabButtonTemplate` (and any template using a horizTile center
texture anchored between two `useAtlasSize` cap textures via `$parent.LeftCap` /
`$parent.RightCap` style relativeKeys).

---

## Root cause 1 — `GetWidth()` / `GetHeight()` returned 0 for atlas textures

`PanelTemplates_TabResize` calls `tab.Left:GetWidth() + tab.Right:GetWidth()` to compute
`sideWidths`, which determines the minimum tab width. If `GetWidth()` returned 0, `sideWidths`
was 0, and the tab was sized to `TAB_SIDES_PADDING` (20 px) — far narrower than the cap
textures. The caps overflowed, leaving the center tile with a large negative computed width
(invisible gap).

**Fix:** Wire `TextureMT:GetWidth()` / `TextureMT:GetHeight()` to return `tex.size.x` /
`tex.size.y`. Also store the atlas logical pixel size on `tex.size` when
`SetAtlas(name, true)` is called (useAtlasSize=true), using the atlas manifest lookup in
`__scryer_tex_set_atlas` in `createframe.ts`.

---

## Root cause 2 — `__scryer_tex_set_parent_key` nil'd before generated code ran (anchor resolution)

This was the actual cause of the layout failure after fixing `GetWidth()`.

`frame-class.lua` captures all `__scryer_*` bridges as upvalues then nil's the globals at
the end of the file (standard cleanup pattern). But `__scryer_tex_set_parent_key` was
different: it was never exposed as an upvalue-backed method, so it was _only_ accessible as
a global. Generated XML Lua code called it via a defensive guard:

```lua
if __scryer_tex_set_parent_key then
    __scryer_tex_set_parent_key(tex.__id, "LeftActive")
end
```

After `frame-class.lua` ran, the global was nil. The guard always failed. `tex.parentKey`
was never set on the TextureNode, so `textureNodeToIR` serialized it as `undefined`.

`layoutAll()` calls `collectNames()` on each frame's layer objects. With no `parentKey`,
textures were only registered by their synthetic name (`$tex:27`). When the layout solver
tried to resolve MiddleActive's anchor target `"$parent.LeftActive"` →
`expandRelativeKey("$parent.LeftActive", "")` → `"LeftActive"` → `registry.get("leftactive")`
— the key was missing. `resolveTarget` fell back to `viewportRect`. Both of MiddleActive's
anchors resolved to opposite corners of the viewport, producing a large negative width.

**Diagnosis path:** The tell was `styleLeft = "74px"` with `styleWidth = ""` (browser
rejected `"-73px"` as invalid CSS). The computed width was `(viewportRect.TOPRIGHT.x −
viewportRect.TOPLEFT.x) / (1 − 0) = −tabWidth`. Correct math; wrong anchor targets.

**Fix:** Capture `__scryer_tex_set_parent_key` as a local upvalue in `frame-class.lua` and
expose it via `TextureMT:__SetParentKey(key)`. Change the generated call in
`xml-importer.ts` and `createframe.ts` from the guarded global to the method:

```lua
-- Before (always skipped — global is nil by runtime):
if __scryer_tex_set_parent_key then __scryer_tex_set_parent_key(tex.__id, key) end

-- After (method call via captured upvalue — always available):
tex:__SetParentKey(key)
```

---

## Invariants guarded by tests

`test/toc-casc/bottom_tabs.spec.ts` (`BottomTabsAddon`):

| Invariant                                 | Why                                                                                                                                       |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| AlphaTab width ≥ MIN_TAB_WIDTH            | `GetWidth()` must return atlas size so `PanelTemplates_TabResize` computes correct `sideWidths`                                           |
| AlphaTab BACKGROUND center tile width > 0 | `parentKey` must reach the registry so `$parent.LeftActive` / `$parent.RightActive` anchors resolve to the cap textures, not the viewport |
