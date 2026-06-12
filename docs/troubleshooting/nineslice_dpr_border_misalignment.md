# NineSlice border misalignment at non-1x DPR

**Symptoms:** Title bar top and/or bottom border bands visually misaligned between corner pieces and edge pieces at non-1x DPR (e.g. 1.82x). Corners appear darker/correct; middle edge appears ~0.5-1 CSS px shifted, revealing a ~4-5px lighter or shifted band. Headless tests at 1x DPR pass.

**Affected template:** `DefaultPanelTemplate` (and any NineSlice frame using `tilesH && !tilesV` edge pieces).

---

## Visual progression

**Partial improvement — top, bottom, and separation all wrong:**
![title_bar_weird__2026-06-04_2139.png](assets/title_bar_weird__2026-06-04_2139.png)

**After Fix 2+3 — bottom border fixed, top border and separation still wrong:**
![title_bar_weird__2026-06-05_0013.png](assets/title_bar_weird__2026-06-05_0013.png)

**After Fix 4 — top border fixed, separation remains (may be acceptable for a rough preview):**
![title_bar_weird__2026-06-05_0707.png](assets/title_bar_weird__2026-06-05_0707.png)

**After Fix 5 — seam bleed + background-size rounding: right seam near-eliminated, left seam faint:**
![title_bar_weird__2026-06-05_0827.png](assets/title_bar_weird__2026-06-05_0827.png)

---

## Root cause 1 — fractional `background-position` (bottom border)

`background-position-y` was computed as a raw float (e.g. `-0.5px`). At non-integer DPR, `-0.5 CSS px = -0.91 device px`. Chromium rounds this differently depending on `background-repeat` mode: the `repeat` tile-fit path snaps to -1 device px; the `no-repeat` path may render sub-pixel. This misaligns tiles sharing the same logical position.

**Fix:** Round `background-position` values to integer px before assignment. See `main.ts` Fix 2, committed in `240ee9a`.

---

## Root cause 2 — Chromium phase-snap on `repeat-x` (top border)

After fixing the fractional position, the bottom border aligned but a top-border mismatch appeared.

**Key discovery:** Chromium's `background-repeat: repeat` path (including `repeat-x`) runs a **tile-fit phase-snap on ALL axes** during device-pixel mapping — even the axis not repeating. `background-repeat: no-repeat` does not snap. This means:

- Corner pieces (`no-repeat no-repeat`): atlas row rendered at device sub-pixel precision (e.g. device y = 464.10).
- Edge pieces (`repeat-x`): Y origin snapped to nearest device px (e.g. device y = 463.94 → snapped to 464 then offset = 463.94).

At 1.82x DPR a 0.16 device-px difference shifts which blend of the semi-transparent gradient rows (α = 23–60%) falls on each device row. Combined with a metallic background layer (`TopTileStreaks`) present behind the middle section but not corners, the edge appears visibly lighter for ~4-5 CSS px at the top.

**Fix:** For `tilesH && !tilesV` pieces (h-only tiles), stretch one tile instance to fill element width (`scaleX = elemW / crop.width`) and use `no-repeat no-repeat`. Since the edge tile is x-uniform (a pure y-gradient), this is visually identical to tiling but puts the edge on the same Chromium render path as corners — no phase-snap on either axis. CSS clips background overflow to element bounds automatically. See `main.ts` Fix 4, committed in `8dcf260`.

---

---

## Root cause 3 — device-pixel gap between adjacent CSS element boxes (vertical seams)

After Fix 4, two vertical seam lines appeared at the horizontal junctions where corner pieces meet the edge piece (TopLeft/TopEdge boundary and TopEdge/TopRight boundary). These lines are visible only at non-1x DPR because they arise from the same class of Chromium compositing rounding that affected the horizontal borders.

**Mechanism:** The parent `#viewport` carries `transform: scale(panZoom)`. Chromium rasterises each element's device extent independently before compositing, then scales the entire layer. At fractional net scale (panZoom × DPR), the device-pixel extents of adjacent elements can fail to be perfectly adjacent — a 1-device-pixel column at the seam belongs to neither element and shows through as a transparent gap wherever the NineSlice tiles are semi-transparent (the gradient area above the title bar body).

A secondary contributor: `background-size` was computed as a raw float (`sheetW × elemW / cropW`). At fractional DPR the background could fall 1 device pixel short of the element's right edge, exposing the element's transparent background.

**Fix 5 (committed):**

- `renderer.ts`: h-only tiles (`tilesH && !tilesV` — TopEdge, BottomEdge) are extended 1 CSS px left and 1 CSS px right at render time. These tiles are x-uniform (pure y-gradient), so the 1px bleed columns are visually identical to any other column. `applyAsset` reads the already-extended `offsetWidth`, so `scaleX`/`bgW` fill the wider element correctly; `bgPosX` was shifted +1 at the time to keep atlas content visually aligned.
- `main.ts`: `bgW` and `bgH` now rounded to integer px (`Math.round`), eliminating background-size underfill.

**Remaining issue after Fix 5 (left seam):** The right seam (TopEdge/TopRight) was nearly eliminated; the left seam (TopLeft/TopEdge) remained faint. The asymmetry arose because `bgPosX +1` made element x=0 of TopEdge transparent, leaving the fractional device-pixel at the TopLeft.right boundary as a 62.5% TopLeft / 37.5% TopEdge blend — visible whenever the two atlas sources differ at that column.

---

## Root cause 4 — transparent seam-bleed column exposes mixed-element device pixel (left seam)

With seamBleed=1, TopEdge element starts at CSS x=TopLeft.right−1. The `bgPosX+1` shift left element x=0 transparent, so atlas content started at element x=1 = CSS x=TopLeft.right. At uiScale=1.875 this maps to viewport x=TopLeft.right×1.875 (fractional). The device pixel straddling that position blended 62.5% TopLeft with 37.5% TopEdge — a faint seam when the two atlas sources differ.

**Fix 6:** Remove the `+seamBleed` offset from `bgPosX`. Content starts at element x=0 (CSS x=TopLeft.right−1). Because edge pieces render on top of corners in DOM order (TopEdge is added after TopLeftCorner in NineSlice setup), the 1px overlap pixel is covered by TopEdge content. The device pixel straddling TopLeft.right now falls entirely within TopEdge's rasterized element — no mixed-element blend.

- `main.ts`: `bgPosX` formula changed from `Math.round(-crop.x * scaleX) + seamBleed` to `Math.round(-crop.x * scaleX)`. One-line change.
- Test added: "H-only NineSlice tiles bgPosX is 0" guards this invariant.

---

## Investigation path

1. Noticed top/bottom border mismatch in live VS Code view only (not headless 1x tests).
2. Identified non-1x DPR as the differentiator.
3. Probed atlas data: confirmed `TopEdge` tile is x-uniform (pure y-gradient) — ruling out content difference.
4. Confirmed CSS math identical for corner vs edge at elemH=75: same `bgPosY`, same `bgH`, same first-content row. Bug must be in rendering, not layout.
5. Bisected repeat mode: switching edge from `repeat-x` to `no-repeat` aligned the top. Traced root cause to Chromium's per-axis phase-snap behavior on repeat paths.

---

## Tests added

- `top-row NineSlice background-position-y is integer` — guards Fix 2 (no fractional position).
- `horizontal-only NineSlice tiles use no-repeat (stretch-to-fill)` — guards Fix 4 (h-only = stretch + `no-repeat no-repeat`, `bgSizeW >= elemW`).
- Pixel-color assertions at known corner/edge coordinates for top and bottom border rows.
- `title bar seam alignment` updated — assertions now expect 1px intentional overlap (`middle.left === topLeft.right − 1`) rather than flush join, reflecting the Fix 5 seam bleed.
