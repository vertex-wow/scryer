/**
 * TOC live view test — BlizzInheritMixinAddon (CASC)
 *
 * Requires scryer.cacheDir in dev/settings.local.json with
 * Interface/AddOns/Blizzard_SharedXML/ present. Skips automatically otherwise.
 *
 * Verifies the XML template inheritance path: with Blizzard Lua loaded,
 * NineSlicePanelTemplate resolves and its mixin OnLoad fires, creating all nine
 * NineSlice border pieces from the TooltipDefaultLayout.
 *
 * Complements test/toc-casc/nineslice_util.spec.ts (direct NineSliceUtil.ApplyLayout
 * call from user Lua) by covering the XML template inheritance → NineSlicePanelMixin
 * path as a separate code path with separate coverage.
 *
 * Fixture: test/fixtures/BlizzInheritMixinAddon/
 */

import { test, expect } from "@playwright/test";
import { resolve } from "path";
import {
  renderTocFixtureWithBlizzard,
  getBlizzardAddonsDir,
  queryRendered,
  VIEWPORT,
} from "./helpers";

const FIXTURE_DIR = resolve(__dirname, "../fixtures/BlizzInheritMixinAddon");

function normPath(p: string) {
  return p.replace(/\\/g, "/").toLowerCase();
}

// ---------------------------------------------------------------------------
// Frame geometry
// ---------------------------------------------------------------------------

test("BlizzInheritMixinAddon CASC — frame geometry", async ({ page }) => {
  const addonsDir = getBlizzardAddonsDir();
  test.skip(addonsDir === null, "Blizzard_SharedXML not found under scryer.cacheDir — skipping");

  await renderTocFixtureWithBlizzard(page, FIXTURE_DIR, addonsDir!);

  const rendered = await queryRendered(page);
  const frame = rendered.find((f) => f.name === "ExampleFrameTooltip");
  expect(frame).toBeDefined();
  expect(frame!.width).toBe(240);
  expect(frame!.height).toBe(160);
  // CENTER anchor: left = (uiParentWidth - 240) / 2, top = (uiParentHeight - 160) / 2
  expect(frame!.left).toBe(Math.round(VIEWPORT.w / 2 - 120));
  expect(frame!.top).toBe(VIEWPORT.h / 2 - 80);
});

// ---------------------------------------------------------------------------
// All 9 NineSlice pieces created via NineSlicePanelTemplate inheritance
// ---------------------------------------------------------------------------

test("BlizzInheritMixinAddon CASC — 9 NineSlice pieces created via template inheritance", async ({
  page,
}) => {
  const addonsDir = getBlizzardAddonsDir();
  test.skip(addonsDir === null, "Blizzard_SharedXML not found under scryer.cacheDir — skipping");

  await renderTocFixtureWithBlizzard(page, FIXTURE_DIR, addonsDir!);

  const texCount = await page.evaluate(
    () => document.querySelectorAll('[data-kind="Texture"]').length,
  );
  // 9 NineSlice pieces (BORDER layer via NineSlicePanelMixin OnLoad) + 1 XML background = 10 total
  expect(texCount).toBe(10);
});

// ---------------------------------------------------------------------------
// requestAsset messages emitted after atlas resolution
// ---------------------------------------------------------------------------

test("BlizzInheritMixinAddon CASC — requestAsset emitted for NineSlice atlas sheet(s)", async ({
  page,
}) => {
  const addonsDir = getBlizzardAddonsDir();
  test.skip(addonsDir === null, "Blizzard_SharedXML not found under scryer.cacheDir — skipping");

  await renderTocFixtureWithBlizzard(page, FIXTURE_DIR, addonsDir!);

  const messages = await page.evaluate(
    () => (window as Window & { _vscodeMessages: unknown[] })._vscodeMessages,
  );
  const assetPaths = (messages as Array<{ type: string; path?: string }>)
    .filter((m) => m.type === "requestAsset")
    .map((m) => normPath(m.path ?? "").toLowerCase());

  // NineSlice pieces resolve via atlas manifest to sprite-sheet BLP paths.
  // At least one requestAsset must be emitted and all paths must be WoW Interface paths.
  expect(assetPaths.length).toBeGreaterThan(0);
  expect(assetPaths.every((p) => p.startsWith("interface/"))).toBe(true);
});

// ---------------------------------------------------------------------------
// Title bar (top row) seam alignment — NineSlice corner coordinates
//
// TooltipDefaultLayout has 9 pieces: corners + edges in BORDER layer, Center in
// BACKGROUND. The top row is 3 pieces with no coordinate offsets (corners sit
// flush at the container top edge). Verify adjacent pairs share all 4
// boundary-point coordinates (x seam, top-y, bottom-y).
// ---------------------------------------------------------------------------

test("BlizzInheritMixinAddon CASC — title bar seam alignment", async ({ page }) => {
  const addonsDir = getBlizzardAddonsDir();
  test.skip(addonsDir === null, "Blizzard_SharedXML not found under scryer.cacheDir — skipping");

  await renderTocFixtureWithBlizzard(page, FIXTURE_DIR, addonsDir!);

  // TooltipDefaultLayout corner/edge pieces use BORDER layer; Center uses
  // BACKGROUND. Querying BORDER textures within ExampleFrameTooltip returns
  // exactly the 8 non-Center NineSlice pieces.
  const pieces = await page.evaluate(() => {
    const frameEl = document.querySelector<HTMLElement>('[data-name="ExampleFrameTooltip"]');
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
  // TooltipDefaultLayout: 8 pieces in BORDER (corners + edges; Center is BACKGROUND).
  expect(pieces!.length).toBe(8);

  // Top row = the 3 pieces with the minimum top value. TooltipDefaultLayout has
  // no corner offsets so corners sit flush at top=0 of the NineSlice frame.
  const minTop = Math.min(...pieces!.map((p) => p.top));
  const topRow = pieces!.filter((p) => p.top === minTop).sort((a, b) => a.left - b.left);

  // Must be exactly 3: TopLeftCorner, TopEdge, TopRightCorner.
  expect(topRow.length).toBe(3);

  const [topLeft, middle, topRight] = topRow;

  // TopLeft ↔ Middle seam: Middle extends 1px into TopLeft (seam-bleed overlap).
  expect(middle.left).toBe(topLeft.left + topLeft.width - 1);
  expect(topLeft.top).toBe(middle.top);
  expect(topLeft.top + topLeft.height).toBe(middle.top + middle.height);

  // Middle ↔ TopRight seam: Middle extends 1px into TopRight (seam-bleed overlap).
  expect(middle.left + middle.width).toBe(topRight.left + 1);
  expect(middle.top).toBe(topRight.top);
  expect(middle.top + middle.height).toBe(topRight.top + topRight.height);
});
