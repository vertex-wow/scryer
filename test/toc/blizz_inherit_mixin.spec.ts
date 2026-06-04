/**
 * TOC live view test — BlizzInheritMixinAddon (non-CASC)
 *
 * Guard path: without Blizzard Lua loaded, NineSlicePanelTemplate is unresolved
 * so its OnLoad never fires. Only the inline BACKGROUND texture renders; no
 * NineSlice pieces are created and no crash occurs.
 *
 * The CASC variant (test/toc-casc/blizz_inherit_mixin.spec.ts) runs with Blizzard
 * Lua loaded and asserts all nine pieces are created via template inheritance.
 *
 * Complements test/toc/nineslice_util.spec.ts (direct Lua call path) by covering
 * the XML template inheritance → NineSlicePanelMixin path separately.
 *
 * Fixture: test/fixtures/BlizzInheritMixinAddon/
 */

import { test, expect } from "@playwright/test";
import { resolve } from "path";
import { renderTocFixture, queryRendered, VIEWPORT } from "./helpers";

const FIXTURE_DIR = resolve(__dirname, "../fixtures/BlizzInheritMixinAddon");

// ---------------------------------------------------------------------------
// Frame geometry
// ---------------------------------------------------------------------------

test("BlizzInheritMixinAddon — frame geometry", async ({ page }) => {
  await renderTocFixture(page, FIXTURE_DIR);

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
// Guard path: only background texture present (NineSlicePanelTemplate unresolved)
// ---------------------------------------------------------------------------

test("BlizzInheritMixinAddon — only bg texture when Blizzard absent", async ({ page }) => {
  await renderTocFixture(page, FIXTURE_DIR);

  const texCount = await page.evaluate(
    () => document.querySelectorAll('[data-kind="Texture"]').length,
  );
  // 1: the inline BACKGROUND texture. NineSlicePanelTemplate unresolved → no pieces.
  expect(texCount).toBe(1);
});

// ---------------------------------------------------------------------------
// Background texture color
// ---------------------------------------------------------------------------

test("BlizzInheritMixinAddon — background texture color", async ({ page }) => {
  await renderTocFixture(page, FIXTURE_DIR);

  const bgStyle = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(
      '[data-layer="BACKGROUND"] [data-kind="Texture"]',
    );
    return el ? el.style.background : null;
  });
  expect(bgStyle).not.toBeNull();
  // Color r=0, g=0, b=0, a=0.5 → rgba(0, 0, 0, 0.5)
  expect(bgStyle).toMatch(/rgba\(0,\s*0,\s*0,\s*0\.5\)/);
});

// ---------------------------------------------------------------------------
// FontString text present (inline text attr, no Blizzard font resolution needed)
// ---------------------------------------------------------------------------

test("BlizzInheritMixinAddon — FontString text present", async ({ page }) => {
  await renderTocFixture(page, FIXTURE_DIR);

  const text = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-kind="FontString"] span');
    return el?.textContent ?? null;
  });
  expect(text).toBe("Example Tooltip Frame");
});

// ---------------------------------------------------------------------------
// $parentTitle name substitution — resolves to ExampleFrameTooltipTitle
// ---------------------------------------------------------------------------

test("BlizzInheritMixinAddon — $parentTitle resolves to ExampleFrameTooltipTitle", async ({
  page,
}) => {
  await renderTocFixture(page, FIXTURE_DIR);

  const rendered = await queryRendered(page);
  const title = rendered.find((el) => el.name === "ExampleFrameTooltipTitle");
  expect(title).toBeDefined();
});
