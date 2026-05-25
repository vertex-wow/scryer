# WoW Cookbook Reference

`_reference/wow-cookbook` (symlink → `../../wow-cookbook/`) — a collection of simple, WoW-verified addon examples owned by this project. The cookbook is **WIP**; frustration with not being able to preview changes there is a primary motivation for building Scryer.

Cookbook addons live at: `_reference/wow-cookbook/docs/frames/Addons/<AddonName>__Vertex/`

---

## Addon Inventory

| Addon                          | Demonstrates                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------- |
| `ExampleFrameBare`             | Minimal frame; solid-color background texture; FontString                                         |
| `ExampleFrameTranslucent`      | Same as bare but `a="0.5"` on Color                                                               |
| `ExampleFrameTooltip`          | `NineSlicePanelTemplate` + `KeyValue layoutType="TooltipDefaultLayout"`                           |
| `ExampleFrameModalDialog`      | `toplevel`, `DIALOG` strata, anonymous border-chrome child frame                                  |
| `ExampleFrameTitleFrame`       | `inherits="DefaultPanelTemplate"`; Lua calls `:SetTitle()`                                        |
| `ExampleFrameIconPortrait`     | `PortraitFrameTemplate`; addon-bundled TGA texture (`vertex-icon.tga`)                            |
| `ExampleFrameModelPortrait`    | `PortraitFrameTemplate` with `:SetPortraitToUnit("player")`                                       |
| `ExampleFrameTitleModalDialog` | `DialogBorderTemplate` + `DialogHeaderTemplate` stacked                                           |
| `ExampleControlButton`         | Virtual templates, `ThreeSliceButtonTemplate`, inline atlas buttons, tabs, `relativeKey` chaining |
| `ExampleControlCloseButton`    | `DefaultPanelTemplate` + `UIPanelCloseButtonDefaultAnchors`                                       |
| `ExampleControlMoveableFrame`  | `movable="true"`, inline `OnDragStart`/`OnDragStop` scripts                                       |
| `ExampleControlResizableFrame` | `resizable`, `PanelResizeButtonTemplate`, `StartSizing`                                           |
| `ExampleControlBottomTabs`     | `PanelTabButtonTemplate`, tab panel show/hide, `relativeKey` chaining                             |
| `ExampleControlRightTabs`      | `LargeSideTabButtonTemplate` with icon atlases                                                    |
| `ExampleControlVertScrollBar`  | 13 scroll bar variants (modern EventFrame + deprecated Slider-based)                              |
| `ExampleControlSelectors`      | `WowStyle1DropdownTemplate`, `CheckButton`, radio buttons                                         |

---

## TOC Format

All cookbook TOCs use the multi-version interface field:

```
## Interface: 110205, 110207, 120000
## Title: ExampleFrameBare 2026 by Vertex /ev1
## Notes: Cookbook recipe — bare frame with slash command /ev1 toggle.
## Version: 1.0.0
## Category: Development Tools

ExampleFrameBare.xml
_harness.lua
```

Every addon includes a `_harness.lua` that registers a slash command (`/evN`) to toggle visibility and adds QoL conveniences (drag handle, close button) that don't belong in the addon itself.

---

## Key XML Patterns

### Border chrome pattern

Anonymous child frame with `useParentLevel` and `setAllPoints` — used by modal dialogs and title frames:

```xml
<Frame inherits="DialogBorderTemplate" useParentLevel="true" setAllPoints="true"/>
```

### Tab chaining with `relativeKey`

First tab anchors to `BOTTOMLEFT` of parent; each subsequent tab chains `LEFT` off the previous tab's `RIGHT`:

```xml
<Button name="$parentAlphaTab" parentKey="AlphaTab" ...>
  <Anchors><Anchor point="BOTTOMLEFT" x="20" y="-28"/></Anchors>
</Button>
<Button name="$parentBetaTab" parentKey="BetaTab" ...>
  <Anchors>
    <Anchor point="LEFT" relativeKey="$parent.AlphaTab" relativePoint="RIGHT" x="-15" y="0"/>
  </Anchors>
</Button>
```

### Virtual template font rule

`NormalFont`/`HighlightFont`/`DisabledFont` only apply when defined on a **virtual** template. Putting them on a concrete frame instance is silently ignored by WoW:

```xml
<!-- correct: fonts in a virtual -->
<Button name="MyButtonTemplate" inherits="ThreeSliceButtonTemplate" virtual="true">
  <NormalFont style="GameFontNormalSmall"/>
</Button>
<!-- wrong: fonts on a concrete instance have no effect -->
<Button inherits="MyButtonTemplate" text="Click me"/>
```

### Tab panel show/hide

Multiple panels share the same anchor slot; `SelectTab` shows one and hides the rest. All panels start `hidden="true"`:

```xml
<Frame parentKey="AlphaPanel" hidden="true">
  <Anchors>
    <Anchor point="TOPLEFT"/>
    <Anchor point="BOTTOMRIGHT"/>
  </Anchors>
  ...
</Frame>
```

### Inline button textures (atlas)

Common for bespoke icon buttons without a template:

```xml
<Button parentKey="ExpandButton">
  <Size x="24" y="24"/>
  <NormalTexture atlas="RedButton-Expand"/>
  <PushedTexture atlas="RedButton-Expand-Pressed"/>
  <HighlightTexture atlas="RedButton-Highlight" alphaMode="ADD"/>
</Button>
```

---

## Atlas Names Used (M3 Reference)

These are atlas names that appear in cookbook XML. Useful as test inputs when building the M3 atlas manifest:

| Atlas name                                                | Used in              |
| --------------------------------------------------------- | -------------------- |
| `RedButton-Expand` / `RedButton-Condense`                 | ExampleControlButton |
| `RedButton-Expand-Pressed` / `RedButton-Condense-Pressed` | ExampleControlButton |
| `RedButton-Highlight`                                     | ExampleControlButton |
| `common-button-collapseexpand-up/down`                    | ExampleControlButton |
| `common-dropdown-icon-back` / `common-dropdown-icon-next` | ExampleControlButton |
| `questlog-tab-icon-quest`                                 | ExampleControlButton |
| `UI-HUD-MicroMenu-ButtonBG-Up/Down`                       | ExampleControlButton |
| `chatframe-button-up/down/highlight`                      | ExampleControlButton |
| `bags-button-autosort-up/down`                            | ExampleControlButton |
| `ui-hud-minimap-zoom-in/out`                              | ExampleControlButton |
| `SpellIcon-256x256-SellJunk`                              | ExampleControlButton |
| `common-icon-undo`                                        | ExampleControlButton |
| `minimal-scrollbar-arrow-top/bottom`                      | ExampleControlButton |
| `auctionhouse-icon-favorite`                              | ExampleControlButton |
| `dashboard-panel-homestone-teleport-button`               | ExampleControlButton |

---

## Lua API Surface (M4 Reference)

These are the WoW API calls that appear across the cookbook. Highest-priority stub candidates for M4:

| API                                                     | Used in                     |
| ------------------------------------------------------- | --------------------------- |
| `PanelTemplates_SetNumTabs(frame, n)`                   | Every tabbed example        |
| `PanelTemplates_SetTab(frame, i)`                       | Every tabbed example        |
| `SlashCmdList["NAME"]` / `SLASH_NAME1`                  | Every harness               |
| `RegisterForDrag("LeftButton")`                         | Moveable/resizable frames   |
| `self:StartMoving()` / `self:StopMovingOrSizing()`      | Moveable frames             |
| `self:StartSizing("BOTTOMRIGHT")`                       | Resizable frames            |
| `self:SetResizeBounds(minW, minH)`                      | Resizable frames            |
| `self:SetTitle("text")`                                 | DefaultPanelTemplate frames |
| `self:SetPortraitToAsset("path")`                       | PortraitFrameTemplate       |
| `self:SetPortraitToUnit("player")`                      | PortraitFrameTemplate       |
| `ScrollUtil.InitScrollBoxWithScrollBar(box, bar, view)` | Modern scroll frames        |
| `CreateScrollBoxLinearView()`                           | Modern scroll frames        |
| `ScrollBoxConstants.UpdateImmediately`                  | Modern scroll frames        |
| `dropdown:SetupMenu(function(_, root) ... end)`         | WowStyle1DropdownTemplate   |
| `rootDescription:CreateRadio/Checkbox/Button(...)`      | Dropdown menus              |
| `self:Disable()` / `self:Enable()`                      | Button state control        |
| `self:SetChecked(bool)`                                 | CheckButton                 |
| `self:SetHitRectInsets(...)`                            | CheckButton label hit area  |

---

## File Structure

Each addon directory contains:

```
ExampleControlBottomTabs__Vertex/
├── ExampleControlBottomTabs__Vertex.toc
├── ExampleControlBottomTabs.xml
├── ExampleControlBottomTabs.lua      (if Lua needed)
└── _harness.lua                       (always present)
```

`ExampleFrameIconPortrait` additionally ships `vertex-icon.{png,svg,tga}` — a bundled TGA texture, confirming addon-local TGA resolution is needed in M3.
