/**
 * E2E pipeline test — simple_frame.xml
 * No CASC, no file assets. Baseline fixture for the core parse→render path.
 *
 * This file is the canonical regression guard for:
 *   - solid-color texture rendering (color, setAllPoints fill)
 *   - FontString rendering (text, size, position, justify, color)
 *   - no spurious requestAsset on color-only frames
 *
 * When a rendering bug is found in the extension, create a minimal XML that
 * reproduces it alongside a new spec file in test/e2e/, add assertions here,
 * fix until green, and the test becomes a permanent regression guard.
 */

import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { parseXmlFile, resolveInheritance } from "../../src/parser";
import { VIEWPORT, renderFrames, queryRendered } from "../webview/helpers";

function parseFixture(): Record<string, unknown>[] {
  const xmlPath = resolve(__dirname, "simple_frame.xml");
  const doc = parseXmlFile(xmlPath, readFileSync(xmlPath, "utf8"));
  const [resolved] = resolveInheritance([doc]);
  return resolved.frames as unknown as Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// Parse and layout
// ---------------------------------------------------------------------------

test("simple_frame.xml — parse and layout", async ({ page }) => {
  await renderFrames(page, parseFixture());

  // <Frame name="TestFrame"> <Size x="300" y="200"/> <Anchor point="CENTER"/>
  const rendered = await queryRendered(page);
  const frame = rendered.find((f) => f.name === "TestFrame");
  expect(frame).toBeDefined();
  expect(frame!.width).toBe(300);
  expect(frame!.height).toBe(200);
  expect(frame!.left).toBe(Math.round(VIEWPORT.w / 2 - 150));
  expect(frame!.top).toBe(VIEWPORT.h / 2 - 100);

  // Solid-color only — no file textures, no requestAsset expected.
  const messages = await page.evaluate(
    () => (window as Window & { _vscodeMessages: unknown[] })._vscodeMessages,
  );
  const assetReqs = (messages as Array<{ type: string }>).filter((m) => m.type === "requestAsset");
  expect(assetReqs).toHaveLength(0);

  // <FontString text="Hello from Scryer"> in ARTWORK layer (no name attr — query by kind)
  const fontStrText = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-kind="FontString"] span');
    return el?.textContent ?? null;
  });
  expect(fontStrText).toBe("Hello from Scryer");
});

// ---------------------------------------------------------------------------
// Renderer CSS output
// ---------------------------------------------------------------------------

test("simple_frame.xml — renderer CSS output", async ({ page }) => {
  await renderFrames(page, parseFixture());

  // BACKGROUND layer: <Texture setAllPoints="true"> <Color r="0.2" g="0.2" b="0.4" a="1"/>
  // setAllPoints fills the 300×200 frame; color → rgb(51, 51, 102).
  // Chromium normalises rgba(...,1) → rgb(...) on readback.
  const texStyle = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(
      '[data-layer="BACKGROUND"] [data-kind="Texture"]',
    );
    return el
      ? {
          left: el.style.left,
          top: el.style.top,
          width: el.style.width,
          height: el.style.height,
          background: el.style.background,
        }
      : null;
  });
  expect(texStyle?.left).toBe("0px");
  expect(texStyle?.top).toBe("0px");
  expect(texStyle?.width).toBe("300px");
  expect(texStyle?.height).toBe("200px");
  expect(texStyle?.background).toBe("rgb(51, 51, 102)");

  // ARTWORK layer: <FontString justifyH="CENTER" justifyV="MIDDLE">
  const fsJustify = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-kind="FontString"]');
    return el
      ? {
          textAlign: el.style.textAlign,
          justifyContent: el.style.justifyContent,
          alignItems: el.style.alignItems,
        }
      : null;
  });
  expect(fsJustify).toEqual({
    textAlign: "center",
    justifyContent: "center",
    alignItems: "center",
  });

  // <FontString> <Size x="280" y="20"/> <Anchor point="CENTER"/>
  // Centered in 300×200 frame → left = (300−280)/2 = 10, top = (200−20)/2 = 90.
  const fsGeom = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-kind="FontString"]');
    return el
      ? { left: el.style.left, top: el.style.top, width: el.style.width, height: el.style.height }
      : null;
  });
  expect(fsGeom).toEqual({ left: "10px", top: "90px", width: "280px", height: "20px" });

  // <Color r="1" g="0.82" b="0"/> → rgb(255, 209, 0)
  const spanColor = await page.evaluate(() => {
    const span = document.querySelector<HTMLElement>('[data-kind="FontString"] span');
    return span?.style.color ?? null;
  });
  expect(spanColor).toBe("rgb(255, 209, 0)");
});
