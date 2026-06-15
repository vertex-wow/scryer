/**
 * TOC live view test — DialogBorderTemplateAddon (CASC, local textures)
 *
 * Renders ExampleFrameModalDialog with DialogBorderTemplate resolved via
 * Blizzard XML templates and NineSliceUtil Lua. Local PNG overrides from
 * DialogBorderTemplateAddon/assets/ supply the DiamondMetal sprites and
 * DialogBox background — no CASC-extracted texture files required.
 *
 * Fixture: test/fixtures/DialogBorderTemplateAddon/
 *
 * Why these tests exist:
 * During the TitleFrame seam investigation it became clear that the DiamondMetal
 * atlas (used by DialogBorderTemplate) has physical pixel offsets that are NOT
 * multiples of the atlas scale divisor (4), producing fractional logical CSS coords
 * (e.g. crop.y = 130.25). This exposed two independent rendering bugs:
 *   1. Math.round() was snapping adjacent bgPos values in opposite directions,
 *      causing a 2-physical-pixel stripe phase mismatch at every seam.
 *   2. V-only tiles (LeftEdge/RightEdge) had no upward/downward extension, leaving
 *      a 1-device-pixel transparent gap at the corner/edge boundary.
 * Both bugs were invisible at 1× DPR and only surfaced because the stripe-pattern
 * fixture makes phase misalignment unambiguous. See also:
 * docs/troubleshooting/nineslice_dpr_border_misalignment.md
 */

import { test, expect } from "@playwright/test";
import { resolve } from "path";
import { PNG } from "pngjs";
import { renderTocFixtureWithLocalAssets, getBlizzardAddonsDir } from "./helpers";

const FIXTURE_DIR = resolve(__dirname, "../fixtures/DialogBorderTemplateAddon");

// ---------------------------------------------------------------------------
// Guard: all 8 NineSlice border pieces must have background-image resolved
//
// DialogBorderTemplate → DialogBorderNoCenterTemplate → NineSlicePanelTemplate
// with layoutType="Dialog". NineSliceUtil.ApplyLayout creates 8 textures in
// the BORDER layer (no Center piece in the Dialog layout).
//
// If injectLocalAssets() fails to match a requestAsset path, the element
// stays transparent and the pixel tests below fail for the wrong reason.
// This test makes the failure mode explicit.
// ---------------------------------------------------------------------------

test("DialogBorderTemplateAddon — 8 border NineSlice pieces have background-image", async ({
  page,
}) => {
  const addonsDir = getBlizzardAddonsDir();
  await renderTocFixtureWithLocalAssets(page, FIXTURE_DIR, addonsDir!, 1024, 768);

  const pieces = await page.evaluate(() => {
    const frameEl = document.querySelector<HTMLElement>('[data-name="ExampleFrameModalDialog"]');
    if (!frameEl) return null;
    return Array.from(
      frameEl.querySelectorAll<HTMLElement>('[data-layer="BORDER"] [data-kind="Texture"]'),
    ).map((el) => getComputedStyle(el).backgroundImage);
  });

  expect(pieces).not.toBeNull();
  expect(pieces!.length).toBe(8);
  for (const bg of pieces!) {
    expect(bg).not.toBe("none");
  }
});

// ---------------------------------------------------------------------------
// Seam alignment — top NineSlice row corner coordinates
//
// The Dialog NineSlice has 8 pieces (no Center) in the BORDER layer. The top
// row is 3 pieces: TopLeftCorner, TopEdge, TopRightCorner. Verify that each
// adjacent pair shares all four boundary-point coordinates (x seam, top-y,
// bottom-y), and that the seam-bleed 1px overlap is applied correctly.
// ---------------------------------------------------------------------------

test("DialogBorderTemplateAddon — top-row NineSlice seam alignment", async ({ page }) => {
  const addonsDir = getBlizzardAddonsDir();
  await renderTocFixtureWithLocalAssets(page, FIXTURE_DIR, addonsDir!, 1024, 768);

  const pieces = await page.evaluate(() => {
    const frameEl = document.querySelector<HTMLElement>('[data-name="ExampleFrameModalDialog"]');
    if (!frameEl) return null;
    return Array.from(
      frameEl.querySelectorAll<HTMLElement>('[data-layer="BORDER"] [data-kind="Texture"]'),
    ).map((el) => ({
      left: parseInt(el.style.left),
      top: parseInt(el.style.top),
      width: parseInt(el.style.width),
      height: parseInt(el.style.height),
    }));
  });

  expect(pieces).not.toBeNull();
  expect(pieces!.length).toBe(8);

  const minTop = Math.min(...pieces!.map((p) => p.top));
  const topRow = pieces!.filter((p) => p.top === minTop).sort((a, b) => a.left - b.left);

  expect(topRow.length).toBe(3);

  const [topLeft, middle, topRight] = topRow;

  // TopLeft <-> TopEdge: 1px seam-bleed overlap, vertical bounds match.
  expect(middle.left).toBe(topLeft.left + topLeft.width - 1);
  expect(topLeft.top).toBe(middle.top);
  expect(topLeft.top + topLeft.height).toBe(middle.top + middle.height);

  // TopEdge <-> TopRight: 1px seam-bleed overlap, vertical bounds match.
  expect(middle.left + middle.width).toBe(topRight.left + 1);
  expect(middle.top).toBe(topRight.top);
  expect(middle.top + middle.height).toBe(topRight.top + topRight.height);
});

// ---------------------------------------------------------------------------
// Pixel continuity — border stripes continuous across all corner/edge seams
//
// Each corner has horizontal and vertical bar extrusions that must carry the
// same flat stripe pattern as the adjacent horizontal (TopEdge / BottomEdge)
// and vertical (LeftEdge / RightEdge) pieces. At each seam, 30 consecutive
// pixels (15 inside the corner bar + 15 inside the edge) must match per
// stripe row (horizontal seams) or per stripe column (vertical seams).
//
// Reference pixel for H-seams: 8 px into the edge interior from the boundary.
// Reference pixel for V-seams: 20 px into the edge interior (deeper to avoid
//   the blended transition zone in the diagonal-stripe fixture texture).
// The corners' decorative interior artwork is excluded from the scan window.
//
// One render, one screenshot, all seam checks.
//
// ─────────────────────────────────────────────────────────────────────────
// Fixes applied to make these tests pass (do not revert without understanding
// the root cause — each fix addresses a separate independent failure mode)
// ─────────────────────────────────────────────────────────────────────────
//
// [FIXED] top-left-V, bot-left-V — V-seam air gap (renderer.ts seamBleedV)
//   LeftEdge's CSS rect started at exactly seamY with no upward extension.
//   Under uiScale 1.40625 (1080/768) the 1-device-pixel row at the seam
//   boundary belonged to neither the corner nor the edge, appearing as a
//   transparent gap in the screenshot. Fix: seamBleedV = 1 in renderer.ts
//   extends V-only atlas tiles 1 CSS px up and 1 CSS px down, mirroring the
//   existing H-tile seamBleed. V tiles are y-uniform (same x-gradient column
//   regardless of y), so the overlap rows are visually identical to main
//   content. REVERTING seamBleedV reintroduces this transparent gap.
//
// [FIXED] top-left-H, bot-right-H — H-seam stripe row offset (main.ts bgPos)
//   DiamondMetal physical atlas y-coords are not multiples of the scale
//   divisor (4). CornerTopLeft: physical y=521 → logical 130.25; EdgeTop:
//   physical y=131 → logical 32.75. Math.round() snapped these in opposite
//   directions: round(−130.25)=−130 (physical row 520) vs round(−32.75)=−33
//   (physical row 132). Net mismatch = 2 physical pixels = visible stripe row
//   offset. Fix: exact fractional bgPos in main.ts. −130.25 CSS px × 4 =
//   physical row 521 exactly — no bilinear blending at an integer coordinate.
//   REVERTING to Math.round reintroduces the stripe offset at H-seams.
//
// [FIXED] top-right-V, bot-right-V — V-seam stripe column offset (same root)
//   RightEdge crop.x = 32.75 → Math.round(−32.75) = −33 (physical col 132);
//   CornerTopRight crop.x = 0.25 → Math.round(−0.25) = 0 (physical col 0).
//   Same fix: exact fractional bgPosX lands on physical col 131 and 1.
//   REVERTING causes the right-side V-seam stripe columns to misalign.
//
// ─────────────────────────────────────────────────────────────────────────
// Known observation — outer black border is sub-pixel at default scale
// ─────────────────────────────────────────────────────────────────────────
//
//   Physical col/row 0 of the DiamondMetal atlas is TRANSPARENT in both the
//   fixture and real CASC textures — there is no border content there. The
//   outer black border lives at physical row ~155 for vertical-axis pieces
//   (24 physical rows = 6 logical units inside the crop, not at the crop
//   boundary). bgPos is correct; no renderer fix is needed.
//
//   At default uiScale=1.40625 and div=4, 1 physical row = 0.352 CSS px
//   (sub-pixel). With nearest-neighbor sampling the single black row often
//   falls between sampled positions and is invisible. Making the surrounding
//   anti-aliased approach rows (~144–154) fully opaque ensures nearest-
//   neighbor catches several of them, producing ~4 visible CSS px of border.
//   This is a texture/DPR visibility concern, not a renderer bug.
// ─────────────────────────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

test("DialogBorderTemplateAddon — border stripes continuous across all corner/edge seams", async ({
  page,
}) => {
  const addonsDir = getBlizzardAddonsDir();
  await renderTocFixtureWithLocalAssets(page, FIXTURE_DIR, addonsDir!, 1024, 768);

  // Derive all seam positions from the DOM in one evaluate.
  const seams = await page.evaluate(() => {
    const frameEl = document.querySelector<HTMLElement>('[data-name="ExampleFrameModalDialog"]');
    const borderEls = Array.from(
      frameEl!.querySelectorAll<HTMLElement>('[data-layer="BORDER"] [data-kind="Texture"]'),
    );
    const styleTop = (el: HTMLElement) => parseInt(el.style.top);
    const styleLeft = (el: HTMLElement) => parseInt(el.style.left);
    const tops = borderEls.map(styleTop);
    const minTop = Math.min(...tops);
    const maxTop = Math.max(...tops);
    const midTop = [...new Set(tops)].sort((a, b) => a - b)[1];

    const byTop = (v: number) =>
      borderEls.filter((el) => styleTop(el) === v).sort((a, b) => styleLeft(a) - styleLeft(b));

    const topRow = byTop(minTop);
    const midRow = byTop(midTop);
    const botRow = byTop(maxTop);

    const r = (el: HTMLElement) => {
      const rect = el.getBoundingClientRect();
      return {
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        top: Math.round(rect.top),
        bot: Math.round(rect.bottom),
      };
    };

    const topEdge = r(topRow[1]); // TopEdge
    const botEdge = r(botRow[1]); // BottomEdge
    const leftEdge = r(midRow[0]); // LeftEdge
    const rightEdge = r(midRow[1]); // RightEdge

    return {
      // Horizontal seams (scan along x for a fixed y band)
      topLeftH: { seamX: topEdge.left, topY: topEdge.top, botY: topEdge.bot },
      topRightH: { seamX: topEdge.right - 1, topY: topEdge.top, botY: topEdge.bot },
      botLeftH: { seamX: botEdge.left, topY: botEdge.top, botY: botEdge.bot },
      botRightH: { seamX: botEdge.right - 1, topY: botEdge.top, botY: botEdge.bot },
      // Vertical seams (scan along y for a fixed x band)
      topLeftV: { seamY: leftEdge.top, leftX: leftEdge.left, rightX: leftEdge.right },
      topRightV: { seamY: rightEdge.top, leftX: rightEdge.left, rightX: rightEdge.right },
      botLeftV: { seamY: leftEdge.bot, leftX: leftEdge.left, rightX: leftEdge.right },
      botRightV: { seamY: rightEdge.bot, leftX: rightEdge.left, rightX: rightEdge.right },
    };
  });

  // Take a lossless screenshot and decode it.
  const buf = await page.screenshot({ type: "png" });
  const png = PNG.sync.read(buf);

  function getPixel(x: number, y: number): { r: number; g: number; b: number } | null {
    if (x < 0 || x >= png.width || y < 0 || y >= png.height) return null;
    const i = (y * png.width + x) * 4;
    if (png.data[i + 3] < 10) return null; // transparent
    return { r: png.data[i], g: png.data[i + 1], b: png.data[i + 2] };
  }

  const TOL = 25;
  // V-seam tolerance is slightly wider (30) than H-seam (25). At bgPosX = −0.25
  // the semi-transparent outer-border column of LeftEdge/RightEdge (atlas alpha ≈
  // 50%) composites over the checker to ~rgb(12), while the adjacent corner element
  // is transparent at that column → shows checker ~rgb(42). That gives delta = 30
  // at one boundary column. Stripe-interior columns (fully opaque, alpha=255) are
  // all delta ≤ 0 and unaffected by this widening.
  const TOL_V = 30;

  // Horizontal seam: for each row y in [y1,y2), ref is 8 px into the edge
  // interior (edgeDir +1=right, -1=left). Scan x = seamX±15.
  function checkHorizontalSeam(
    seamX: number,
    edgeDir: 1 | -1,
    y1: number,
    y2: number,
    label: string,
  ): string[] {
    const errs: string[] = [];
    for (let y = y1; y < y2; y++) {
      const ref = getPixel(seamX + edgeDir * 8, y);
      if (!ref) continue;
      for (let x = seamX - 15; x < seamX + 15; x++) {
        const c = getPixel(x, y);
        if (
          !c ||
          Math.abs(c.r - ref.r) > TOL ||
          Math.abs(c.g - ref.g) > TOL ||
          Math.abs(c.b - ref.b) > TOL
        ) {
          errs.push(
            `[${label}] row y=${y} x=${x}: got ${c ? `rgb(${c.r},${c.g},${c.b})` : "null"}, expected rgb(${ref.r},${ref.g},${ref.b})`,
          );
        }
      }
    }
    return errs;
  }

  // Vertical seam: for each column x in [x1,x2), ref is 20 px into the edge
  // interior (edgeDir +1=down, -1=up). Scan y = seamY±15.
  // Reference offset is 20 rather than 8 to stay clear of the blended zone
  // immediately adjacent to the seam in the diagonal-stripe texture.
  function checkVerticalSeam(
    seamY: number,
    edgeDir: 1 | -1,
    x1: number,
    x2: number,
    label: string,
  ): string[] {
    const errs: string[] = [];
    for (let x = x1; x < x2; x++) {
      const ref = getPixel(x, seamY + edgeDir * 20);
      if (!ref) continue;
      for (let y = seamY - 15; y < seamY + 15; y++) {
        const c = getPixel(x, y);
        if (
          !c ||
          Math.abs(c.r - ref.r) > TOL_V ||
          Math.abs(c.g - ref.g) > TOL_V ||
          Math.abs(c.b - ref.b) > TOL_V
        ) {
          errs.push(
            `[${label}] col x=${x} y=${y}: got ${c ? `rgb(${c.r},${c.g},${c.b})` : "null"}, expected rgb(${ref.r},${ref.g},${ref.b})`,
          );
        }
      }
    }
    return errs;
  }

  const s = seams;
  const failures = [
    // Horizontal seams
    ...checkHorizontalSeam(s.topLeftH.seamX, +1, s.topLeftH.topY, s.topLeftH.botY, "top-left-H"),
    ...checkHorizontalSeam(
      s.topRightH.seamX,
      -1,
      s.topRightH.topY,
      s.topRightH.botY,
      "top-right-H",
    ),
    ...checkHorizontalSeam(s.botLeftH.seamX, +1, s.botLeftH.topY, s.botLeftH.botY, "bot-left-H"),
    ...checkHorizontalSeam(
      s.botRightH.seamX,
      -1,
      s.botRightH.topY,
      s.botRightH.botY,
      "bot-right-H",
    ),
    // Vertical seams
    ...checkVerticalSeam(s.topLeftV.seamY, +1, s.topLeftV.leftX, s.topLeftV.rightX, "top-left-V"),
    ...checkVerticalSeam(
      s.topRightV.seamY,
      +1,
      s.topRightV.leftX,
      s.topRightV.rightX,
      "top-right-V",
    ),
    ...checkVerticalSeam(s.botLeftV.seamY, -1, s.botLeftV.leftX, s.botLeftV.rightX, "bot-left-V"),
    ...checkVerticalSeam(
      s.botRightV.seamY,
      -1,
      s.botRightV.leftX,
      s.botRightV.rightX,
      "bot-right-V",
    ),
  ];

  expect(failures).toEqual([]);
});
