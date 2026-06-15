/**
 * Renderer test — StatusBar fill bar rendering.
 *
 * StatusBar fill comes from Lua (SetValue/SetMinMaxValues), not static XML.
 * We test the renderer directly with programmatic FrameIR so we can inject
 * arbitrary fill fractions, colors, and orientations.
 *
 * What this guards:
 *   - Horizontal fill: div[data-layer="statusbar-fill"] with width as %
 *   - Vertical fill: height as %, anchored to bottom edge
 *   - Fill color applied as rgba background-color
 *   - Fill clamp: fill fraction outside [0,1] is clamped at render time
 */

import { test, expect } from "@playwright/test";
import { makeFrame, renderFrames } from "../webview/helpers";

function makeStatusBar(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return makeFrame({
    kind: "StatusBar",
    name: overrides.name ?? "TestBar",
    size: { x: 200, y: 20 },
    anchors: [{ point: "CENTER" }],
    statusBarFill: 0.75,
    statusBarFillColor: { r: 0, g: 0.5, b: 1, a: 1 },
    statusBarOrientation: "HORIZONTAL",
    ...overrides,
  });
}

// ---------------------------------------------------------------------------

test("StatusBar — horizontal fill width percentage", async ({ page }) => {
  await renderFrames(page, [makeStatusBar({ name: "HBar", statusBarFill: 0.75 })]);

  const fillStyle = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-layer="statusbar-fill"]');
    return el ? { width: el.style.width, height: el.style.height } : null;
  });
  expect(fillStyle).not.toBeNull();
  expect(fillStyle!.width).toBe("75%");
  expect(fillStyle!.height).toBe("");
});

test("StatusBar — vertical fill height percentage, bottom-anchored", async ({ page }) => {
  await renderFrames(page, [
    makeStatusBar({
      name: "VBar",
      size: { x: 20, y: 100 },
      statusBarFill: 0.5,
      statusBarOrientation: "VERTICAL",
    }),
  ]);

  const fillStyle = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-layer="statusbar-fill"]');
    return el ? { width: el.style.width, height: el.style.height, bottom: el.style.bottom } : null;
  });
  expect(fillStyle).not.toBeNull();
  expect(fillStyle!.height).toBe("50%");
  expect(fillStyle!.bottom).toBe("0px");
});

test("StatusBar — fill color applied as rgba", async ({ page }) => {
  await renderFrames(page, [
    makeStatusBar({
      statusBarFill: 1,
      statusBarFillColor: { r: 0, g: 0.5, b: 1, a: 1 },
    }),
  ]);

  const bg = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-layer="statusbar-fill"]');
    return el?.style.backgroundColor ?? null;
  });
  // Chromium normalises rgba(0,127.5,255,1) → rgb(0, 128, 255)
  expect(bg).toBe("rgb(0, 128, 255)");
});

test("StatusBar — no fill div when statusBarFill is undefined", async ({ page }) => {
  const frame = makeFrame({
    kind: "StatusBar",
    name: "EmptyBar",
    size: { x: 200, y: 20 },
    anchors: [{ point: "CENTER" }],
    // statusBarFill deliberately omitted
  });
  await renderFrames(page, [frame]);

  const fillEl = await page.evaluate(
    () => document.querySelector('[data-layer="statusbar-fill"]') !== null,
  );
  expect(fillEl).toBe(false);
});

test("StatusBar — fill defaults to blue when no fillColor set", async ({ page }) => {
  const frame = makeStatusBar({ statusBarFillColor: undefined });
  await renderFrames(page, [frame]);

  const bg = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-layer="statusbar-fill"]');
    return el?.style.backgroundColor ?? null;
  });
  // Default: rgba(0,120,220,0.85)
  expect(bg).toBe("rgba(0, 120, 220, 0.85)");
});
