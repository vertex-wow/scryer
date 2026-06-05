/**
 * TOC live view test — ExampleFrameTitleFrameMockAddon (non-CASC, mock template)
 *
 * Runs without CASC assets. A minimal MockDefaultPanel.xml is loaded before the
 * real frame XML so DefaultPanelTemplate resolves against the mock definition.
 * MockDefaultPanelMixin.lua provides SetTitle() — the same method the real
 * ButtonFrameTemplateMixin exposes — wired up via parentKey="TitleText".
 *
 * Purpose: verify the full machinery end-to-end (template resolution → mixin
 * application → SetTitle → SetText → DOM) without requiring CASC assets. Fast
 * CI path. Failures here point to the template/mixin pipeline; failures only in
 * the CASC variant (test/toc-casc/title_frame.spec.ts) point to the real
 * Blizzard template structure diverging from the mock.
 *
 * Fixture: test/fixtures/ExampleFrameTitleFrameMockAddon/
 */

import { test, expect } from "@playwright/test";
import { resolve } from "path";
import { runTocFixture, renderTocFixture, queryRendered, VIEWPORT } from "./helpers";

const FIXTURE_DIR = resolve(__dirname, "../fixtures/ExampleFrameTitleFrameMockAddon");

// ---------------------------------------------------------------------------
// Frame geometry
// ---------------------------------------------------------------------------

test("ExampleFrameTitleFrameMockAddon — frame geometry", async ({ page }) => {
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
// Mock DefaultPanelTemplate resolved — TitleText FontString created
// ---------------------------------------------------------------------------

test("ExampleFrameTitleFrameMockAddon — $parentTitleText FontString created", async ({ page }) => {
  await renderTocFixture(page, FIXTURE_DIR);

  const rendered = await queryRendered(page);
  // $parentTitleText expands to ExampleFrameTitleFrameTitleText
  const titleFs = rendered.find((e) => e.name === "ExampleFrameTitleFrameTitleText");
  expect(titleFs).toBeDefined();
  expect(titleFs!.kind).toBe("FontString");
});

// ---------------------------------------------------------------------------
// SetTitle() wired up — title text reaches the FontString
// ---------------------------------------------------------------------------

test("ExampleFrameTitleFrameMockAddon — SetTitle sets TitleText FontString text", async ({
  page,
}) => {
  await renderTocFixture(page, FIXTURE_DIR);

  const rendered = await queryRendered(page);
  const titleFs = rendered.find((e) => e.name === "ExampleFrameTitleFrameTitleText");
  expect(titleFs).toBeDefined();
  expect(titleFs!.text).toBe("Example Title Frame");
});
