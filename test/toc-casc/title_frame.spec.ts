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
