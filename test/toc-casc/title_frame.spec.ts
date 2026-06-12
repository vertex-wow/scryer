/**
 * TOC live view test — ExampleFrameTitleFrameAddon (CASC)
 *
 * Requires scryer.cacheDir in dev/settings.local.json with
 * Interface/AddOns/Blizzard_SharedXML/ present. Errors as misconfigured otherwise.
 *
 * Verifies the full DefaultPanelTemplate path: with Blizzard XML templates
 * loaded (matching the production live-panel.ts path), DefaultPanelTemplate
 * resolves via ButtonFrameTemplate, its mixin is applied, and the Lua call
 * SetTitle("Example Title Frame") sets the title FontString text.
 *
 * Complements test/toc/title_frame.spec.ts (guard path — template unresolved,
 * SetTitle error swallowed) by covering the resolved-template path separately.
 *
 * Fixture: test/fixtures/ExampleFrameTitleFrameAddon/
 */

import { test, expect } from "@playwright/test";
import { resolve } from "path";
import {
  runTocFixtureWithBlizzard,
  renderTocFixtureWithBlizzard,
  renderTocFixtureWithScreenResolution,
  renderTocFixtureWithLocalAssets,
  getBlizzardAddonsDir,
  queryRendered,
  VIEWPORT,
  getExtractedAssetsDir,
  sampleAtWowCoord,
} from "./helpers";

const FIXTURE_DIR = resolve(__dirname, "../fixtures/ExampleFrameTitleFrameAddon");

// ---------------------------------------------------------------------------
// Frame geometry
// ---------------------------------------------------------------------------

test("ExampleFrameTitleFrameAddon CASC — frame geometry", async ({ page }) => {
  const addonsDir = getBlizzardAddonsDir();

  await renderTocFixtureWithBlizzard(page, FIXTURE_DIR, addonsDir!);

  const rendered = await queryRendered(page);
  const frame = rendered.find((f) => f.name === "ExampleFrameTitleFrame");
  expect(frame).toBeDefined();
  expect(frame!.width).toBe(380);
  expect(frame!.height).toBe(260);
  // CENTER anchor: left = viewport_w/2 - 190, top = viewport_h/2 - 130
  expect(frame!.left).toBe(Math.round(VIEWPORT.w / 2 - 190));
  expect(frame!.top).toBe(VIEWPORT.h / 2 - 130);
});

// ---------------------------------------------------------------------------
// DefaultPanelTemplate resolved — children injected from template hierarchy
// ---------------------------------------------------------------------------

test("ExampleFrameTitleFrameAddon CASC — DefaultPanelTemplate injects children", async () => {
  const addonsDir = getBlizzardAddonsDir();

  const frames = await runTocFixtureWithBlizzard(FIXTURE_DIR, addonsDir!);

  const main = frames.find((f) => f.name === "ExampleFrameTitleFrame");
  expect(main).toBeDefined();
  // DefaultPanelTemplate → ButtonFrameTemplate hierarchy injects child frames
  // (close button, portrait, inset, etc.). At least one must be present.
  expect(main!.children.length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// SetTitle() wired up — title text "Example Title Frame" appears in DOM
// ---------------------------------------------------------------------------

test("ExampleFrameTitleFrameAddon CASC — SetTitle sets title FontString text", async ({ page }) => {
  const addonsDir = getBlizzardAddonsDir();

  await renderTocFixtureWithBlizzard(page, FIXTURE_DIR, addonsDir!);

  const titleTexts = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-kind="FontString"] span')).map(
      (el) => el.textContent ?? "",
    ),
  );
  expect(titleTexts).toContain("Example Title Frame");
});

// ---------------------------------------------------------------------------
// Title bar seam alignment — top NineSlice row corner coordinates
//
// DefaultPanelTemplate → NineSlice child (ButtonFrameTemplateNoPortrait) has 8
// pieces (no Center) in the OVERLAY layer. The top row is 3 pieces:
// TopLeftCorner, TopEdge, TopRightCorner. Verify that each adjacent pair shares
// all four boundary-point coordinates (x seam, top-y, bottom-y).
// ---------------------------------------------------------------------------

test("ExampleFrameTitleFrameAddon CASC — title bar seam alignment", async ({ page }) => {
  const addonsDir = getBlizzardAddonsDir();

  await renderTocFixtureWithBlizzard(page, FIXTURE_DIR, addonsDir!);

  // ButtonFrameTemplateNoPortrait pieces use OVERLAY layer. TitleContainer's
  // OVERLAY has only a FontString (no Texture), so this returns exactly the
  // NineSlice piece textures.
  const pieces = await page.evaluate(() => {
    const frameEl = document.querySelector<HTMLElement>('[data-name="ExampleFrameTitleFrame"]');
    if (!frameEl) return null;
    return Array.from(
      frameEl.querySelectorAll<HTMLElement>('[data-layer="OVERLAY"] [data-kind="Texture"]'),
    ).map((el) => ({
      left: parseInt(el.style.left),
      top: parseInt(el.style.top),
      width: parseInt(el.style.width),
      height: parseInt(el.style.height),
    }));
  });

  expect(pieces).not.toBeNull();
  // ButtonFrameTemplateNoPortrait: TopLeft/TopRight/BottomLeft/BottomRight corners
  // + Top/Bottom/Left/Right edges = 8 pieces (no Center).
  expect(pieces!.length).toBe(8);

  // Top row = the 3 pieces with the minimum top value (corners/edge both at y=-16
  // due to y=16 WoW offset on the corner anchors).
  const minTop = Math.min(...pieces!.map((p) => p.top));
  const topRow = pieces!.filter((p) => p.top === minTop).sort((a, b) => a.left - b.left);

  // Must be exactly 3: TopLeftCorner, TopEdge, TopRightCorner.
  expect(topRow.length).toBe(3);

  const [topLeft, middle, topRight] = topRow;

  // TopLeft <-> Middle seam: Middle extends 1px into TopLeft (seam-bleed overlap).
  // Vertical coords must still match exactly.
  expect(middle.left).toBe(topLeft.left + topLeft.width - 1);
  expect(topLeft.top).toBe(middle.top);
  expect(topLeft.top + topLeft.height).toBe(middle.top + middle.height);

  // Middle <-> TopRight seam: Middle extends 1px into TopRight (seam-bleed overlap).
  expect(middle.left + middle.width).toBe(topRight.left + 1);
  expect(middle.top).toBe(topRight.top);
  expect(middle.top + middle.height).toBe(topRight.top + topRight.height);
});

// ---------------------------------------------------------------------------
// CSS invariant: all top-row NineSlice textures must have background-image applied
//
// After injectResolvedAssets(), every top-row OVERLAY Texture element must have
// its background-image set (not "none"). If the assetResolved path ever fails
// to match a data-asset-path, the element stays transparent and pixel tests
// below will fail for the wrong reason. This test makes the failure mode explicit.
// ---------------------------------------------------------------------------

test("ExampleFrameTitleFrameAddon CASC — top-row NineSlice textures have background-image applied", async ({
  page,
}) => {
  const addonsDir = getBlizzardAddonsDir();
  const assetsDir = getExtractedAssetsDir();

  await renderTocFixtureWithScreenResolution(page, FIXTURE_DIR, addonsDir!, assetsDir!, 1024, 768);

  const topRow = await page.evaluate(() => {
    const frameEl = document.querySelector<HTMLElement>('[data-name="ExampleFrameTitleFrame"]');
    if (!frameEl) return null;
    const texElems = Array.from(
      frameEl.querySelectorAll<HTMLElement>('[data-layer="OVERLAY"] [data-kind="Texture"]'),
    );
    const withTop = texElems.map((el) => ({
      top: parseInt(el.style.top),
      left: parseInt(el.style.left),
      bgImage: getComputedStyle(el).backgroundImage,
    }));
    const minTop = Math.min(...withTop.map((p) => p.top));
    return withTop.filter((p) => p.top === minTop).sort((a, b) => a.left - b.left);
  });

  expect(topRow).not.toBeNull();
  expect(topRow!.length).toBe(3); // TopLeftCorner, TopEdge, TopRightCorner
  for (const piece of topRow!) {
    expect(piece.bgImage).not.toBe("none");
  }
});

// ---------------------------------------------------------------------------
// Pixel color regression — eyedropper samples from Scryer live view at 1024x768
//
// Coordinates are exactly as reported by the eyedropper status bar at the
// bottom of the live view panel. The live view was set to 1024x768
// (uiParentWidth=1024, uiParentHeight=768), placing ExampleFrameTitleFrame
// at WoW x=322. sampleAtWowCoord() converts WoW logical coords to the client
// position needed to hit-test and canvas-sample the atlas, matching the
// eyedropper output exactly (including alpha for semi-transparent pixels).
//
// At 1024x768 uiScale=1.0, so WoW coords == screenshot pixels — no conversion needed.
//
// To add a new sample: copy the eyedropper status bar line as a comment above
// the sampleAtWowCoord call, then assert the expected channels below it.
//
// At 1024x768 (uiParentWidth=1024) the frame sits at WoW x=322. x=399 is the
// transition line: TopLeftCorner spans x=314-398, TopEdge spans x=399-628.
// Use x=390 for a clear corner sample and x=410 for a clear middle sample.
//
// Tolerance +/-2: coords near the TopLeftCorner/TopEdge seam straddle two
// different BLPs; headless 1x DPR can sample slightly different sub-pixel
// positions than the HiDPI display used for the measurement.
//
// Reference — title bar vertical structure (ButtonFrameTemplateNoPortrait):
//   Total height: 23 px in the reference screenshot.
//   Top of bar: transparent/semi-transparent outline (the atlas bleeds into
//     the area above the logical frame top).
//   Bottom 4 px: a constant dark band INTENDED to span the full title bar
//     width including the corner pieces. Currently it only renders correctly
//     in the middle segment (TopEdge, uiframemetalhorizontal2x.blp) — the
//     corners not showing it is the bug tracked in .plan/005_title_bug.md.
//     The reference colors are composited screen values (transparent atlas
//     pixels blended over the rock background); raw atlas pixels sampled via
//     the eyedropper differ. Top-to-bottom in the middle segment:
//       row 0  #1F1D19  rgb(31, 29, 25)
//       row 1  #3E3C36  rgb(62, 60, 54)
//       row 2  #46443F  rgb(70, 68, 63)
//       row 3  #000000  rgb(0, 0, 0)      <- semi-transparent black in atlas
// ---------------------------------------------------------------------------

const TOL = 2;
const near = (a: number, b: number) => Math.abs(a - b) <= TOL;

// ---------------------------------------------------------------------------
// No dim band at TopLeft/TopEdge seam (WoW x=389, y=257) — x-axis air gap
//
// At 1024x768, TopLeft corner right edge = WoW x=389. TopEdge element starts at
// x=388 (1px seam-bleed overlap) and TopEdge content also starts at x=388 (bgPosX=0).
// The column at x=388-390 must be within ±25 brightness of its neighbours.
// A dim-seam would appear as a markedly darker column at the element boundary.
//
// Pair with "bottom border bright row aligns" below, which covers the y-axis
// misalignment bug (corner and middle rendering bright row at different y).
// ---------------------------------------------------------------------------
test("ExampleFrameTitleFrameAddon CASC — no dim seam between TopLeftCorner and TopEdge at (384-394,257)", async ({
  page,
}) => {
  const addonsDir = getBlizzardAddonsDir();
  const assetsDir = getExtractedAssetsDir();

  await renderTocFixtureWithScreenResolution(page, FIXTURE_DIR, addonsDir!, assetsDir!, 1024, 768);

  const samples: Array<{ x: number; brightness: number }> = [];
  for (let x = 383; x <= 395; x++) {
    const p = await sampleAtWowCoord(page, x, 257);
    if (p) samples.push({ x, brightness: p.r + p.g + p.b });
  }

  expect(samples.length).toBeGreaterThanOrEqual(10);

  const maxB = Math.max(...samples.map((s) => s.brightness));
  const minB = Math.min(...samples.map((s) => s.brightness));
  // All sampled pixels should be within 25 brightness units of the max. A dim seam
  // would appear as a pixel ≥50 units below neighboring bright pixels.
  expect(maxB - minB).toBeLessThanOrEqual(25);
});

// TODO: replace with a custom-texture version using the swap fixture (ExampleFrameTitleFrameSwap__Vertex).
// Pixel assertions against CASC textures are fragile — composite values change whenever the rock
// background or atlas sprites change. Known solid-color textures make these assertions exact.
test("ExampleFrameTitleFrameAddon CASC — title bar top highlight pixel color at (384,257) and (394,257)", async ({
  page,
}) => {
  const addonsDir = getBlizzardAddonsDir();
  const assetsDir = getExtractedAssetsDir();

  await renderTocFixtureWithScreenResolution(page, FIXTURE_DIR, addonsDir!, assetsDir!, 1024, 768);

  // Top of title bar body — bright metal texture.
  // At 1024x768: frame left=322, corner piece 314-388, TopEdge from 389.
  // Both x=384 (TopLeftCorner) and x=394 (TopEdge) must agree — that agreement is
  // the alignment check. Before the fixes, these showed different values.
  // (384, 257)  #726F67  |cFF726F67  rgba(114, 111, 103, 1.00)
  const p1 = await sampleAtWowCoord(page, 384, 257);
  // (394, 257)  #737067  |cFF737067  rgba(115, 112, 103, 1.00)
  const p2 = await sampleAtWowCoord(page, 394, 257);

  expect(p1).not.toBeNull();
  expect(p2).not.toBeNull();
  expect(near(p1!.r, 114) && near(p1!.g, 111) && near(p1!.b, 103)).toBe(true);
  expect(near(p2!.r, 114) && near(p2!.g, 111) && near(p2!.b, 103)).toBe(true);
  expect(near(p1!.r, p2!.r) && near(p1!.g, p2!.g) && near(p1!.b, p2!.b)).toBe(true);
});

// TODO: replace with a custom-texture version using the swap fixture (ExampleFrameTitleFrameSwap__Vertex).
// Pixel assertions against CASC textures are fragile — composite values change whenever the rock
// background or atlas sprites change. Known solid-color textures make these assertions exact.
test("ExampleFrameTitleFrameAddon CASC — title bar bottom highlight pixel color at (394,276) and (404,276)", async ({
  page,
}) => {
  const addonsDir = getBlizzardAddonsDir();
  const assetsDir = getExtractedAssetsDir();

  await renderTocFixtureWithScreenResolution(page, FIXTURE_DIR, addonsDir!, assetsDir!, 1024, 768);

  // Bottom bright row of the border band (row 2 of the 4-row transition).
  // At 1024x768: both x=394 and x=404 are inside TopEdge — checking that the
  // bright row appears at the same y across the middle segment.
  // (394, 276)  #726F67  |cFF726F67  rgba(114, 111, 103, 1.00)
  const p1 = await sampleAtWowCoord(page, 394, 276);
  // (404, 276)  #726F67  |cFF726F67  rgba(114, 111, 103, 1.00)
  const p2 = await sampleAtWowCoord(page, 404, 276);

  expect(p1).not.toBeNull();
  expect(p2).not.toBeNull();
  expect(near(p1!.r, 114) && near(p1!.g, 111) && near(p1!.b, 103)).toBe(true);
  expect(near(p2!.r, 114) && near(p2!.g, 111) && near(p2!.b, 103)).toBe(true);
  expect(near(p1!.r, p2!.r) && near(p1!.g, p2!.g) && near(p1!.b, p2!.b)).toBe(true);
});

// ---------------------------------------------------------------------------
// CSS invariant: top-row NineSlice background-position-y must be integer
//
// The 2x atlas ÷2 convention produces crop.y=0.5 for all top-row pieces.
// Math.round(-0.5 * scaleY) = 0, so all three pieces emit integer
// background-position-y values. Chromium's repeat-x path (TopEdge) and
// no-repeat path (corners) then use the same quantization, keeping the
// title bar border visually aligned.
// ---------------------------------------------------------------------------

test("ExampleFrameTitleFrameAddon CASC — top-row NineSlice background-position-y is integer", async ({
  page,
}) => {
  const addonsDir = getBlizzardAddonsDir();
  const assetsDir = getExtractedAssetsDir();

  await renderTocFixtureWithScreenResolution(page, FIXTURE_DIR, addonsDir!, assetsDir!, 1024, 768);

  const topRow = await page.evaluate(() => {
    const frameEl = document.querySelector<HTMLElement>('[data-name="ExampleFrameTitleFrame"]');
    if (!frameEl) return null;
    const texElems = Array.from(
      frameEl.querySelectorAll<HTMLElement>('[data-layer="OVERLAY"] [data-kind="Texture"]'),
    ).filter((el) => getComputedStyle(el).backgroundImage !== "none");

    const withTop = texElems.map((el) => {
      const pos = getComputedStyle(el).backgroundPosition.trim().split(/\s+/);
      return {
        top: parseInt(el.style.top),
        left: parseInt(el.style.left),
        posY: parseFloat(pos[1] ?? "0"),
      };
    });

    const minTop = Math.min(...withTop.map((p) => p.top));
    return withTop.filter((p) => p.top === minTop).sort((a, b) => a.left - b.left);
  });

  expect(topRow).not.toBeNull();
  expect(topRow!.length).toBe(3); // TopLeftCorner, TopEdge, TopRightCorner

  for (const piece of topRow!) {
    // background-position-y must be a whole integer — no fractional tile phase.
    expect(piece.posY).toBe(Math.round(piece.posY));
  }
});

// ---------------------------------------------------------------------------
// CSS invariant: horizontal-only NineSlice tiles must not use full `repeat`
//
// TopEdge (tilesH:true, tilesV:false) was emitting background-repeat:"repeat"
// (both axes). Chromium's repeat path runs tile-fit rounding on the vertical
// axis, shifting content at fractional DPR vs the corners (no-repeat). Fix:
// per-axis repeat so the vertical axis stays on the no-repeat rendering path.
// Computed style normalises "repeat no-repeat" → "repeat-x".
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Bottom border alignment — corner vs middle (local texture swap) — y-axis misalignment
//
// The border band at the bottom of the title bar must appear at the same y
// in both the corner piece and the middle edge piece. This was the original
// issue #6 bug: corner and middle rendered the bright metallic row at different
// y positions due to background-position-y rounding. Pair with the "no dim seam"
// test above, which covers the x-axis air gap that appeared after the y fix.
//
// Uses local PNG overrides from ExampleFrameTitleFrameAddon/assets/ so the
// test does not depend on CASC-extracted BLPs. sampleAtWowCoord returns raw
// atlas brightness, avoiding composited-over-dark-rock ambiguity.
//
// Scans y=248-280 at corner x=384 (14 px inside TopLeftCorner) and middle
// x=402 (13 px into TopEdge). Both columns must find a bright row at same y.
// ---------------------------------------------------------------------------
test("ExampleFrameTitleFrameAddon local texture swap — bottom border bright row aligns between corner and middle", async ({
  page,
}) => {
  const addonsDir = getBlizzardAddonsDir();

  await renderTocFixtureWithLocalAssets(page, FIXTURE_DIR, addonsDir!, 1024, 768);

  let cornerBest = { y: 0, brightness: -1 };
  let middleBest = { y: 0, brightness: -1 };

  for (let y = 248; y <= 280; y++) {
    const cp = await sampleAtWowCoord(page, 384, y);
    const mp = await sampleAtWowCoord(page, 402, y);
    if (cp) {
      const bc = cp.r + cp.g + cp.b;
      if (bc > cornerBest.brightness) cornerBest = { y, brightness: bc };
    }
    if (mp) {
      const bm = mp.r + mp.g + mp.b;
      if (bm > middleBest.brightness) middleBest = { y, brightness: bm };
    }
  }

  expect(cornerBest.brightness).toBeGreaterThan(300);
  expect(middleBest.brightness).toBeGreaterThan(300);
  expect(Math.abs(cornerBest.y - middleBest.y)).toBeLessThanOrEqual(1);
});

// ---------------------------------------------------------------------------
// CSS invariant: H-only NineSlice tiles must have backgroundPositionX = 0
//
// renderer.ts extends H-only tiles (TopEdge, BottomEdge) 1px left via seamBleed.
// applyAsset() must NOT shift bgPosX right by seamBleed — instead, content starts
// at element x=0 (the 1px overlap with the adjacent corner). Because edge pieces
// render on top of corners (DOM order), this covers the fractional-boundary seam
// that appears at non-integer uiScale (e.g. 1.875× at 3440×1440).
// If bgPosX were +1, element x=0 would be transparent and the seam would leak through.
// ---------------------------------------------------------------------------
test("ExampleFrameTitleFrameAddon CASC — H-only NineSlice tiles bgPosX is 0", async ({ page }) => {
  const addonsDir = getBlizzardAddonsDir();
  const assetsDir = getExtractedAssetsDir();

  await renderTocFixtureWithScreenResolution(page, FIXTURE_DIR, addonsDir!, assetsDir!, 1024, 768);

  const hOnlyPieces = await page.evaluate(() => {
    const frameEl = document.querySelector<HTMLElement>('[data-name="ExampleFrameTitleFrame"]');
    if (!frameEl) return null;
    return Array.from(
      frameEl.querySelectorAll<HTMLElement>('[data-layer="OVERLAY"] [data-kind="Texture"]'),
    )
      .filter((el) => getComputedStyle(el).backgroundImage !== "none" && el.dataset.atlasCrop)
      .map((el) => {
        const crop = JSON.parse(el.dataset.atlasCrop!) as { tilesH: boolean; tilesV: boolean };
        const cs = getComputedStyle(el);
        const posX = parseFloat(cs.backgroundPosition.split(" ")[0]);
        return { tilesH: crop.tilesH, tilesV: crop.tilesV, posX };
      })
      .filter((p) => p.tilesH && !p.tilesV);
  });

  expect(hOnlyPieces).not.toBeNull();
  expect(hOnlyPieces!.length).toBeGreaterThan(0);
  for (const piece of hOnlyPieces!) {
    expect(piece.posX).toBe(0);
  }
});

test("ExampleFrameTitleFrameAddon CASC — horizontal-only NineSlice tiles use no-repeat (stretch-to-fill)", async ({
  page,
}) => {
  const addonsDir = getBlizzardAddonsDir();
  const assetsDir = getExtractedAssetsDir();

  await renderTocFixtureWithScreenResolution(page, FIXTURE_DIR, addonsDir!, assetsDir!, 1024, 768);

  const hOnlyPieces = await page.evaluate(() => {
    const frameEl = document.querySelector<HTMLElement>('[data-name="ExampleFrameTitleFrame"]');
    if (!frameEl) return null;
    return Array.from(
      frameEl.querySelectorAll<HTMLElement>('[data-layer="OVERLAY"] [data-kind="Texture"]'),
    )
      .filter((el) => getComputedStyle(el).backgroundImage !== "none" && el.dataset.atlasCrop)
      .map((el) => {
        const crop = JSON.parse(el.dataset.atlasCrop!) as { tilesH: boolean; tilesV: boolean };
        const cs = getComputedStyle(el);
        const bgSizeW = parseFloat(cs.backgroundSize.split(" ")[0]);
        return {
          tilesH: crop.tilesH,
          tilesV: crop.tilesV,
          repeat: cs.backgroundRepeat,
          elemW: el.offsetWidth,
          bgSizeW,
        };
      })
      .filter((p) => p.tilesH && !p.tilesV);
  });

  expect(hOnlyPieces).not.toBeNull();
  expect(hOnlyPieces!.length).toBeGreaterThan(0); // TopEdge must be present

  for (const piece of hOnlyPieces!) {
    // All h-only tiles must use no-repeat (stretch-to-fill).
    expect(piece.repeat).toBe("no-repeat");
    // bgSizeW = sheetW * (elemW / cropW). When tile < sheet, bgSizeW > elemW and CSS
    // clips the overflow. The tile region itself fills the element: bgSizeW >= elemW.
    expect(piece.bgSizeW).toBeGreaterThanOrEqual(piece.elemW - 1);
  }
});
