# Rendering Features per Flavor

This document provides a comprehensive overview of the rendering and runtime features Scryer supports, allowing addon developers to understand which frame types, XML attributes, and rendering behaviors are implemented or stubbed.

## General Features

This table outlines general Scryer environment and tooling features, distinguishing between Static (XML) preview mode and Live (TOC) execution mode.

| Feature                      | Static (XML) | Live (TOC) | Description                                                          |
| :--------------------------- | :----------: | :--------: | :------------------------------------------------------------------- |
| **XML Parsing to IR**        |      ✅      |     ✅     | Parses WoW `.xml` into typed IR and resolves templates.              |
| **Lua Sandbox Execution**    |      ❌      |     ✅     | Executes `.lua` via wasmoon with a WoW 5.1 compatibility shim.       |
| **Interactive Event Bridge** |      ❌      |     ✅     | Dispatches `OnClick`, `OnEnter`, `OnLeave` etc. from Webview to Lua. |
| **TOC Load Sequence**        |      ❌      |     ✅     | Replicates `ADDON_LOADED` / `PLAYER_LOGIN` load phases.              |
| **WoW API Stubs**            |      ❌      |     ✅     | Auto-generated WoW API stubs and `CreateFrame` proxy.                |
| **Webview Pan & Zoom**       |      ✅      |     ✅     | Grab, pan, and zoom around the preview canvas.                       |
| **Pixel Ruler Overlay**      |      ✅      |     ✅     | Toggleable pixel ruler for precise UI measurements.                  |
| **Eyedropper**               |      ✅      |     ✅     | Integrated color picker tool in the preview toolbar.                 |

## Frame Type Support

World of Warcraft UI widget types and their support status across the three main Scryer flavors.

| Frame Type         | Retail | Classic | Classic Era | Status Notes                                                       |
| :----------------- | :----: | :-----: | :---------: | :----------------------------------------------------------------- |
| **`Frame`**        |   ✅   |   ✅    |     ✅      | Core layout, anchors, strata, and layering fully supported.        |
| **`Button`**       |   🟡   |   🟡    |     🟡      | Rendered. State textures supported. Interactive only in Live mode. |
| **`CheckButton`**  |   🟡   |   🟡    |     🟡      | Rendered. Checked state visually unimplemented.                    |
| **`StatusBar`**    |   🟡   |   🟡    |     🟡      | Parsed. Missing dynamic fill texture visual (see Known Gaps).      |
| **`Texture`**      |   ✅   |   ✅    |     ✅      | Fully supported (color, atlas, `TexCoords`, tiling, alpha modes).  |
| **`MaskTexture`**  |   🟡   |   🟡    |     🟡      | Parsed, but complex clip geometries might have visual gaps.        |
| **`FontString`**   |   ✅   |   ✅    |     ✅      | Webfont resolution, text bounds, justification, colors.            |
| **`Line`**         |   ✅   |   ✅    |     ✅      | Line widget layout correctly handled.                              |
| **`NineSlice`**    |   ✅   |   ✅    |     ✅      | Cross-layer layout and border fidelity supported.                  |
| **`ScrollFrame`**  |   ❌   |   ❌    |     ❌      | Not implemented.                                                   |
| **`Slider`**       |   ❌   |   ❌    |     ❌      | Not implemented.                                                   |
| **`EditBox`**      |   ❌   |   ❌    |     ❌      | Not implemented.                                                   |
| **`ColorSelect`**  |   ❌   |   ❌    |     ❌      | Not implemented.                                                   |
| **`Cooldown`**     |   ❌   |   ❌    |     ❌      | Not implemented.                                                   |
| **`Model`**        |   ❌   |   ❌    |     ❌      | Not implemented (Placeholder stretch goal).                        |
| **`MessageFrame`** |   ❌   |   ❌    |     ❌      | Not implemented.                                                   |
| **`Minimap`**      |   ❌   |   ❌    |     ❌      | Not implemented.                                                   |

_Legend: ✅ Rendered completely, 🟡 Partially rendered/Stubbed, ❌ Not implemented, N/A Doesn't exist._

## Attribute & Behavior Coverage

Detailed coverage of specific attributes and cross-cutting behaviors during rendering.

| Category             | Behaviors Supported                                                                                                                  | Silently Ignored                       |
| :------------------- | :----------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------- |
| **Layout & Anchors** | `setAllPoints`, `Anchor` (point, relativeTo, relativePoint, x, y), `relativeKey` resolution.                                         | Advanced resize constraints.           |
| **Z-Order**          | `FrameStrata`, `FrameLevel`, DrawLayer (`BACKGROUND`, `BORDER`, `ARTWORK`, `OVERLAY`, `HIGHLIGHT`), `useParentLevel`.                |                                        |
| **Textures**         | Atlas textures (`useAtlasSize`), `TexCoords` sprite-sheet slicing, tiling (`horizTile`, `vertTile`), `alphaMode` (BLEND, ADD, etc.). |                                        |
| **FontString**       | `font`, `fontSize`, `inheritsFont`, `justifyH`, `justifyV`, `color`.                                                                 | Text shadows or advanced text styling. |
| **Templates**        | Standard XML template inheritance. `virtual="true"`.                                                                                 |                                        |
| **Parenting**        | `parentKey`, `parentArray` runtime wiring.                                                                                           |                                        |

## Known Gaps

The following features parse without error but yield incomplete or placeholder visuals:

- **StatusBar Fill**: `StatusBar` frames parse and render bounds, but currently do not synthesize the fill texture proportional to value/min/max.
- **TGA Textures**: M3 logs a warning and shows a labeled placeholder for `.tga` files. A pure-JS TGA decoder is planned for a future update.
- **Live Lua coupling in Static Preview**: "Static (XML)" previews do not execute `.lua` files. As a result, XML templates defined in Lua or `FontString` text populated via `OnLoad` scripts will appear incomplete until run in "Live (TOC)" mode.

_(Note: Please update this document alongside any future rendering work that adds or changes feature coverage.)_
