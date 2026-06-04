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
import {
  runTocFixtureWithBlizzard,
  renderTocFixtureWithBlizzard,
  getBlizzardAddonsDir,
  queryRendered,
  VIEWPORT,
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

  // TopLeft ↔ Middle seam: all 4 boundary-point coordinates must match.
  // topRight.x == Middle.topLeft.x, topRight.y == Middle.topLeft.y
  expect(topLeft.left + topLeft.width).toBe(middle.left);
  expect(topLeft.top).toBe(middle.top);
  // bottomRight.y == Middle.bottomLeft.y  (x already checked above)
  expect(topLeft.top + topLeft.height).toBe(middle.top + middle.height);

  // Middle ↔ TopRight seam: all 4 boundary-point coordinates must match.
  // Middle.topRight.x == topRight.topLeft.x, same y
  expect(middle.left + middle.width).toBe(topRight.left);
  expect(middle.top).toBe(topRight.top);
  // Middle.bottomRight.y == topRight.bottomLeft.y  (x already checked above)
  expect(middle.top + middle.height).toBe(topRight.top + topRight.height);
});
