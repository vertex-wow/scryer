/**
 * E2E pipeline test — texcoords.xml
 * Verifies TexCoords sprite-sheet slicing through the parse→render pipeline.
 *
 * Covers:
 *   - Parser extracts TexCoords UV values into IR
 *   - Renderer sets data-tex-coords attribute on texture elements
 *   - Frame geometry is correct for TOPLEFT-anchored frames
 *   - requestAsset is emitted with the correct texture path
 *
 * The UV-to-CSS formula (backgroundSize / backgroundPosition after assetResolved)
 * is covered by test/webview/render.spec.ts ("assetResolved with TexCoords").
 */

import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { parseXmlFile, resolveInheritance } from "../../src/parser";
import { renderFrames, queryRendered } from "../webview/helpers";

const TEXTURE_PATH = "Interface/Buttons/UI-Silver-Button-Up";

function parseFixture(): Record<string, unknown>[] {
  const xmlPath = resolve(__dirname, "texcoords.xml");
  const doc = parseXmlFile(xmlPath, readFileSync(xmlPath, "utf8"));
  const [resolved] = resolveInheritance([doc]);
  return resolved.frames as unknown as Record<string, unknown>[];
}

test("texcoords.xml — frame geometry and requestAsset", async ({ page }) => {
  await renderFrames(page, parseFixture());

  const rendered = await queryRendered(page);

  // FullSheet: Size 128x64, TOPLEFT x=20 y=-20 → left=20, top=20
  const fullSheet = rendered.find((f) => f.name === "FullSheet");
  expect(fullSheet).toBeDefined();
  expect(fullSheet!.width).toBe(128);
  expect(fullSheet!.height).toBe(64);
  expect(fullSheet!.left).toBe(20);
  expect(fullSheet!.top).toBe(20);

  // SliceTopRight: Size 48x24, TOPLEFT x=20 y=-100 → left=20, top=100
  const sliceTopRight = rendered.find((f) => f.name === "SliceTopRight");
  expect(sliceTopRight).toBeDefined();
  expect(sliceTopRight!.width).toBe(48);
  expect(sliceTopRight!.height).toBe(24);
  expect(sliceTopRight!.left).toBe(20);
  expect(sliceTopRight!.top).toBe(100);

  // Both frames share the same texture path — requestAsset emitted at least once.
  const messages = await page.evaluate(
    () => (window as Window & { _vscodeMessages: unknown[] })._vscodeMessages,
  );
  const assetReq = (messages as Array<{ type: string; path?: string }>).find(
    (m) =>
      m.type === "requestAsset" &&
      (m.path === TEXTURE_PATH || m.path?.replace(/\\/g, "/") === TEXTURE_PATH),
  );
  expect(assetReq).toBeDefined();
});

test("texcoords.xml — data-tex-coords attribute on sliced texture", async ({ page }) => {
  await renderFrames(page, parseFixture());

  // FullSheet texture has no TexCoords — attribute should be absent.
  const fullSheetTexCoords = await page.evaluate(() => {
    const frame = document.querySelector<HTMLElement>('[data-name="FullSheet"]');
    const tex = frame?.querySelector<HTMLElement>('[data-kind="Texture"]');
    return tex?.dataset.texCoords ?? null;
  });
  expect(fullSheetTexCoords).toBeNull();

  // SliceTopRight texture has TexCoords — attribute should hold the UV values.
  const sliceTexCoords = await page.evaluate(() => {
    const frame = document.querySelector<HTMLElement>('[data-name="SliceTopRight"]');
    const tex = frame?.querySelector<HTMLElement>('[data-kind="Texture"]');
    return tex?.dataset.texCoords ? JSON.parse(tex.dataset.texCoords) : null;
  });
  expect(sliceTexCoords).toEqual({ left: 0.53125, right: 0.625, top: 0, bottom: 0.1875 });
});
