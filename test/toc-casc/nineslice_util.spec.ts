/**
 * TOC live view test — NineSliceUtilAddon (CASC)
 *
 * Requires scryer.cacheDir in dev/settings.local.json with
 * Interface/AddOns/Blizzard_SharedXML/ present. Errors as misconfigured otherwise.
 *
 * Verifies the happy path: with Blizzard Lua loaded, NineSliceUtil.ApplyLayout
 * runs successfully and creates all nine NineSlice piece textures. Complements
 * the non-CASC spec (test/toc/nineslice_util.spec.ts) which only tests the
 * guard/baseline path.
 *
 * Assertions:
 *   1. Frame geometry — same as non-CASC (sanity check pipeline runs end-to-end)
 *   2. All 9 NineSlice pieces created (SetAtlas called on each)
 *   3. requestAsset messages emitted for Tooltip-NineSlice-* atlas keys
 *
 * Fixture: test/fixtures/NineSliceUtilAddon/
 */

import { test, expect } from "@playwright/test";
import { resolve } from "path";
import {
  renderTocFixtureWithBlizzard,
  getBlizzardAddonsDir,
  queryRendered,
  VIEWPORT,
} from "./helpers";

const FIXTURE_DIR = resolve(__dirname, "../fixtures/NineSliceUtilAddon");

function normPath(p: string) {
  return p.replace(/\\/g, "/").toLowerCase();
}

// ---------------------------------------------------------------------------
// Frame geometry
// ---------------------------------------------------------------------------

test("NineSliceUtilAddon CASC — frame geometry", async ({ page }) => {
  const addonsDir = getBlizzardAddonsDir();

  await renderTocFixtureWithBlizzard(page, FIXTURE_DIR, addonsDir!);

  const rendered = await queryRendered(page);
  const frame = rendered.find((f) => f.name === "TestNineSliceUtil");
  expect(frame).toBeDefined();
  expect(frame!.width).toBe(240);
  expect(frame!.height).toBe(160);
  expect(frame!.left).toBe(Math.round(VIEWPORT.w / 2 - 120));
  expect(frame!.top).toBe(VIEWPORT.h / 2 - 80);
});

// ---------------------------------------------------------------------------
// All 9 NineSlice pieces created (10 textures total including XML bg)
// ---------------------------------------------------------------------------

test("NineSliceUtilAddon CASC — 9 NineSlice pieces created", async ({ page }) => {
  const addonsDir = getBlizzardAddonsDir();

  await renderTocFixtureWithBlizzard(page, FIXTURE_DIR, addonsDir!);

  const texCount = await page.evaluate(
    () => document.querySelectorAll('[data-kind="Texture"]').length,
  );
  // 9 NineSlice pieces (BORDER layer) + 1 XML background = 10 total
  expect(texCount).toBe(10);
});

// ---------------------------------------------------------------------------
// requestAsset messages emitted after atlas resolution
// ---------------------------------------------------------------------------

test("NineSliceUtilAddon CASC — requestAsset emitted for NineSlice atlas sheet(s)", async ({
  page,
}) => {
  const addonsDir = getBlizzardAddonsDir();

  await renderTocFixtureWithBlizzard(page, FIXTURE_DIR, addonsDir!);

  const messages = await page.evaluate(
    () => (window as Window & { _vscodeMessages: unknown[] })._vscodeMessages,
  );
  const assetPaths = (messages as Array<{ type: string; path?: string }>)
    .filter((m) => m.type === "requestAsset")
    .map((m) => normPath(m.path ?? "").toLowerCase());

  // NineSlice pieces resolve via atlas manifest to sprite-sheet BLP paths
  // (e.g. interface/tooltips/uiframetooltip.blp). At least one requestAsset
  // must be emitted and all paths must be WoW Interface paths.
  expect(assetPaths.length).toBeGreaterThan(0);
  expect(assetPaths.every((p) => p.startsWith("interface/"))).toBe(true);
});
