/**
 * TOC live view test — TitleFrameAddon (non-CASC)
 *
 * Guard path: DefaultPanelTemplate is an XML-only Blizzard template loaded via
 * loadBlizzardTemplates() in production. The test helpers do not load it, so
 * the template is unresolved and no template children are injected.
 *
 * SetTitle() is not on FrameMT and DefaultPanelTemplate's mixin is absent in
 * this path, so calling it from Lua produces a runtime error that the TOC
 * runner swallows. This is a limitation of the non-CASC test helper, not
 * expected production behavior — with Blizzard XML templates loaded the call
 * succeeds (see test/toc-casc/title_frame.spec.ts).
 *
 * Fixture: test/fixtures/TitleFrameAddon/
 */

import { test, expect } from "@playwright/test";
import { resolve } from "path";
import { runTocFixture, renderTocFixture, queryRendered, VIEWPORT } from "./helpers";

const FIXTURE_DIR = resolve(__dirname, "../fixtures/TitleFrameAddon");

// ---------------------------------------------------------------------------
// Frame geometry
// ---------------------------------------------------------------------------

test("TitleFrameAddon — frame geometry", async ({ page }) => {
  await renderTocFixture(page, FIXTURE_DIR);

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
// Guard path: DefaultPanelTemplate unresolved — no children, no layer objects
// ---------------------------------------------------------------------------

test("TitleFrameAddon — no template content when Blizzard absent", async () => {
  const errors: string[] = [];
  const frames = await runTocFixture(FIXTURE_DIR, { errors });

  const main = frames.find((f) => f.name === "ExampleFrameTitleFrame");
  expect(main).toBeDefined();

  // DefaultPanelTemplate unresolved: no child frames injected by template
  expect(main!.children).toHaveLength(0);

  // No inline textures or FontStrings in the XML either
  const layerObjectCount = main!.layers.flatMap((l) => l.objects).length;
  expect(layerObjectCount).toBe(0);

  // SetTitle() is absent without DefaultPanelTemplate's mixin — assert the
  // Lua error is emitted so we notice if this path silently changes.
  expect(errors.some((e) => e.includes("SetTitle"))).toBe(true);
});
