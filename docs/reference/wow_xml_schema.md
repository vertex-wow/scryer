# Reference — WoW XML Schema & Format

_Derived from inspecting `_reference/wow-ui-source/`, `_live/wow-ui-source/`, and `_live/Addons/`. Read-only reference — do not edit source directories._

## WoW UI Source — Two Copies

There are two copies of the WoW UI source available:

| Path                        | Nature                                                                                                                                            | When to use                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `_reference/wow-ui-source/` | Git-tracked snapshot (GitHub upload repo). Self-contained — no cache required. Version: `12.0.1.66709`.                                           | Stable baseline; use for schema diffing and when the live cache is absent.      |
| `_live/wow-ui-source/`      | Symlink → Scryer extension's live-extracted cache (`~/.vscode-server/.../retail/source/interface/`). Always reflects the current installed patch. | Prefer for any work that needs to match the user's actual running game version. |

The `_live` copy is authoritative for current patch accuracy; the `_reference` copy is the fallback when the cache has not been populated.

## Schema Location and Version

- **Authoritative XSD:** `_reference/wow-ui-source/Interface/AddOns/Blizzard_SharedXML/UI.xsd` (1628 lines) — same path exists under `_live/wow-ui-source/` for the current-patch version
- **WoW UI source version (reference snapshot):** `12.0.1.66709` — The War Within / Retail (from `_reference/wow-ui-source/version.txt`)
- **XML namespace:** `http://www.blizzard.com/wow/ui/`
- **Common `xsi:schemaLocation` in addons:** points to `..\FrameXML\UI.xsd` or `..\Blizzard_SharedXML\UI.xsd` (both are equivalent references to the same schema conceptually; the FrameXML one is used in older/Blizzard files, Blizzard_SharedXML in newer)

## Enumerations from XSD

### FRAMEPOINT (anchor attachment points)

```
TOPLEFT  TOPRIGHT  BOTTOMLEFT  BOTTOMRIGHT
TOP  BOTTOM  LEFT  RIGHT  CENTER
```

### FRAMESTRATA (z-depth bands, low → high)

```
PARENT  BACKGROUND  LOW  MEDIUM  HIGH  DIALOG
FULLSCREEN  FULLSCREEN_DIALOG  TOOLTIP  BLIZZARD
```

### DRAWLAYER (layer order within a frame, back → front)

```
BACKGROUND  BORDER  ARTWORK  OVERLAY  HIGHLIGHT
```

Each `<Layer>` also has `textureSubLevel` attribute (integer, −8..7).

### ALPHAMODE (texture blend mode)

```
DISABLE  BLEND  ALPHAKEY  ADD  MOD
```

Default is `BLEND`. `ADD` is common for glow effects; no direct CSS equivalent (approximated with `screen` mix-blend-mode). `MOD` = multiply.

### Other enumerations

| Enum                     | Values                                                                    |
| ------------------------ | ------------------------------------------------------------------------- |
| OUTLINETYPE              | `NONE, NORMAL, THICK`                                                     |
| JUSTIFYVTYPE             | `TOP, MIDDLE, BOTTOM`                                                     |
| JUSTIFYHTYPE             | `LEFT, CENTER, RIGHT`                                                     |
| INSERTMODE               | `TOP, BOTTOM`                                                             |
| ORIENTATION              | `HORIZONTAL, VERTICAL`                                                    |
| WRAPMODE                 | `CLAMP, REPEAT, CLAMPTOBLACK, CLAMPTOBLACKADDITIVE, CLAMPTOWHITE, MIRROR` |
| KEYVALUETYPE             | `nil, boolean, number, string, global`                                    |
| ATTRIBUTETYPE            | `nil, boolean, number, string`                                            |
| SCRIPTINHERITTYPE        | `prepend, append, none`                                                   |
| SCRIPTINTRINSICORDERTYPE | `precall, postcall, none`                                                 |
| FONTALPHABET             | `roman, korean, simplifiedchinese, traditionalchinese, russian`           |
| UITextureSliceMode       | `Stretched, Tiled`                                                        |
| StatusBarFillStyle       | `Standard, StandardNoRangeFill, Center, Reverse`                          |

## Key Elements and Their Attributes

### `<Ui>` (root)

Contains `Script`, `Include`, and any frame/render elements at the top level.

### `<Script>` / `<Include>`

- `<Script file="path\to\File.lua"/>` — external Lua file reference (load in order)
- `<Script>inline lua code</Script>` — inline (rare; used for addon init)
- `<Include file="path\to\Other.xml"/>` — include another XML file (templates must be registered before use)

### Frame/LayoutFrame (`FrameAttributes` + `LayoutFrameAttributes`)

**Shared layout attrs:**

- `name` — global name registered in `_G`; `$parent` substring is replaced with parent's name
- `parentKey` — sets `parent[parentKey] = self` after creation; dotted path dot-notation (e.g. `parentKey="Icon"`)
- `parentArray` — appends self to `parent[parentArray]` table
- `inherits` — comma-separated template names to merge (applied left-to-right before own attrs)
- `mixin` / `secureMixin` — Lua mixin table name(s) to copy onto the frame
- `virtual="true"` — defines a template, never instantiated directly
- `setAllPoints="true"` — equivalent to `SetAllPoints(parent)`
- `hidden="true"` — initially hidden
- `alpha`, `scale` — initial alpha (0..1) and scale
- `enableMouse`, `enableMouseClicks`, `enableMouseMotion` — input capture
- `registerForDrag` — e.g. `"LeftButton"`

**Frame-specific attrs:**

- `parent` — explicit parent frame name (defaults to last opened frame or UIParent)
- `frameStrata` (FRAMESTRATA), `frameLevel` (integer)
- `toplevel="true"` — appears above its nominal strata siblings
- `movable`, `resizable`, `clampedToScreen`
- `enableKeyboard`, `id` (integer tag)
- `intrinsic="true"` — engine-level intrinsic frame (no Lua equivalent; rare)
- `useParentLevel` — inherit parent's frame level; Scryer approximates by rendering the child at BORDER z-range so parent ARTWORK content remains visible above it
- `clipChildren` — clip child rendering to this frame's bounds

**Child elements:**
`Size`, `Anchors`, `Scripts`, `KeyValues`, `Layers`, `Frames`, `Attributes`, `HitRectInsets`, `ResizeBounds`, `Animations`

### `<Button>` (extends Frame)

Additional attrs: `text` (initial button text), `registerForClicks` (e.g. `"LeftButtonUp,RightButtonUp"`)
Additional children:

- `NormalTexture`, `PushedTexture`, `DisabledTexture`, `HighlightTexture` — texture sub-elements
- `ButtonText` — FontString for button label
- `NormalFont`, `HighlightFont`, `DisabledFont` — font style references (`style="FontName"`)
- `PushedTextOffset` — Dimension for text offset when pressed

### `<CheckButton>` (extends Button)

`checked="true/false"` attr; `CheckedTexture`, `DisabledCheckedTexture` children.

### `<StatusBar>` (extends Frame)

`minValue`, `maxValue`, `defaultValue` (numbers), `orientation` (ORIENTATION), `reverseFill`, `fillStyle` (StatusBarFillStyle), `drawLayer`, `rotatesTexture`.

### `<Texture>` (`TextureAttributes`)

- `file="Interface\path\to\texture"` — BLP/TGA path (see Asset section)
- `atlas="atlas-region-name"` — named atlas region
- `useAtlasSize="true"` — size frame from atlas region dimensions
- `alphaMode` (ALPHAMODE, default BLEND)
- `alpha`, `scale`, `rotation` (degrees)
- `hWrapMode`, `vWrapMode` (WRAPMODE)
- `desaturated="true"` — greyscale
- `horizTile`, `vertTile` — tile instead of stretch
- `snapToPixelGrid="true"`

Child elements: `TexCoords` (left/right/top/bottom 0..1, or 8-corner `Rect`), `TextureSliceMargins`, `TextureSliceMode`, `Color` (r/g/b/a), `Gradient`.

### `<FontString>` (`FontStringAttributes`)

- `text` — initial text content
- `font` — font file path
- `inherits` — parent font object name (e.g. `"GameFontNormal"`, `"Game16Font"`)
- `justifyH` (JUSTIFYHTYPE), `justifyV` (JUSTIFYVTYPE)
- `wordwrap`, `maxLines`, `outline` (OUTLINETYPE), `spacing`, `indented`

Children: `FontHeight`, `Color`, `Shadow`.

### `<Anchor>` (inside `<Anchors>`)

- `point` (FRAMEPOINT, **required**)
- `relativeKey` — dotted key path from the current frame (e.g. `"$parent"`, `"$parent.Shadow"`)
- `relativeTo` — global frame name (alternative to `relativeKey`)
- `relativePoint` (FRAMEPOINT, defaults to `point`)
- `x`, `y` — pixel offset. **WoW y is positive-up**; CSS y is positive-down → negate y when converting.
- Optional child `<Offset>` (Dimension, same as `x`/`y` attrs)

### `<Size>` / `<Dimension>`

`x` and `y` attrs, or nested `<AbsDimension x="..." y="..."/>`.

### `<Layer>` (inside `<Layers>`)

`level` (DRAWLAYER, required), `textureSubLevel` (integer −8..7).
Contains `Texture`, `MaskTexture`, `FontString`, `Line` render objects.

### `<KeyValue>` (inside `<KeyValues>`)

`key`, `value`, `type` (KEYVALUETYPE). Sets `frame[key] = value` (typed) on the Lua frame object. Used to pass constructor arguments without a separate Lua call.

### `<Scripts>` and script event elements

Child elements of `Scripts` block are named by event (e.g. `<OnLoad>`, `<OnClick>`). Each `ScriptType` has:

- Inline body text: compiled as `function(self, ...) <body> end`
- `function="GlobalFunctionName"` — resolves from `_G`
- `method="MixinMethodName"` — resolves from the frame's mixin table; emitted as `HookScript` delegation so the mixin method fires at frame creation
- `inherit="prepend|append|none"` — controls inheritance merge with base template scripts
- `intrinsicOrder="precall|postcall|none"` — for intrinsic frames

## Template Inheritance

- `virtual="true"` → template, keyed by `name` in the template registry. Never rendered.
- `inherits="A, B"` → merge templates A then B, then own element's attrs override:
  - **Scalar attrs:** right side overrides.
  - **Child collections** (Layers, Frames, Scripts): appended (plus-equals), unless keyed by `parentKey`.
  - **Scripts:** honor `inherit="prepend|append|none"` on each script element.
- Templates may be defined in a different file; must be registered (via TOC/Include load order) before the `inherits` reference.
- Common Blizzard templates (e.g. `DefaultPanelTemplate`, `UIPanelCloseButtonDefaultAnchors`, `BigRedThreeSliceButtonTemplate`, `PanelTabButtonTemplate`) come from `_reference/wow-ui-source/Interface/AddOns/Blizzard_SharedXML/` and `Blizzard_ActionBar/` etc. These must be loaded from reference source, not the addon.

## Name/Key Substitution Rules

- **`$parent`** in a frame `name` → replaced with the parent frame's resolved name.
  - `name="$parentCloseButton"` inside frame `"MyAddonFrame"` → `"MyAddonFrameCloseButton"`.
- **`parentKey="Icon"`** → exposes child as `parentFrame.Icon` in Lua. Chains: `parentKey="Header.Title"` would set `parent.Header.Title` (parser must handle dotted keys).
- **`parentArray="Items"`** → appends to `parent.Items` table (creates it if absent).
- **`relativeKey="$parent"`** in an Anchor → relative to the direct parent frame.
- **`relativeKey="$parent.Shadow"`** → relative to the `Shadow` parentKey child of the parent.

## Asset Path Format

### File textures

`file="Interface\Buttons\UI-Quickslot-Depress"` — virtual path, backslash-separated, extension usually omitted.

WoW uses **two image formats** in texture paths:

- **BLP** — primary proprietary format for all Blizzard Interface textures. Requires a BLP decoder (see `003_asset_pipeline.md`).
- **TGA** (Targa) — used by some older Blizzard textures and commonly by addon-bundled art. Much simpler to decode: uncompressed or RLE-compressed RGBA. Many JS libraries handle it (e.g. `tga-js`).

Resolution: if no extension, try `.blp` first then `.tga`. If `.blp` fails to decode, also try `.tga` at the same path.
Addon-local textures may be relative: `file="Textures\MyIcon"` → relative to addon dir.

### Atlas textures

`atlas="atlas-region-name"` + `useAtlasSize="true"` — named region from a sprite sheet.

- Requires an atlas manifest: `{ atlasName → { sheetFile, x, y, width, height } }`.
- Atlas manifests are version-specific (Retail atlas ≠ Classic atlas).

## Mixin Attribute

`mixin="FooMixin"` and `secureMixin="FooMixin"`:

- After frame creation, copy all fields from `_G.FooMixin` (or the mixin table) onto the frame.
- Then run any `OnLoad` script.
- Multiple mixins comma-separated (applied left-to-right).
- Helpers: `Mixin(t, ...)`, `CreateFromMixins(...)`, `CreateAndInitFromMixin(mixin, ...)` (calls `:Init`).

## Script Event Types

Seen in `_live/Addons/` (bold = high frequency):

**Frame lifecycle:** **OnLoad**, **OnShow**, **OnHide**, OnSizeChanged, OnAttributeChanged, OnEnable, OnDisable

**Input:** **OnClick**, **OnEnter**, **OnLeave**, OnMouseDown, OnMouseUp, OnMouseWheel, OnDragStart, OnDragStop, OnReceiveDrag, PreClick, PostClick, OnDoubleClick

**Keyboard:** OnKeyDown, OnKeyUp, OnEnterPressed, OnEscapePressed, OnTabPressed, OnEditFocusGained, OnEditFocusLost, OnTextChanged, OnCursorChanged, OnInputLanguageChanged

**Scroll:** OnVerticalScroll, OnHorizontalScroll, OnScrollRangeChanged

**Game logic:** **OnUpdate**, **OnEvent**, OnValueChanged, OnMinMaxChanged

**Tooltip:** OnTooltipSetItem, OnTooltipSetSpell, OnTooltipSetUnit, OnTooltipSetQuest, OnTooltipSetAchievement, OnTooltipCleared

**Hyperlink:** OnHyperlinkEnter, OnHyperlinkLeave, OnHyperlinkClick

**Animation:** OnAnimStarted, OnAnimFinished, OnFinished, OnLoop, OnPlay, OnPause, OnResume, OnStop, OnCooldownDone

_~70 total event types in the XSD._

## Observed Patterns in `_live/Addons/`

(Observed while exploring `_live/Addons/` — 152 addons, 1002 XML files, 6934 Lua files, 356 TOC files as of project snapshot.)

- **LibStub** is used by nearly all library-based addons as the lib registry mechanism.
- **`inherits="DefaultPanelTemplate"`** — the standard WoW panel chrome; a very common base.
- **`mixin="...Mixin"`** naming convention: every mixin table ends in `Mixin`.
- **`$parent` name substitution** is extremely common for child buttons, close buttons, etc.
- **Multiple Interface versions in TOC** (`## Interface: 120000, 50501, 11507`) is the current best practice for cross-flavor addons.
- Inline `OnLoad` scripts that call `LibStub(...)` to bind controllers (MVC pattern via LibMVC-1.0).
- **`Include` for templates before `Script` for logic** — common pattern in well-structured addons.
