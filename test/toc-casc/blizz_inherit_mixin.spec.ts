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
