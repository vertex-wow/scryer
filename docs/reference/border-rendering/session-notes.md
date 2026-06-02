# Border Fix — Session Handoff

## Context

Fixing the border rendering for `ExampleFrameModalDialog__Vertex` vs `ExampleFrameTooltip__Vertex`. The Tooltip border looks right; the Dialog border does not. The bug is visible in the VS Code live panel (Scryer extension).

Reference screenshot at `_reference/wow-cookbook/docs/frames/assets/example_frame_modal_dialog.png` (shot at 3440×1440 in-game). The diamond-metal corner pieces should visually "float" — they should appear to protrude slightly past (or sit just at the edge of) the dark background tile.

---

## What was diagnosed

### The XML/Lua structure

**`ExampleFrameModalDialog.xml`** — uses `<Frame inherits="DialogBorderTemplate" useParentLevel="true" setAllPoints="true"/>` as its border.

**`DialogBorderTemplate`** (defined in `_live/scryer-vscode-cache/retail/source/interface/addons/blizzard_sharedxml/shared/dialog/dialogtemplates.xml`):

- Inherits `DialogBorderNoCenterTemplate` which inherits `NineSlicePanelTemplate` with `layoutType = "Dialog"`
- Adds a `Bg` texture in `BACKGROUND` layer sublevel -5:
  - file: `Interface\DialogFrame\UI-DialogBox-Background` (tiling)
  - Anchored with `TOPLEFT x=7, y=-7` and `BOTTOMRIGHT x=-7, y=7`
  - This makes the Bg texture 7px inset from all sides of the border frame

**Dialog NineSlice layout** (defined in `_live/.../blizzard_sharedxml/mainline/nineslicelayouts.lua`):

```lua
Dialog = {
    TopLeftCorner    = { atlas = "UI-Frame-DiamondMetal-CornerTopLeft" },
    TopRightCorner   = { atlas = "UI-Frame-DiamondMetal-CornerTopRight" },
    BottomLeftCorner = { atlas = "UI-Frame-DiamondMetal-CornerBottomLeft" },
    BottomRightCorner= { atlas = "UI-Frame-DiamondMetal-CornerBottomRight" },
    TopEdge    = { atlas = "_UI-Frame-DiamondMetal-EdgeTop" },
    BottomEdge = { atlas = "_UI-Frame-DiamondMetal-EdgeBottom" },
    LeftEdge   = { atlas = "!UI-Frame-DiamondMetal-EdgeLeft" },
    RightEdge  = { atlas = "!UI-Frame-DiamondMetal-EdgeRight" },
}
```

**No x/y offsets on any piece.** (Compare: `WoodenNeutralFrameTemplate` has `x=-6, y=6` etc. to push corners outward.)

The NineSlice corners are positioned: `piece:SetPoint("TOPLEFT", container, "TOPLEFT", nil, nil)` — i.e., TOPLEFT of corner = TOPLEFT of container = TOPLEFT of parent frame. Zero offset.

The "floating" effect is expected to come purely from the artwork: the outer 7px of each corner has diamond art over no background, while the inner portion sits above the dark Bg tile.

---

### The atlas entries (the 2x bug)

All DiamondMetal atlases only exist as `-2x` variants in the atlas manifest:

```
ui-frame-diamondmetal-cornertopleft-2x: x=1, y=521, w=128, h=128, sheetW=256, sheetH=1024
```

These are **128×128 physical pixels for a 64×64 logical element**. Before the fix, Scryer was using the raw physical dimensions (128×128 logical), making corners too large and causing edge elements to have negative/broken width.

---

### The 2x fix (unstaged — already applied, needs commit)

Three files changed:

**`src/assets/atlas-manifest.ts`** — `resolveAtlasInTexture` now divides all atlas coordinates by 2 when the entry was found under the `-2x` key:

```typescript
let scaleDivisor = 1;
if (!entry) {
  entry = manifest[origLower + "-2x"] ?? manifest[strippedLower + "-2x"];
  if (entry) scaleDivisor = 2;
}
const d = scaleDivisor;
tex.resolvedAtlas = { x: entry.x/d, y: entry.y/d, width: entry.width/d, height: entry.height/d,
                      sheetW: entry.sheetW/d, sheetH: entry.sheetH/d, ... };
```

**`src/lua/wow-api.ts`** — same fix in `C_Texture.GetAtlasInfo` stub (also divides dimensions by 2 for 2x entries).

**`src/webview/main.ts`** — `applyAsset` tiling fix: `scaleX = crop.tilesH ? 1 : elemW / crop.width` — tiling axes keep native scale instead of being stretched, so tiles repeat at their natural size.

**The build was run and succeeded: `pnpm build` is current.**

---

### What still looks wrong (the unresolved issue)

After the 2x fix, the user says: _"still doesn't look right. the in-game shot REALLY does look like the border has an offset so it 'Stick outs' from the frame a bit. it's not completely 100% flush with the dark background but at most like 1px of dark background poking out from the edge of the visual border. Because the corners are diamonds, they need to 'Stick out' in the air around the frame to look right."_

The session ended before this was solved. The 2x fix alone is not enough.

---

## Hypotheses for the remaining bug

### Hypothesis 1 — `overflow:hidden` clipping (most likely)

In `src/webview/renderer.ts:198`, every frame `<div>` gets:

```
el.style.overflow = "hidden";
```

The NineSlice corners need to visually extend outside the `DialogBorderTemplate` frame's own bounding box to look right. Even though the border frame is setAllPoints on the parent (same size), the **corners themselves need to extend slightly beyond the parent frame's outer edge** so the diamond tips float "in the air". In WoW, frames do not have overflow clipping, so children can draw outside frame bounds. In Scryer they can't.

**How to verify:** In browser devtools on the live view, inspect the corner texture `<div>`. Check if its rect exceeds the parent frame rect. Check if removing `overflow:hidden` from the frame div changes the appearance.

**Potential fix:** For frames with `useParentLevel=true` (border frames), `overflow` should be `visible`, not `hidden`. Or more surgically: only set `overflow:hidden` on frames that genuinely need clipping (i.e., frames with `ClampedToScreen` or explicit clip flags), not universally.

### Hypothesis 2 — Corner size or position miscalculation

With the 2x fix, corners should be 64×64 logical pixels. But `useAtlasSize` flow: at `renderer.ts:237`, the code only sets `tex.size` if `!tex.size` (no existing size). If there's an existing size from somewhere, the atlas size is ignored.

**How to verify:** In devtools, check the corner texture `<div>` computed size. Should be ~64×64 CSS px.

### Hypothesis 3 — Bg texture not rendering with 7px inset

If the Bg anchor (`TOPLEFT x=7, y=-7`, `BOTTOMRIGHT x=-7, y=7`) is not being parsed/applied correctly, the dark background would fill the entire frame area (no gap for corners to float over).

**How to verify:** In devtools, check the Bg texture `<div>` position. Should be inset 7px from frame edge.

### Hypothesis 4 — The artwork actually has the diamond extending outward

Looking at the physical atlas: TopLeft corner is at physical x=1, y=521. The 1px margin is standard atlas padding. The actual artwork within the 128×128 tile might have the diamond shape designed to extend beyond the tile's nominal bounds via a negative CSS crop (the x=1 instead of x=0 means the leftmost pixel column is used for atlas bleed prevention). At 2x scale: logical x=0.5. This sub-pixel offset means the background-position is `-0.5px` — effectively 0. But if the artwork has the diamond tip AT logical (0,0), the corner is flush with the frame edge.

For corners to protrude OUTSIDE the parent frame in WoW without explicit negative offsets, the artwork must be designed to use the full tile that is anchored with an outward-pointing corner (TOPLEFT of corner touches the frame's TOPLEFT corner, and the diamond arm extends outward from there into the surrounding transparent space). This DOES require the frame div to not clip with overflow:hidden if the diamond extends even 1px outside the parent bounds.

---

## Key files to look at

| File                                                                   | Why                                                |
| ---------------------------------------------------------------------- | -------------------------------------------------- |
| `src/webview/renderer.ts:195-210`                                      | Frame div creation — `overflow:hidden` at line 198 |
| `src/webview/renderer.ts:233-241`                                      | `useAtlasSize` injection before layout             |
| `src/webview/main.ts:419-437`                                          | `applyAsset` atlas background rendering            |
| `src/webview/layout.ts`                                                | Anchor resolution                                  |
| `_live/.../blizzard_sharedxml/shared/dialog/dialogtemplates.xml:63-80` | DialogBorderTemplate definition                    |
| `_live/.../blizzard_sharedxml/mainline/nineslicelayouts.lua:157-168`   | Dialog layout (no offsets)                         |
| `_live/.../blizzard_sharedxml/nineslice.lua:95-130`                    | SetupCorner / SetupEdge implementation             |

---

## Recommended next action

1. Open live panel in VS Code on `ExampleFrameModalDialog__Vertex`.
2. Open browser devtools (Ctrl+Shift+I in VS Code webview, or use the "Open Webview Developer Tools" command).
3. Inspect the rendered DOM for the DialogBorderTemplate frame. Find the corner texture divs.
4. Check: corner size (should be ~64×64), corner position (should be top:0, left:0 within the border frame div), and whether the parent frame div's `overflow:hidden` is preventing the corner art from showing in the outer margin area.
5. Most likely fix: change `renderer.ts:198` from `el.style.overflow = "hidden"` to `el.style.overflow = frame.useParentLevel ? "visible" : "hidden"` — or use `"visible"` unconditionally and see what breaks.

---

---

## Session 2 findings (Opus research — 2026-06-02)

### overflow:visible fix — applied, partially correct

`renderer.ts:198` now sets `overflow:visible` for `useParentLevel` frames. Corners no longer clip at the frame edge. BUT the user confirms the whole border still sits too far inward — not just a clipping issue.

### Root cause of "border too far in": edge tiling stride bug

**The data has no offset.** Confirmed: `Dialog` NineSlice layout has zero x/y offsets on all pieces. `SetupCorner` anchors TOPLEFT-of-corner to TOPLEFT-of-container with (0,0) offset. There is no `padding`/`inset` field. Compare `WoodenNeutralFrameTemplate` which uses explicit `x=-6, y=6` etc — Dialog deliberately does not.

**The "stick out" in-game is geometrically small.** The only data-driven gap is the Bg inset: `TOPLEFT x=7 y=-7 / BOTTOMRIGHT x=-7 y=7`. The dark Bg stops 7px from the frame edge. Corners are 64×64 and start at the frame corner (0,0) — their outer 7px strip overlaps the margin, rest overlaps the dark Bg. The in-game appearance looks bigger because the diamond artwork is visually prominent.

**The actual bug: edge tiling stride = full sheet, not sprite region.**

In `src/webview/main.ts:429-437` (`applyAsset`), when `tilesH = true`:

```ts
const scaleX = crop.tilesH ? 1 : elemW / crop.width;
const bgW = crop.sheetW * scaleX; // = sheetW * 1 = 256px (full sheet!)
el.style.backgroundSize = `${bgW}px ${bgH}px`;
el.style.backgroundRepeat = crop.tilesH || crop.tilesV ? "repeat" : "no-repeat";
```

The edge sprite (`_UI-Frame-DiamondMetal-EdgeTop`) is only **64px wide** inside a **256px sheet**. CSS `background-repeat` repeats the _entire background image_ at `background-size` stride (256px), so the 64px sprite is followed by 192px of unrelated sheet content before repeating. The top/bottom/left/right edges render with large gaps of garbage content between repeats. This is why the metal border reads as broken/thin and the 7px protrusion is invisible.

**The `tilesH:true + main.ts tiling fix` from session 1 only half-solved this:** it stopped stretching, but left the repeat stride at `sheetW` instead of `crop.width`.

### What is NOT a bug

- Corner sizing: resolves to 64×64 logical ✓
- Corner position: TOPLEFT at (0,0) of border frame ✓
- Bg inset: 7px resolves correctly via `layoutByTwoAnchors` ✓
- No missing offset in data — don't add synthetic offsets

### Fix required: tiling stride = sprite size, not sheet size

CSS `background-repeat` can't tile a sub-region of a sprite sheet — it always strides by `background-size`. Options:

**Option A (clean, preferred):** Wrap tiling textures in a crop container `<div>` with `overflow:hidden` sized to the texture element dimensions, then apply the sprite tiling to an inner element sized to the sprite tile with `background-size = tile W×H` and `background-repeat:repeat`. The outer div clips to element bounds.

**Option B (simpler but hack-y):** Use CSS `background-clip` or a clip path. CSS `mask` with `mask-repeat:no-repeat` on the outer. Complex.

**Option C (canvas):** Render tiling sprites to a `<canvas>` with `drawImage` clipped to sprite region and `createPattern`. More powerful but different code path.

Option A matches the existing `<div>` renderer paradigm and is cleanest.

### Fix location

- `src/webview/main.ts` — `applyAsset` function, atlas crop branch (lines ~419-445)
- No layout.ts, renderer.ts, or atlas-manifest.ts changes needed for this fix

### Atlas + tiling investigation (2026-06-02)

**Atlas manifest:** all DiamondMetal entries have `tilesH: false, tilesV: false`. But tiling is set via `SetHorizTile`/`SetVertTile` in Lua, not the manifest flag.

**Tiling chain confirmed working:**

- `SetHorizTile` IS stubbed in `src/lua/frame-class.lua:192` → `createframe.ts:751` captures it as `horizTile: true`
- `renderer.ts:48-49` uses `tex.horizTile ?? ra.tilesH` → `tilesH: true` for edges
- `applyAsset` correctly sets `scaleX = 1` (don't stretch) and `background-repeat: repeat`

**Viewed actual sprite sheet PNG** (`uiframediamondmetal2x.blp` → SHA1-cached PNG):

- Two thin horizontal edge strips at the TOP of the sheet — they occupy **only the LEFT HALF** of the 128px-wide sheet
- Right half of the sheet (x=64..128 logical) is TRANSPARENT

**Root cause confirmed:**
With `background-size: 128px 512px` (= sheetW × sheetH) and `background-repeat: repeat`, CSS tiles the ENTIRE image at 128px stride. Each 128px tile shows:

- x=0..64: metal edge sprite ✓
- x=64..128: transparent gap ✗

Result: alternating 64px metal / 64px gap — border looks absent.

**Vertical edges are fine:** `!edgeleft` and `!edgeright` use a separate vertical sheet (`uiframediamondmetalvertical2x.blp`) where `sheetH = 64 = crop.height`. Vertical stride = 64px = sprite height → solid coverage. No fix needed there.

**Fix approach: canvas-based sprite extraction for tiling axes where sprite < sheet dimension.**

- Trigger: `crop.tilesH && crop.sheetW > crop.width` (horizontal case) OR `crop.tilesV && crop.sheetH > crop.height` (vertical)
- Load the sheet PNG via JS `Image` (cached), compute `physicalScale = img.naturalWidth / crop.sheetW`
- Extract sprite to offscreen canvas: `drawImage(img, crop.x*ps, crop.y*ps, crop.width*ps, crop.height*ps, 0, 0, crop.width, crop.height)`
- Apply: `background-image: url(dataUrl); background-size: ${crop.width}px ${crop.height}px; background-repeat: repeat`
- No upstream IR/renderer changes needed — physicalScale computed dynamically from image natural dimensions
- Only `src/webview/main.ts` needs changing

**Implementation attempted and REVERTED.**

Canvas approach was tried: `loadImage()` + `extractSpriteDataUrl()` async-extracted the sprite sub-region and replaced the background. Result in `.plan/live_view_3440x1440_modal_bad_gaps.png` — made things worse (visible artifacts/gaps). Root cause of canvas failure not fully diagnosed. The async overwrite of an already-rendered CSS background may have created timing artifacts, or the canvas `physicalScale` logic had an error.

Canvas code removed from `main.ts`. State returned to: `overflow:visible` for `useParentLevel` frames only (renderer.ts) + existing stretch-based tiling (main.ts).

**Open problem:** edge tiling stride is `sheetW=128` but sprite is only 64px wide → 50% coverage per stride. Canvas approach was the right idea but implementation produced worse result. Needs a different approach or careful debugging of canvas extraction coordinates before retrying.

Screenshots in .plan:

- `live_view_3440x1440_modal_bad_offset.png` — state before canvas fix (overflow:visible only, edges thin)
- `live_view_3440x1440_modal_bad_gaps.png` — canvas fix attempt result (worse: visible gaps)

### Open question

After fixing edge tiling: will the 7px corner protrusion look right, or will it still look too thin vs in-game? The in-game screenshot was at 3440×1440 (UHD) — Scryer's `frameScale` calibration may account for some of the visual difference. Evaluate after the tiling fix lands.

---

## Current git state

- Branch: `main`
- Unstaged changes in: `src/assets/atlas-manifest.ts`, `src/lua/wow-api.ts`, `src/webview/main.ts`
- New untracked files: `test/manual/ExampleFrameModalDialog__Vertex/` (XML + TOC + harness)
- `pnpm build` is current (built successfully)
- Nothing staged yet — the fix is partial, commit when resolved
