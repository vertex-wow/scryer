/**
 * TOC live view test — BottomTabsAddon (CASC)
 *
 * Requires scryer.cacheDir in dev/settings.local.json with
 * Interface/AddOns/Blizzard_SharedXML/ present and an atlas manifest derived
 * from the same cache.
 *
 * Guards two regressions in PanelTabButtonTemplate rendering:
 *
 * 1. Tab width: TextureMT:GetWidth() must return the atlas logical pixel size
 *    after SetAtlas(name, true). PanelTemplates_TabResize uses tab.Left:GetWidth()
 *    to compute the minimum tab width (sideWidths = left + right cap widths).
 *    If GetWidth() returns 0, the tab is sized to TAB_SIDES_PADDING (20px) instead
 *    of at least MIN_TAB_WIDTH (70px), and the cap textures overflow, leaving the
 *    center tile with a negative computed width (invisible gap in the middle).
 *
 * 2. Middle section rendered: with a correctly-sized tab, the horizTile center
 *    texture (MiddleActive / Middle) must have positive width in the layout.
 *
 * Fixture: test/fixtures/BottomTabsAddon/
 */

import { test, expect } from "@playwright/test";
import { resolve } from "path";
import { renderTocFixtureWithBlizzard, getBlizzardAddonsDir, queryRendered } from "./helpers";

const FIXTURE_DIR = resolve(__dirname, "../fixtures/BottomTabsAddon");
const MIN_TAB_WIDTH = 70;

// ---------------------------------------------------------------------------
// Tab button width — guards GetWidth() returning atlas size
// ---------------------------------------------------------------------------

test("BottomTabsAddon — AlphaTab width respects MIN_TAB_WIDTH", async ({ page }) => {
  const addonsDir = getBlizzardAddonsDir();

  await renderTocFixtureWithBlizzard(page, FIXTURE_DIR, addonsDir!);

  const rendered = await queryRendered(page);
  const alphaTab = rendered.find((el) => el.name === "ExampleControlBottomTabsAlphaTab");

  expect(alphaTab).toBeDefined();
  // PanelTemplates_TabResize sets tab:SetWidth(max(sideWidths, MIN_TAB_WIDTH, textWidth+padding)).
  // sideWidths = tab.Left:GetWidth() + tab.Right:GetWidth() = 35 + 37 = 72.
  // minWidth = max(72, MIN_TAB_WIDTH=70) = 72 in practice; the tab must be at least MIN_TAB_WIDTH.
  expect(alphaTab!.width).toBeGreaterThanOrEqual(MIN_TAB_WIDTH);
});

// ---------------------------------------------------------------------------
// Middle section rendered — guards against the center tile gap
// ---------------------------------------------------------------------------

test("BottomTabsAddon — AlphaTab BACKGROUND center tile has positive width", async ({ page }) => {
  const addonsDir = getBlizzardAddonsDir();

  await renderTocFixtureWithBlizzard(page, FIXTURE_DIR, addonsDir!);

  // The horizTile center atlas slice (_uiframe-activetab-center for the selected tab,
  // _uiframe-tab-center for deselected) is stored with tilesH:true in data-atlas-crop.
  // When the tab is correctly sized, layoutByTwoAnchors resolves a positive width for it.
  const centerTileWidth = await page.evaluate(() => {
    const tabEl = document.querySelector<HTMLElement>(
      '[data-name="ExampleControlBottomTabsAlphaTab"]',
    );
    if (!tabEl) return null;

    const textures = Array.from(
      tabEl.querySelectorAll<HTMLElement>('[data-layer="BACKGROUND"] [data-kind="Texture"]'),
    );

    const centerTile = textures.find((el) => {
      try {
        const crop = JSON.parse(el.dataset.atlasCrop ?? "null");
        return crop && crop.tilesH === true;
      } catch {
        return false;
      }
    });

    if (!centerTile) return null;
    return parseInt(centerTile.style.width) || centerTile.offsetWidth;
  });

  expect(centerTileWidth).not.toBeNull();
  expect(centerTileWidth).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// All three tab buttons exist
// ---------------------------------------------------------------------------

test("BottomTabsAddon — all three tab buttons render", async ({ page }) => {
  const addonsDir = getBlizzardAddonsDir();

  await renderTocFixtureWithBlizzard(page, FIXTURE_DIR, addonsDir!);

  const rendered = await queryRendered(page);
  const names = rendered.map((el) => el.name);

  expect(names).toContain("ExampleControlBottomTabsAlphaTab");
  expect(names).toContain("ExampleControlBottomTabsBetaTab");
  expect(names).toContain("ExampleControlBottomTabsGammaTab");
});
