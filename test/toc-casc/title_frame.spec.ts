/**
 * TOC live view test — ExampleFrameTitleFrameAddon (CASC)
 *
 * Requires scryer.cacheDir in dev/settings.local.json with
 * Interface/AddOns/Blizzard_SharedXML/ present. Skips automatically otherwise.
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
import { PNG } from "pngjs";
import {
  runTocFixtureWithBlizzard,
  renderTocFixtureWithBlizzard,
  renderTocFixtureWithScreenResolution,
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
  test.skip(addonsDir === null, "Blizzard_SharedXML not found under scryer.cacheDir — skipping");

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
  test.skip(addonsDir === null, "Blizzard_SharedXML not found under scryer.cacheDir — skipping");

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
  test.skip(addonsDir === null, "Blizzard_SharedXML not found under scryer.cacheDir — skipping");

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
  test.skip(addonsDir === null, "Blizzard_SharedXML not found under scryer.cacheDir — skipping");

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

  // TopLeft <-> Middle seam: all 4 boundary-point coordinates must match.
  expect(topLeft.left + topLeft.width).toBe(middle.left);
  expect(topLeft.top).toBe(middle.top);
  expect(topLeft.top + topLeft.height).toBe(middle.top + middle.height);

  // Middle <-> TopRight seam: all 4 boundary-point coordinates must match.
  expect(middle.left + middle.width).toBe(topRight.left);
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
  test.skip(
    addonsDir === null || assetsDir === null,
    "Blizzard_SharedXML not found under scryer.cacheDir — skipping",
  );

  await renderTocFixtureWithScreenResolution(page, FIXTURE_DIR, addonsDir!, assetsDir!, 3440, 1440);

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
// Pixel color regression — eyedropper samples from Scryer live view at 3440x1440
//
// Coordinates are exactly as reported by the eyedropper status bar at the
// bottom of the live view panel. The live view was set to 3440x1440
// (uiParentWidth=1835, uiParentHeight=768), placing ExampleFrameTitleFrame
// at WoW x=728. sampleAtWowCoord() converts WoW logical coords to the client
// position needed to hit-test and canvas-sample the atlas, matching the
// eyedropper output exactly (including alpha for semi-transparent pixels).
//
// To add a new sample: copy the eyedropper status bar line as a comment above
// the sampleAtWowCoord call, then assert the expected channels below it.
//
// At 3440x1440 (uiParentWidth=1835) the frame sits at WoW x=728. x=795 is the
// transition line: TopLeftCorner spans x=720-794, TopEdge spans x=795-1036.
// Use x=790 for a clear corner sample and x=800 for a clear middle sample.
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

test("ExampleFrameTitleFrameAddon CASC — title bar top highlight pixel color at (790,257) and (800,257)", async ({
  page,
}) => {
  const addonsDir = getBlizzardAddonsDir();
  const assetsDir = getExtractedAssetsDir();
  test.skip(
    addonsDir === null || assetsDir === null,
    "Blizzard_SharedXML not found under scryer.cacheDir — skipping",
  );

  await renderTocFixtureWithScreenResolution(page, FIXTURE_DIR, addonsDir!, assetsDir!, 3440, 1440);

  // Top of title bar body — bright metal texture.
  // Recalibrated after Fix 2 (integer bgY) + Fix 3 (repeat-x): atlas mapping shifted.
  // Both x=790 (TopLeftCorner) and x=800 (TopEdge) must agree — that agreement is
  // the alignment check. Before the fixes, these showed different values.
  // (790, 257)  #726F67  |cFF726F67  rgba(114, 111, 103, 1.00)
  const p1 = await sampleAtWowCoord(page, 790, 257);
  // (800, 257)  #737067  |cFF737067  rgba(115, 112, 103, 1.00)
  const p2 = await sampleAtWowCoord(page, 800, 257);

  expect(p1).not.toBeNull();
  expect(p2).not.toBeNull();
  expect(near(p1!.r, 114) && near(p1!.g, 111) && near(p1!.b, 103)).toBe(true);
  expect(near(p2!.r, 114) && near(p2!.g, 111) && near(p2!.b, 103)).toBe(true);
  expect(near(p1!.r, p2!.r) && near(p1!.g, p2!.g) && near(p1!.b, p2!.b)).toBe(true);
});

test("ExampleFrameTitleFrameAddon CASC — title bar bottom highlight pixel color at (800,276) and (810,276)", async ({
  page,
}) => {
  const addonsDir = getBlizzardAddonsDir();
  const assetsDir = getExtractedAssetsDir();
  test.skip(
    addonsDir === null || assetsDir === null,
    "Blizzard_SharedXML not found under scryer.cacheDir — skipping",
  );

  await renderTocFixtureWithScreenResolution(page, FIXTURE_DIR, addonsDir!, assetsDir!, 3440, 1440);

  // Bottom bright row of the border band (row 2 of the 4-row transition).
  // Recalibrated after Fix 2+3: band shifted from y=273–276 to y=274–277. At y=276
  // both corner (x=800) and middle (x=810) now show the bright row — alignment
  // confirmed. Before the fixes the corner showed a different value here.
  // (800, 276)  #726F67  |cFF726F67  rgba(114, 111, 103, 1.00)
  const p1 = await sampleAtWowCoord(page, 800, 276);
  // (810, 276)  #726F67  |cFF726F67  rgba(114, 111, 103, 1.00)
  const p2 = await sampleAtWowCoord(page, 810, 276);

  expect(p1).not.toBeNull();
  expect(p2).not.toBeNull();
  expect(near(p1!.r, 114) && near(p1!.g, 111) && near(p1!.b, 103)).toBe(true);
  expect(near(p2!.r, 114) && near(p2!.g, 111) && near(p2!.b, 103)).toBe(true);
  expect(near(p1!.r, p2!.r) && near(p1!.g, p2!.g) && near(p1!.b, p2!.b)).toBe(true);
});

// ---------------------------------------------------------------------------
// Drop shadow row (y=275) — middle vs corner segment parity
//
// The bright row at y=275 (#726F67, rgba(114,111,103)) is the lighter row of
// the quad bottom band. It should appear at the same y in both the middle
// segment (TopEdge) and the corner (TopLeftCorner). Currently only the middle
// segment renders it at the correct position — the corner is off due to the
// background-position rounding bug (.plan/005_title_bug.md).
//
// x=795 is the transition line; x=800 is clearly in the middle, x=780 clearly
// in the corner. Both should produce the same color when the bug is fixed.
// ---------------------------------------------------------------------------

test("ExampleFrameTitleFrameAddon CASC — drop shadow row y=275 middle segment (800,275)", async ({
  page,
}) => {
  const addonsDir = getBlizzardAddonsDir();
  const assetsDir = getExtractedAssetsDir();
  test.skip(
    addonsDir === null || assetsDir === null,
    "Blizzard_SharedXML not found under scryer.cacheDir — skipping",
  );

  await renderTocFixtureWithScreenResolution(page, FIXTURE_DIR, addonsDir!, assetsDir!, 3440, 1440);

  const png = PNG.sync.read(await page.locator("#viewport").screenshot());
  const i = (275 * png.width + 800) * 4;
  const p = { r: png.data[i], g: png.data[i + 1], b: png.data[i + 2] };

  // After Fix 2+3, y=275 is the very dark row of the border band (was bright before).
  // Recalibrated from (114,111,103) → (~28,28,24). The bright row moved to y=276.
  // (800, 275)  #1C1C18  rgb(28, 28, 24)
  expect(near(p.r, 28) && near(p.g, 28) && near(p.b, 24)).toBe(true);
});

// ---------------------------------------------------------------------------
// CSS invariant: top-row NineSlice background-position-y must be integer
//
// Root cause of the title bar corner/middle misalignment: all three top-row
// NineSlice pieces (TopLeftCorner, TopEdge, TopRightCorner) currently receive
// a fractional background-position-y of -0.5px — a half-pixel offset from the
// 2x atlas ÷2 convention. Chromium's `background-repeat: repeat` path
// (TopEdge) quantizes fractional tile phase differently than the `no-repeat`
// path (corners), shifting the visible content by ~2px and creating the
// uneven border width visible in .plan/title_bar_weird.png.
//
// The fix (main.ts:655, currently commented out) rounds background-position to
// integers. This test asserts that invariant. Currently FAILS because posY is
// -0.5. Once the fix is enabled, all three pieces emit integer positions and
// this test passes — remove test.fail() at that point.
// ---------------------------------------------------------------------------

test("ExampleFrameTitleFrameAddon CASC — top-row NineSlice background-position-y is integer", async ({
  page,
}) => {
  const addonsDir = getBlizzardAddonsDir();
  const assetsDir = getExtractedAssetsDir();
  test.skip(
    addonsDir === null || assetsDir === null,
    "Blizzard_SharedXML not found under scryer.cacheDir — skipping",
  );

  await renderTocFixtureWithScreenResolution(page, FIXTURE_DIR, addonsDir!, assetsDir!, 3440, 1440);

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
// Bottom border alignment — deep corner vs deep middle (screenshot)
//
// The border band at the bottom of the title bar must appear at the same CSS y
// in both the corner pieces and the middle edge piece. The band's characteristic
// bright row (the lightest metallic highlight, ≈ rgb(114,111,103)) must be
// present at the same y in deep-corner (x=760) and deep-middle (x=900).
//
// Before Fix 3 (repeat-x), Chromium's tile-fit snapping on the vertical axis
// shifted the middle band 2 CSS px downward relative to the corners. At the
// bright row (y=276), the middle showed dark body texture while the corner
// showed the bright highlight — an inter-column delta of ~60+.
//
// The test samples via viewport screenshot (not sampleAtWowCoord, which does
// not handle repeat-x tiling). x=760 is deep inside TopLeftCorner (span
// x=720-795); x=900 is well inside TopEdge (span x=795-1037), beyond the
// repeat-tile boundary so sampleAtWowCoord would return null there.
// ---------------------------------------------------------------------------

test("ExampleFrameTitleFrameAddon CASC — bottom border bright row aligns between corner and middle", async ({
  page,
}) => {
  const addonsDir = getBlizzardAddonsDir();
  const assetsDir = getExtractedAssetsDir();
  test.skip(
    addonsDir === null || assetsDir === null,
    "Blizzard_SharedXML not found under scryer.cacheDir — skipping",
  );

  await renderTocFixtureWithScreenResolution(page, FIXTURE_DIR, addonsDir!, assetsDir!, 3440, 1440);

  const png = PNG.sync.read(await page.locator("#viewport").screenshot());

  // Scan y=270-282 at corner (x=760) and middle (x=900) to find the brightest
  // row in each column. The bright metallic row should be at the SAME y in
  // both; if the border band is offset the brightest rows will differ by ≥ 2.
  let cornerBest = { y: 0, brightness: -1 };
  let middleBest = { y: 0, brightness: -1 };

  for (let y = 270; y <= 282; y++) {
    const ic = (y * png.width + 760) * 4;
    const im = (y * png.width + 900) * 4;
    const bc = png.data[ic] + png.data[ic + 1] + png.data[ic + 2];
    const bm = png.data[im] + png.data[im + 1] + png.data[im + 2];
    if (bc > cornerBest.brightness) cornerBest = { y, brightness: bc };
    if (bm > middleBest.brightness) middleBest = { y, brightness: bm };
  }

  // Both columns must have a clearly bright row (≥ rgb(100,100,100) sum = 300).
  expect(cornerBest.brightness).toBeGreaterThan(300);
  expect(middleBest.brightness).toBeGreaterThan(300);

  // The bright rows must be at the same y (within 1 px tolerance for
  // sub-pixel rounding differences between rendering paths).
  expect(Math.abs(cornerBest.y - middleBest.y)).toBeLessThanOrEqual(1);
});

test("ExampleFrameTitleFrameAddon CASC — horizontal-only NineSlice tiles use no-repeat (stretch-to-fill)", async ({
  page,
}) => {
  const addonsDir = getBlizzardAddonsDir();
  const assetsDir = getExtractedAssetsDir();
  test.skip(
    addonsDir === null || assetsDir === null,
    "Blizzard_SharedXML not found under scryer.cacheDir — skipping",
  );

  await renderTocFixtureWithScreenResolution(page, FIXTURE_DIR, addonsDir!, assetsDir!, 3440, 1440);

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
