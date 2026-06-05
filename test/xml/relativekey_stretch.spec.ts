/**
 * E2E pipeline test — relativekey_stretch.xml
 * No CASC, no file assets. Covers relativeKey two-anchor stretch layout.
 *
 * Covers:
 *   - relativeKey anchor references between sibling layer objects (parentKey lookup)
 *   - Two-anchor stretch: Middle fills the gap between Left.TOPRIGHT and Right.BOTTOMLEFT
 *   - Template inheritance carrying relativeKey anchors to the concrete frame
 *   - No spurious requestAsset for solid-color-only textures
 */

import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { parseXmlFile, resolveInheritance } from "../../src/parser";
import { VIEWPORT, renderFrames, queryRendered } from "../webview/helpers";

function parseFixture(): Record<string, unknown>[] {
  const xmlPath = resolve(__dirname, "relativekey_stretch.xml");
  const doc = parseXmlFile(xmlPath, readFileSync(xmlPath, "utf8"));
  const [resolved] = resolveInheritance([doc]);
  return resolved.frames as unknown as Record<string, unknown>[];
}

test("relativekey_stretch.xml — frame geometry", async ({ page }) => {
  await renderFrames(page, parseFixture());

  const rendered = await queryRendered(page);
  const frame = rendered.find((f) => f.name === "StretchTest");
  expect(frame).toBeDefined();
  expect(frame!.width).toBe(160);
  expect(frame!.height).toBe(26);
  expect(frame!.left).toBe(Math.round(VIEWPORT.w / 2 - 80));
  expect(frame!.top).toBe(VIEWPORT.h / 2 - 13);
});

test("relativekey_stretch.xml — relativeKey stretch piece geometry", async ({ page }) => {
  await renderFrames(page, parseFixture());

  const pieces = await page.evaluate(() => {
    function geom(el: HTMLElement | null) {
      if (!el) return null;
      return {
        left: parseInt(el.style.left),
        top: parseInt(el.style.top),
        width: parseInt(el.style.width),
        height: parseInt(el.style.height),
      };
    }
    const frame = document.querySelector<HTMLElement>('[data-name="StretchTest"]');
    return {
      left: geom(frame?.querySelector<HTMLElement>('[data-name="LeftPiece"]') ?? null),
      right: geom(frame?.querySelector<HTMLElement>('[data-name="RightPiece"]') ?? null),
      middle: geom(frame?.querySelector<HTMLElement>('[data-name="MiddlePiece"]') ?? null),
    };
  });

  // Left cap: fixed 12x26, pinned to left edge of 160px frame
  expect(pieces.left).toEqual({ left: 0, top: 0, width: 12, height: 26 });
  // Right cap: fixed 12x26, pinned to right edge (160 - 12 = 148)
  expect(pieces.right).toEqual({ left: 148, top: 0, width: 12, height: 26 });
  // Middle: fills gap between Left.TOPRIGHT (x=12) and Right.BOTTOMLEFT (x=148)
  expect(pieces.middle).toEqual({ left: 12, top: 0, width: 136, height: 26 });
});

test("relativekey_stretch.xml — no requestAsset for color-only textures", async ({ page }) => {
  await renderFrames(page, parseFixture());

  const messages = await page.evaluate(
    () => (window as Window & { _vscodeMessages: unknown[] })._vscodeMessages,
  );
  const assetReqs = (messages as Array<{ type: string }>).filter((m) => m.type === "requestAsset");
  expect(assetReqs).toHaveLength(0);
});
