# Milestone 1 — WoW XML Parser

**Status: Complete** (2026-05-24)
Files: `src/parser/ir.ts`, `src/parser/toc.ts`, `src/parser/xml.ts`, `src/parser/inherit.ts`, `src/parser/index.ts`
Tests: 67 passing (`test/parser/toc.test.ts`, `test/parser/xml.test.ts`, `test/parser/inherit.test.ts`)

---

## Goal

Parse WoW `.xml` files into a typed AST/IR with template inheritance and cross-file references resolved. No rendering. Deliverable: `src/parser/` internal module with unit tests against `_live/Addons/`.

## Approach

1. Tokenize XML with **fast-xml-parser** into a raw object tree (preserving attribute case and element order — order matters for layers and load sequence).
2. Map raw nodes to typed IR nodes per the XSD element set (`_reference/wow-ui-source/Interface/AddOns/Blizzard_SharedXML/UI.xsd`).
3. Build a template registry from all `virtual="true"` frames (collected across files in TOC/Include order).
4. Resolve `inherits="..."` by deep-merging template IR into concrete frames (child appends, attribute override).
5. Resolve name/key substitutions: `$parent`, `parentKey`, `parentArray`, `relativeKey`, `relativeTo`.

## Elements to Parse

Grounded in `UI.xsd` (see `ref_wow_xml_schema.md`):

- **Root:** `Ui`
- **Directives:** `Script` (`file=` or inline body), `Include` (`file=`)
- **Frame family** (substitutionGroup FrameRef): `Frame`, `Button`, `CheckButton`, `StatusBar`, `UnitPositionFrame`, plus other intrinsics from source
- **Render objects** (LayoutFrameRef): `Texture`, `MaskTexture`, `FontString`, `Line`
- **Layout:** `Size` (x/y attrs or `AbsDimension`), `Anchors`/`Anchor` (point, relativeKey, relativeTo, relativePoint, x, y), `Scripts`/script events, `KeyValues`/`KeyValue` (key, value, type)
- **Frame fields:** `Layers`/`Layer` (level DRAWLAYER, textureSubLevel), `Frames` (child frames), `Attributes`, `HitRectInsets`, `ResizeBounds`
- **Button fields:** `NormalTexture`, `PushedTexture`, `DisabledTexture`, `HighlightTexture`, `ButtonText`, `NormalFont`/`HighlightFont`/`DisabledFont` (style refs)
- **Texture sub-fields:** `TexCoords`, `TextureSliceMargins`, `TextureSliceMode`, `Color`, `Gradient`

## Virtual Frame Resolution / Inheritance

- A `virtual="true"` frame defines a template keyed by `name`; it is never rendered directly.
- `inherits` may be comma-separated: merge left-to-right, concrete node attributes override last.
- **Merge rules:** scalar attrs override; child collections (Layers, Frames, Scripts) append unless keyed by `parentKey`; Scripts honor `inherit="prepend|append|none"` per the XSD.
- `$parent` in a frame `name` expands to the parent frame's resolved name (e.g. `$parentCloseButton` → `MyFrameCloseButton`).

## TOC File Parser (co-deliverable)

The `.toc` parser is a co-deliverable of M1 because the TOC defines the file load order needed to correctly order XML template registration. Lives in `src/parser/toc.ts`.

**TOC format:**

```
## Interface: 120000, 50501, 11507
## Title: MyAddon
## Version: 1.0.0
## SavedVariables: MyAddonDB

Libs\LibStub\LibStub.lua
Core\Init.lua
MyAddon.xml
```

Rules: `##` lines are metadata directives; non-empty non-`#` lines are ordered file paths (`.lua` or `.xml`); backslash-normalize to forward slash. `## Interface:` is comma-separated multi-version integers. See `004_lua_runtime.md` for the full `TocFile` TypeScript interface.

## Cross-File References

- **TOC** defines top-level load order; `Include` pulls another XML (templates must be registered before use).
- `Script file=` registers a Lua file path for M4 (parser records the path only, does not execute).
- Build a **dependency graph** (file → Set\<includes | scripts\>) — reused by hot reload (M6).

## IR/AST Design (TypeScript)

The implemented IR matches the design below. Additions vs. the original plan are marked.

```ts
type DrawLayer = "BACKGROUND" | "BORDER" | "ARTWORK" | "OVERLAY" | "HIGHLIGHT";
type FramePoint =
  | "TOPLEFT"
  | "TOPRIGHT"
  | "BOTTOMLEFT"
  | "BOTTOMRIGHT"
  | "TOP"
  | "BOTTOM"
  | "LEFT"
  | "RIGHT"
  | "CENTER";
type FrameStrata =
  | "PARENT"
  | "BACKGROUND"
  | "LOW"
  | "MEDIUM"
  | "HIGH"
  | "DIALOG"
  | "FULLSCREEN"
  | "FULLSCREEN_DIALOG"
  | "TOOLTIP"
  | "BLIZZARD";
type AlphaMode = "DISABLE" | "BLEND" | "ALPHAKEY" | "ADD" | "MOD";

interface Anchor {
  point: FramePoint;
  relativeTo?: string;
  relativeKey?: string;
  relativePoint?: FramePoint;
  x?: number;
  y?: number;
}

interface KeyValue {
  key: string;
  value: string;
  type: "nil" | "boolean" | "number" | "string" | "global";
}

interface ScriptIR {
  event: string;
  inline?: string;
  method?: string;
  function?: string;
  inherit?: "prepend" | "append" | "none";
}

interface Color {
  r: number;
  g: number;
  b: number;
  a?: number;
}

interface LayoutFrameBase {
  kind:
    | "Frame"
    | "Button"
    | "CheckButton"
    | "StatusBar"
    | "Texture"
    | "MaskTexture"
    | "FontString"
    | "Line";
  name?: string;
  parentKey?: string;
  parentArray?: string;
  inherits: string[];
  mixin: string[];
  virtual: boolean;
  size?: { x?: number; y?: number };
  anchors: Anchor[];
  setAllPoints?: boolean;
  hidden?: boolean;
  alpha?: number;
  scale?: number;
  keyValues: KeyValue[];
  sourceFile: string;
  sourceLine?: number;
}

interface FrameIR extends LayoutFrameBase {
  kind: "Frame" | "Button" | "CheckButton" | "StatusBar";
  parent?: string;
  frameStrata?: FrameStrata;
  frameLevel?: number;
  toplevel?: boolean;
  movable?: boolean;
  resizable?: boolean;
  enableMouse?: boolean;
  text?: string; // Button text="..." attribute
  layers: { level: DrawLayer; subLevel: number; objects: RenderObjectIR[] }[];
  children: FrameIR[];
  scripts: ScriptIR[];
  templateChain: string[]; // ordered list of inherited template names (debug)
  // Button state textures (added vs original plan)
  normalTexture?: TextureIR;
  pushedTexture?: TextureIR;
  disabledTexture?: TextureIR;
  highlightTexture?: TextureIR;
  buttonText?: string; // ButtonText child element
  normalFont?: string; // NormalFont style="..." ref
  highlightFont?: string;
  disabledFont?: string;
}

type RenderObjectIR = TextureIR | FontStringIR;

interface TextureIR extends LayoutFrameBase {
  kind: "Texture" | "MaskTexture";
  file?: string;
  atlas?: string;
  useAtlasSize?: boolean;
  alphaMode?: AlphaMode;
  texCoords?: { left: number; right: number; top: number; bottom: number };
  color?: Color;
}

interface FontStringIR extends LayoutFrameBase {
  kind: "FontString";
  text?: string;
  inheritsFont?: string; // inherits="..." on FontString = font style, not template
  justifyH?: "LEFT" | "CENTER" | "RIGHT";
  justifyV?: "TOP" | "MIDDLE" | "BOTTOM";
  color?: Color;
}

interface UiDocument {
  source: string;
  frames: FrameIR[];
  templates: Map<string, FrameIR>;
  scriptFiles: string[];
  includes: string[];
}
```

## Key Technical Decisions

### Parser library

**Decision: fast-xml-parser** with `preserveOrder: true`, `ignoreAttributes: false`, `attributeNamePrefix: ""`, `parseAttributeValue: false` (manual coercion).

`preserveOrder: true` is required because child element order matters for layer render order and child frame stacking. Without it, same-tag siblings (multiple `<Button>` in `<Frames>`) get grouped into an array and lose their relative ordering with other element types.

### Template merge algorithm

The multi-inheritance merge is a two-phase operation:

1. **Build template base** — apply templates left-to-right; each later template is the "concrete" that overrides the previous base for scalar conflicts. Result: `mergedTemplate` where the last-named template's scalars win.
2. **Apply concrete frame** — apply the original concrete frame (with only its explicitly-set fields) on top of `mergedTemplate`. Concrete always wins.

Doing this in a single pass (applying concrete on each iteration) was a bug: after the first merge, "inherited" scalar values would appear to be explicitly set by the concrete and incorrectly override later templates.

### Template merge timing

Resolve at parse time into fully-expanded IR (simpler renderer and runtime). Keep `templateChain: string[]` on each FrameIR for debugging/diffing.

### FontString inherits semantics

`inherits="..."` on a `<FontString>` refers to a **font style**, not a frame template. It maps to `FontStringIR.inheritsFont` and is NOT entered into the template inheritance system. `FontStringIR.inherits` stays `[]`.

### $parent expansion

Performed post-resolution in a separate `resolveFrameName` pass. Regex is case-insensitive to match WoW's behavior (`$parent`, `$Parent`, `$PARENT` all work). Expansion is applied recursively: a nested child's `$parent` expands to its immediate parent's resolved name.

## What Was Deferred

- **`Line` render object** — tag is recognised and silently skipped. Rarely appears in practice; add `LineIR` interface and parsing in M2 if needed.
- **Dependency graph** (file → Set\<includes | scripts\>) — collected per-doc (`scriptFiles`, `includes` arrays on `UiDocument`) but no explicit cross-file graph built. Sufficient for M2; M6 (hot reload) will need the full graph.
- **`parentKey`/`parentArray` resolution** — recorded in IR but not wired into a frame object model. M4 uses them to populate `self.parentKey` on Lua frame objects.
- **Blizzard template registry** — unknown templates (e.g. `DefaultPanelTemplate`) emit a `console.warn` and are skipped. Lazy loading from `_reference/wow-ui-source` is an M2 task.
- **`TextureSliceMargins`/`TextureSliceMode`/`Gradient`** — parsed but attrs not mapped; no IR fields yet. M3 asset work will add them when needed.

## Foreseen Hurdles (status)

- ✅ Blizzard templates missing from addon: warning + skip implemented
- ✅ Comma-separated multi-inheritance: handled
- ✅ `$parent` resolution: post-resolve pass, case-insensitive
- ✅ Inline scripts as opaque strings: stored as `ScriptIR.inline`
- ✅ `parentKey`/`parentArray` recorded in IR
- ⬜ `intrinsic` frames (engine-level): not yet encountered in fixtures; treat as unknown frame type → "Frame" kind

## Test Strategy (as built)

- Assertion-based tests against real `.xml` and `.toc` files from `_live/Addons/` (no snapshots — brittle and require fixture maintenance).
- `Button.xml`: single virtual template, script directives, layer textures, button state textures.
- `ExampleControlButton.xml`: 4 virtuals, 1 concrete, multi-level nesting, `relativeKey` anchors, KeyValues, method/inline scripts.
- Inline XML strings: Include directives, Color sub-elements, multiple Anchors, missing `<Ui>` error.
- Inheritance: single, multi-inheritance ordering, script append/prepend/none, KeyValue key merge, unknown template warning, `$parent` expansion, cross-document.

## Dependencies

None — this is the foundation milestone.
