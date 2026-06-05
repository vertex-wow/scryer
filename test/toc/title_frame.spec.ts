/**
 * TOC live view test — ExampleFrameTitleFrameAddon (non-CASC)
 *
 * Guard path: DefaultPanelTemplate is an XML-only Blizzard template loaded via
 * loadBlizzardTemplates() in production. The test helpers do not load it, so
 * the template is unresolved and no template children are injected.
 *
 * SetTitle() is not on FrameMT and DefaultPanelTemplate's mixin is absent, so
 * calling it from Lua produces a runtime error that the TOC runner swallows.
 * The frame itself is still created correctly.
 *
 * To add a CASC variant (test/toc-casc/title_frame.spec.ts), the toc-casc
 * helpers would need to also load blizzardTemplates (Blizzard XML templates)
 * so that DefaultPanelTemplate resolves and SetTitle wires up the title
 * FontString. Currently toc-casc helpers only load Blizzard Lua files.
 *
 * Fixture: test/fixtures/ExampleFrameTitleFrameAddon/
 */

import { test, expect } from "@playwright/test";
import { resolve } from "path";
import { runTocFixture, renderTocFixture, queryRendered, VIEWPORT } from "./helpers";

const FIXTURE_DIR = resolve(__dirname, "../fixtures/ExampleFrameTitleFrameAddon");

// ---------------------------------------------------------------------------
// Frame geometry
// ---------------------------------------------------------------------------

test("ExampleFrameTitleFrameAddon — frame geometry", async ({ page }) => {
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

test("ExampleFrameTitleFrameAddon — no template content when Blizzard absent", async () => {
  const frames = await runTocFixture(FIXTURE_DIR);

  const main = frames.find((f) => f.name === "ExampleFrameTitleFrame");
  expect(main).toBeDefined();

  // DefaultPanelTemplate unresolved: no child frames injected by template
  expect(main!.children).toHaveLength(0);

  // No inline textures or FontStrings in the XML either
  const layerObjectCount = main!.layers.flatMap((l) => l.objects).length;
  expect(layerObjectCount).toBe(0);
});
