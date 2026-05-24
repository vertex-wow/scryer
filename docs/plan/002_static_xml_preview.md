# Milestone 2 — Static XML Preview Webview

## Goal

Render the M1 IR visually in a VSCode webview using DOM, implementing the WoW anchor/layout system, layer/strata ordering, and placeholder textures. No Lua yet. Deliverable: a VSCode extension that opens a preview panel for any `.xml` file.

## Approach

1. Extension scaffold (`package.json` contributes, esbuild build of host + webview bundles).
2. Command `scryer.open` + a `WebviewPanel` (Beside) keyed to the active `.xml`.
3. Host parses (M1) and posts a serialized render tree to the webview.
4. Webview layout engine computes absolute rects from anchors and renders nested `<div>`s.

## Extension Scaffold

- `package.json`:
  - `activationEvents: ["onLanguage:xml"]` plus a keyed command.
  - `contributes.commands`: `scryer.open` ("Open WoW Preview").
  - `contributes.configuration`: `scryer.installDir`, `scryer.target` (M5 forward-compat).
- esbuild: two entry points:
  - `src/extension.ts` → `dist/extension.js` (node, cjs, external `vscode`)
  - `src/webview/main.ts` → `dist/webview.js` (browser, iife)
- Use `vscode.window.createWebviewPanel` for M2; upgrade to `CustomTextEditorProvider` later for true split editor.

## Renderer Choice

| Option | Pros | Cons |
|--------|------|------|
| **DOM (recommended for M2)** | Easy to inspect; free text rendering; CSS z-index for strata | Imperfect blend modes; no real texcoord cropping; approximate |
| Canvas 2D (later) | Correct atlas cropping; alpha modes; rotation | Must implement text + hit-testing manually |
| WebGL (much later) | Full fidelity (ADD/MOD blend, masks, shaders) | Heavy; complex |

**Decision: DOM for M2.** Design a `Renderer` interface so a Canvas implementation can slot in later.

## WoW Anchor/Layout Engine

WoW's coordinate system has (0,0) at the **bottom-left** of UIParent with y increasing upward. CSS has (0,0) at the **top-left** with y increasing downward — invert all y values.

### Resolution rules

- **UIParent** fills the webview viewport (configurable UI scale).
- **0 anchors + explicit Size** → unpositioned / warn.
- **1 anchor + Size** → position by that single point.
- **2+ anchors** → derive size from the span between them; explicit Size overrides.
- **`setAllPoints`** → match the relative frame's rect exactly (equivalent to TOPLEFT + BOTTOMRIGHT anchors to target).

### Point math (single anchor)

```
frameX = targetRect[relativePoint].x  +  xOffset  −  frameWidth  * selfFraction[point].x
frameY = targetRect[relativePoint].y  −  yOffset  −  frameHeight * selfFraction[point].y
```

Where `selfFraction[TOPLEFT] = (0, 0)`, `CENTER = (0.5, 0.5)`, `BOTTOMRIGHT = (1, 1)`, etc., and yOffset is negated (WoW y-up → CSS y-down).

### Anchor target resolution (priority)

1. `relativeTo="GlobalName"` → look up by name in frame registry.
2. `relativeKey="$parent.Shadow"` → traverse dotted path from current frame.
3. No key/name → use parent frame.

### Two-pass layout

1. Build the DOM tree (insert nodes top-down).
2. Resolve all anchors after the full tree is built (handles forward references).
3. Detect and break cycles (depth limit / visited set).

## Layer & Strata Ordering

### Within a frame (draw layers, back→front)

`BACKGROUND` → `BORDER` → `ARTWORK` → `OVERLAY` → `HIGHLIGHT`

Each `<Layer>` has `textureSubLevel` (−8..7). Map (layer_index × 20 + subLevel + 8) → CSS `z-index` within the frame.

### Across frames (frame strata, low→high)

`PARENT < BACKGROUND < LOW < MEDIUM < HIGH < DIALOG < FULLSCREEN < FULLSCREEN_DIALOG < TOOLTIP < BLIZZARD`

Compound z-index: `strataBase[strata] * 1000 + frameLevel`. Apply via CSS `z-index` on positioned divs.

## Placeholder Textures

When an asset is not yet available (M3 not done):
- Render a colored rectangle (color deterministically hashed from the file/atlas path).
- Overlay the path as a small semi-transparent label (helps identify what to extract).
- Log each missing asset once to the output channel.

## FontString Rendering

- Render using a `<span>` inside a positioned div.
- Font family fallback: Friz Quadrata-like → `"Palatino Linotype", "Book Antiqua", serif`.
- Apply `justifyH` (CSS `text-align`) and `justifyV` (CSS `align-items` or `padding`).
- `size.y` from the IR maps to `font-size` (approximate; real WoW uses font height in points).
- Mark all text as "approximate" in a tooltip on the element.

## Webview ↔ Extension Message Protocol

```ts
// Extension host → webview
{ type: "render";   tree: RenderTreeNode; viewport: { w: number; h: number } }
{ type: "assetResolved"; path: string; uri: string }           // M3
{ type: "reload";   tree: RenderTreeNode }                      // M6

// Webview → extension host
{ type: "ready" }
{ type: "requestAsset"; path?: string; atlas?: string }        // M3
{ type: "frameEvent"; frameId: string; event: string; args: unknown[] } // M4
```

**CSP:**
```
default-src 'none';
img-src ${webview.cspSource};
style-src ${webview.cspSource} 'unsafe-inline';
script-src 'nonce-<random>';
```

## Key Technical Decisions

- **WebviewPanel** now; `CustomTextEditorProvider` later when the UX is proven.
- Serialize the **fully resolved** render tree in the extension host. Keep template merging and IR logic out of the sandboxed webview.
- Keep layout engine in the webview (it needs the actual DOM measurements for font metrics etc.).

## Foreseen Hurdles

- Anchor forward references and resolution chains spanning multiple files.
- **y-axis inversion bugs** — the most common layout error; unit test point math independently.
- Frames with no explicit size that derive their size from children or two-anchor spans.
- Approximating WoW's global UI scale so layouts look proportionally correct.
- Blizzard templates (`DefaultPanelTemplate`, etc.) create visible content; will appear as placeholders until M4 supplies them.

## Dependencies

**M1** — parser/IR.

## Rough Effort

**M** — 1–2 weeks.
