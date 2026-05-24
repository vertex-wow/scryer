# Milestone 1 — WoW XML Parser

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

```ts
type DrawLayer = "BACKGROUND"|"BORDER"|"ARTWORK"|"OVERLAY"|"HIGHLIGHT";
type FramePoint = "TOPLEFT"|"TOPRIGHT"|"BOTTOMLEFT"|"BOTTOMRIGHT"|"TOP"|"BOTTOM"|"LEFT"|"RIGHT"|"CENTER";
type FrameStrata = "PARENT"|"BACKGROUND"|"LOW"|"MEDIUM"|"HIGH"|"DIALOG"|"FULLSCREEN"|"FULLSCREEN_DIALOG"|"TOOLTIP"|"BLIZZARD";
type AlphaMode = "DISABLE"|"BLEND"|"ALPHAKEY"|"ADD"|"MOD";

interface Anchor {
  point: FramePoint;
  relativeTo?: string;      // named frame
  relativeKey?: string;     // dotted $parent.child path
  relativePoint?: FramePoint;
  x?: number; y?: number;
}

interface KeyValue { key: string; value: string; type: "nil"|"boolean"|"number"|"string"|"global"; }
interface ScriptIR { event: string; inline?: string; method?: string; function?: string; inherit?: "prepend"|"append"|"none"; }
interface Color { r: number; g: number; b: number; a?: number; }

interface LayoutFrameBase {
  kind: "Frame"|"Button"|"CheckButton"|"StatusBar"|"Texture"|"FontString"|"MaskTexture"|"Line";
  name?: string; parentKey?: string; parentArray?: string;
  inherits: string[]; mixin: string[]; virtual: boolean;
  size?: { x?: number; y?: number };
  anchors: Anchor[]; setAllPoints?: boolean;
  hidden?: boolean; alpha?: number; scale?: number;
  keyValues: KeyValue[];
  sourceFile: string; sourceLine?: number;
}

interface FrameIR extends LayoutFrameBase {
  kind: "Frame"|"Button"|"CheckButton"|"StatusBar";
  parent?: string;
  frameStrata?: FrameStrata; frameLevel?: number;
  toplevel?: boolean; movable?: boolean; resizable?: boolean;
  enableMouse?: boolean;
  layers: { level: DrawLayer; subLevel: number; objects: RenderObjectIR[] }[];
  children: FrameIR[];
  scripts: ScriptIR[];
}

type RenderObjectIR = TextureIR | FontStringIR;

interface TextureIR extends LayoutFrameBase {
  kind: "Texture"|"MaskTexture";
  file?: string; atlas?: string; useAtlasSize?: boolean;
  alphaMode?: AlphaMode;
  texCoords?: { left: number; right: number; top: number; bottom: number };
  color?: Color;
}

interface FontStringIR extends LayoutFrameBase {
  kind: "FontString";
  text?: string; inheritsFont?: string;
  justifyH?: "LEFT"|"CENTER"|"RIGHT";
  justifyV?: "TOP"|"MIDDLE"|"BOTTOM";
  color?: Color;
}

interface UiDocument {
  source: string;                     // file path
  frames: FrameIR[];                  // concrete top-level frames
  templates: Map<string, FrameIR>;    // virtual frames by name
  scriptFiles: string[];              // ordered Lua file paths
  includes: string[];                 // ordered included XML paths
}
```

## Key Technical Decisions

### Parser library

| Option | Pros | Cons |
|--------|------|------|
| **fast-xml-parser** *(recommended)* | Fast; pure JS; no native deps; configurable; preserves order | Manual mapping from raw object |
| xml2js | Well-known | Callback API; less control over ordering; heavier |
| DOMParser | Nice API; standard | Browser-only; needs jsdom in Node (adds native dep) |

**Decision: fast-xml-parser** with `preserveOrder: true`, `ignoreAttributes: false`, `attributeNamePrefix: ""`.

### Template merge timing

Resolve at parse time into fully-expanded IR (simpler renderer and runtime). Keep `templateChain: string[]` on each FrameIR for debugging/diffing.

## Foreseen Hurdles

- `inherits` may reference Blizzard templates (`DefaultPanelTemplate`, `UIPanelCloseButtonDefaultAnchors`, `BigRedThreeSliceButtonTemplate`) that are not in the addon. Need a Blizzard template registry sourced from `_reference/wow-ui-source` — large, so load lazily; fall back to a stub template + a logged warning.
- Comma-separated multi-inheritance and `intrinsic` frames (engine-level templates that don't exist as XML).
- `$parent` resolution requires two passes: build tree, then resolve names (forward references possible).
- Inline scripts contain raw Lua — store as opaque strings for M4; do not parse or execute.
- `parentKey` / `parentArray` need to be recorded and will be wired up by M4's frame object model.

## Test Strategy

- Unit tests against real `.xml` files from `_live/Addons/` (1002 files available as of project snapshot).
- Start with `AddonFactory/Templates/Button.xml` (small, realistic) and `ExampleControlButton__Vertex/ExampleControlButton.xml` (covers most elements).
- Snapshot tests: parse → JSON IR → compare to expected fixture.
- Error tests: malformed XML, unknown elements, circular inheritance.

## Dependencies

None — this is the foundation milestone.

## Rough Effort

**M** — 1–2 weeks.
