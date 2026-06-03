/**
 * E2E pipeline test — atlas.xml
 * No CASC required. Uses a mock manifest injected at parse time.
 * No e2e-casc counterpart needed: the CASC layer tests asset extraction (BLP
 * decode, sprite sheet loading). Atlas manifest is generated separately by
 * dev/gen-atlas.mjs, so a CASC test would only verify that specific WoW atlas
 * names exist in WoW data — not extension pipeline behavior. Everything the
 * pipeline does with atlas data is covered here with deterministic mock values.
 *
 * Covers:
 *   - Resolved atlas: data-asset-path, data-atlas-crop DOM attributes
 *   - requestAsset emitted for resolved atlas sprite sheet path
 *   - useAtlasSize=true: texture element sized from atlas region dimensions
 *   - Unknown atlas name: data-atlas-name set, [atlas] placeholder label rendered
 */

import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { parseXmlFile, resolveInheritance } from "../../src/parser";
import { resolveAtlasNames } from "../../src/assets/atlas-manifest";
import type { AtlasManifest } from "../../src/assets/atlas-manifest";
import type { FrameIR } from "../../src/parser/ir";
import { renderFrames } from "../webview/helpers";

// ---------------------------------------------------------------------------
// Mock manifest — deterministic values for assertions
// ---------------------------------------------------------------------------

const MOCK_MANIFEST: AtlasManifest = {
  "mock-button": {
    file: "Interface/Buttons/MockAtlas.blp",
    x: 4,
    y: 8,
    width: 32,
    height: 16,
    sheetW: 256,
    sheetH: 128,
    tilesH: false,
    tilesV: false,
  },
  "mock-shadow": {
    file: "Interface/Misc/MockShadow.blp",
    x: 10,
    y: 20,
    width: 80,
    height: 40,
    sheetW: 512,
    sheetH: 512,
    tilesH: false,
    tilesV: false,
  },
};

function parseFixture(): Record<string, unknown>[] {
  const xmlPath = resolve(__dirname, "atlas.xml");
  const doc = parseXmlFile(xmlPath, readFileSync(xmlPath, "utf8"));
  const [resolved] = resolveInheritance([doc]);
  const frames = resolved.frames as unknown as FrameIR[];
  resolveAtlasNames(frames, MOCK_MANIFEST);
  return frames as unknown as Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("atlas.xml — resolved atlas sets data-asset-path and data-atlas-crop", async ({ page }) => {
  await renderFrames(page, parseFixture());

  const result = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(
      '[data-name="Atlas_FillParent"] [data-layer="BACKGROUND"] [data-kind="Texture"]',
    );
    return el
      ? {
          assetPath: el.dataset.assetPath,
          atlasCrop: el.dataset.atlasCrop ? JSON.parse(el.dataset.atlasCrop) : null,
        }
      : null;
  });

  expect(result?.assetPath).toBe("Interface/Buttons/MockAtlas.blp");
  expect(result?.atlasCrop).toEqual({
    x: 4,
    y: 8,
    width: 32,
    height: 16,
    sheetW: 256,
    sheetH: 128,
    tilesH: false,
    tilesV: false,
    useAtlasSize: false,
  });
});

test("atlas.xml — resolved atlas emits requestAsset with sprite sheet path", async ({ page }) => {
  await renderFrames(page, parseFixture());

  const messages = await page.evaluate(
    () => (window as Window & { _vscodeMessages: unknown[] })._vscodeMessages,
  );
  const paths = (messages as Array<{ type: string; path?: string }>)
    .filter((m) => m.type === "requestAsset")
    .map((m) => m.path);

  expect(paths).toContain("Interface/Buttons/MockAtlas.blp");
  expect(paths).toContain("Interface/Misc/MockShadow.blp");
});

test("atlas.xml — useAtlasSize=true sizes texture element from atlas region", async ({ page }) => {
  await renderFrames(page, parseFixture());

  const result = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(
      '[data-name="Atlas_UseAtlasSize"] [data-layer="BACKGROUND"] [data-kind="Texture"]',
    );
    return el
      ? {
          width: el.style.width,
          height: el.style.height,
          useAtlasSizeInCrop: el.dataset.atlasCrop
            ? (JSON.parse(el.dataset.atlasCrop) as { useAtlasSize: boolean }).useAtlasSize
            : null,
        }
      : null;
  });

  expect(result?.width).toBe("80px");
  expect(result?.height).toBe("40px");
  expect(result?.useAtlasSizeInCrop).toBe(true);
});

test("atlas.xml — unknown atlas name renders labeled placeholder", async ({ page }) => {
  await renderFrames(page, parseFixture());

  const result = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(
      '[data-name="Atlas_Unknown"] [data-layer="BACKGROUND"] [data-kind="Texture"]',
    );
    if (!el) return null;
    const ph = el.querySelector<HTMLElement>("[data-ph-label]");
    return {
      atlasName: el.dataset.atlasName,
      phLabel: ph?.dataset.phLabel ?? null,
    };
  });

  expect(result?.atlasName).toBe("not-a-real-atlas-name");
  expect(result?.phLabel).toBe("[atlas] not-a-real-atlas-name");
});
