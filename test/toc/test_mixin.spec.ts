/**
 * TOC live view test — MixinAddon
 *
 * Regression guard for the Mixin() + parentKey + SetText/SetTextColor chain:
 *   1. Lua file loaded → MixinExampleFrameMixin defined
 *   2. XML OnLoad runs → Mixin(self, MixinExampleFrameMixin) + self:OnLoad()
 *   3. Mixin OnLoad: self.TitleText:SetText("Hello from Mixin!")
 *                    self.TitleText:SetTextColor(1, 0.82, 0)
 *
 * The fallback text "(mixin not applied)" is intentional: it stays visible in
 * the rendered frame if any step in the chain breaks, making the failure
 * immediately obvious from a single assertion.
 *
 * Fixture: test/fixtures/MixinAddon/
 */

import { test, expect } from "@playwright/test";
import { resolve } from "path";
import { renderTocFixture, queryRendered, VIEWPORT } from "./helpers";

const FIXTURE_DIR = resolve(__dirname, "../fixtures/MixinAddon");

// ---------------------------------------------------------------------------
// Frame geometry
// ---------------------------------------------------------------------------

test("MixinAddon — frame geometry", async ({ page }) => {
  await renderTocFixture(page, FIXTURE_DIR);

  const rendered = await queryRendered(page);
  const frame = rendered.find((f) => f.name === "MixinExampleFrame");
  expect(frame).toBeDefined();
  expect(frame!.width).toBe(300);
  expect(frame!.height).toBe(180);
  // CENTER anchor: left = (uiParentWidth - 300) / 2, top = (uiParentHeight - 180) / 2
  expect(frame!.left).toBe(Math.round(VIEWPORT.w / 2 - 150));
  expect(frame!.top).toBe(VIEWPORT.h / 2 - 90);
});

// ---------------------------------------------------------------------------
// Mixin text — sentinel must be replaced
// ---------------------------------------------------------------------------

test("MixinAddon — mixin SetText replaces sentinel", async ({ page }) => {
  await renderTocFixture(page, FIXTURE_DIR);

  const text = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-kind="FontString"] span');
    return el?.textContent ?? null;
  });
  expect(text).toBe("Hello from Mixin!");
});

// ---------------------------------------------------------------------------
// Mixin color — gold applied via SetTextColor
// ---------------------------------------------------------------------------

test("MixinAddon — mixin SetTextColor applies gold", async ({ page }) => {
  await renderTocFixture(page, FIXTURE_DIR);

  // SetTextColor(1, 0.82, 0) → rgb(255, 209, 0)
  // Chromium normalises rgba(...,1) → rgb(...) on readback.
  const color = await page.evaluate(() => {
    const span = document.querySelector<HTMLElement>('[data-kind="FontString"] span');
    return span?.style.color ?? null;
  });
  expect(color).toBe("rgb(255, 209, 0)");
});

// ---------------------------------------------------------------------------
// Background texture present
// ---------------------------------------------------------------------------

test("MixinAddon — background texture rendered", async ({ page }) => {
  await renderTocFixture(page, FIXTURE_DIR);

  const bgStyle = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(
      '[data-layer="BACKGROUND"] [data-kind="Texture"]',
    );
    return el
      ? { width: el.style.width, height: el.style.height, background: el.style.background }
      : null;
  });
  expect(bgStyle).not.toBeNull();
  // Color r=0.08 g=0.08 b=0.12 a=0.95 → rgba(20, 20, 31, 0.95)
  expect(bgStyle!.background).toMatch(/rgba\(20,\s*20,\s*31,\s*0\.95\)/);
  expect(bgStyle!.width).toBe("300px");
  expect(bgStyle!.height).toBe("180px");
});
