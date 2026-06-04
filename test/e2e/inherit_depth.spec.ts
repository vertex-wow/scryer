/**
 * E2E pipeline test — inherit_depth.xml
 * No CASC, no file assets. Covers multi-level template inheritance.
 *
 * Covers:
 *   - Two-level chain: InheritDepthBase → InheritDepthMid → ConcreteFrame
 *   - Grandparent size (80x40) propagates through intermediate to concrete frame
 *   - Grandparent BACKGROUND layer merges with mid-level ARTWORK layer
 *   - Named FontString from intermediate template present and correctly positioned
 *   - No requestAsset for solid-color-only frames
 */

import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { parseXmlFile, resolveInheritance } from "../../src/parser";
import { renderFrames, queryRendered } from "../webview/helpers";

function parseFixture(): Record<string, unknown>[] {
  const xmlPath = resolve(__dirname, "inherit_depth.xml");
  const doc = parseXmlFile(xmlPath, readFileSync(xmlPath, "utf8"));
  const [resolved] = resolveInheritance([doc]);
  return resolved.frames as unknown as Record<string, unknown>[];
}

test("inherit_depth.xml — grandparent size and position", async ({ page }) => {
  await renderFrames(page, parseFixture());

  const rendered = await queryRendered(page);
  const frame = rendered.find((f) => f.name === "ConcreteFrame");
  expect(frame).toBeDefined();
  // Size comes from InheritDepthBase via InheritDepthMid
  expect(frame!.width).toBe(80);
  expect(frame!.height).toBe(40);
  // TOPLEFT x=10 y=-10 → left=10 top=10
  expect(frame!.left).toBe(10);
  expect(frame!.top).toBe(10);
});

test("inherit_depth.xml — grandparent BACKGROUND texture in concrete frame", async ({ page }) => {
  await renderFrames(page, parseFixture());

  const texStyle = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(
      '[data-name="ConcreteFrame"] [data-layer="BACKGROUND"] [data-kind="Texture"]',
    );
    return el ? { background: el.style.background } : null;
  });

  // Solid fill from InheritDepthBase: r=1 g=0.2 b=0.2 → rgb(255, 51, 51)
  expect(texStyle).not.toBeNull();
  expect(texStyle!.background).toBe("rgb(255, 51, 51)");
});

test("inherit_depth.xml — mid-template FontString present and positioned", async ({ page }) => {
  await renderFrames(page, parseFixture());

  const rendered = await queryRendered(page);
  const label = rendered.find((el) => el.name === "MidLabel");
  expect(label).toBeDefined();
  expect(label!.kind).toBe("FontString");
  expect(label!.text).toBe("FromMid");
  // Centered in 80x40 frame with Size 80x20: left=(80-80)/2=0, top=(40-20)/2=10
  expect(label!.left).toBe(0);
  expect(label!.top).toBe(10);
  expect(label!.width).toBe(80);
  expect(label!.height).toBe(20);
});

test("inherit_depth.xml — no requestAsset for solid-color frame", async ({ page }) => {
  await renderFrames(page, parseFixture());

  const messages = await page.evaluate(
    () => (window as Window & { _vscodeMessages: unknown[] })._vscodeMessages,
  );
  const assetReqs = (messages as Array<{ type: string }>).filter((m) => m.type === "requestAsset");
  expect(assetReqs).toHaveLength(0);
});
