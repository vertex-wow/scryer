/**
 * TOC live view test — NineSliceUtilAddon (non-CASC)
 *
 * Verifies the guard path: without Blizzard Lua loaded, NineSliceUtil is nil
 * and the OnLoad guard fires silently. Only the XML-defined background texture
 * is present — no crash, no NineSlice pieces.
 *
 * The CASC variant (test/toc-casc/nineslice_util.spec.ts) runs with Blizzard
 * Lua loaded and asserts that all nine pieces are created.
 *
 * Fixture: test/fixtures/NineSliceUtilAddon/
 */

import { test, expect } from "@playwright/test";
import { resolve } from "path";
import { renderTocFixture, queryRendered, VIEWPORT } from "./helpers";

const FIXTURE_DIR = resolve(__dirname, "../fixtures/NineSliceUtilAddon");

// ---------------------------------------------------------------------------
// Frame geometry
// ---------------------------------------------------------------------------

test("NineSliceUtilAddon — frame geometry", async ({ page }) => {
  await renderTocFixture(page, FIXTURE_DIR);

  const rendered = await queryRendered(page);
  const frame = rendered.find((f) => f.name === "TestNineSliceUtil");
  expect(frame).toBeDefined();
  expect(frame!.width).toBe(240);
  expect(frame!.height).toBe(160);
  // CENTER anchor: left = (uiParentWidth - 240) / 2, top = (uiParentHeight - 160) / 2
  expect(frame!.left).toBe(Math.round(VIEWPORT.w / 2 - 120));
  expect(frame!.top).toBe(VIEWPORT.h / 2 - 80);
});

// ---------------------------------------------------------------------------
// Guard path: only background texture present (NineSliceUtil is nil)
// ---------------------------------------------------------------------------

test("NineSliceUtilAddon — only bg texture when NineSliceUtil absent", async ({ page }) => {
  await renderTocFixture(page, FIXTURE_DIR);

  const texCount = await page.evaluate(
    () => document.querySelectorAll('[data-kind="Texture"]').length,
  );
  // Exactly 1: the XML-layer background. NineSliceUtil is nil → guard fires → no pieces created.
  expect(texCount).toBe(1);
});

// ---------------------------------------------------------------------------
// Background texture color
// ---------------------------------------------------------------------------

test("NineSliceUtilAddon — background texture color", async ({ page }) => {
  await renderTocFixture(page, FIXTURE_DIR);

  const bgStyle = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(
      '[data-layer="BACKGROUND"] [data-kind="Texture"]',
    );
    return el ? el.style.background : null;
  });
  expect(bgStyle).not.toBeNull();
  // Color r=0.1 g=0.1 b=0.1 a=0.8 → rgba(26, 26, 26, 0.8)
  expect(bgStyle).toMatch(/rgba\(26,\s*26,\s*26,\s*0\.8\)/);
});
