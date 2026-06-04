/**
 * E2E pipeline test — blizz_templates.xml (CASC variant).
 * Requires scryer.cacheDir in dev/settings.local.json with Interface/AddOns/ present under <cacheDir>/<flavor>/source.
 *
 * Covers:
 *   - UIPanelGoldButtonTemplate: three gold-button textures resolve via Blizzard registry
 *     and emit requestAsset; frame honours explicit Size override
 *   - UIMenuButtonStretchTemplate: silver-button texture resolves; frame size correct
 *   - InsetFrameTemplate: marble background resolves and emits requestAsset
 *
 * NineSlice assertions are excluded (pending M4).
 */

import { test, expect } from "@playwright/test";
import { readFileSync, existsSync } from "fs";
import { resolve, join } from "path";
import { tmpdir } from "os";
import { parseXmlFile, resolveInheritance, loadBlizzardRegistry } from "../../src/parser";
import { getExtractedAssetsDir } from "../unit-casc/helpers";
import { renderFrames, queryRendered } from "../webview/helpers";

function normPath(p: string) {
  return p.replace(/\\/g, "/");
}

function parseFixture(assetsDir: string): Record<string, unknown>[] {
  const addonsDir = join(assetsDir, "Interface", "AddOns");
  const { frames: blizzardFrames, textures: blizzardTextures } = loadBlizzardRegistry(
    addonsDir,
    tmpdir(),
  );
  const xmlPath = resolve(__dirname, "blizz_templates.xml");
  const doc = parseXmlFile(xmlPath, readFileSync(xmlPath, "utf8"));
  const [resolved] = resolveInheritance([doc], blizzardFrames, {}, blizzardTextures);
  return resolved.frames as unknown as Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// UIPanelGoldButtonTemplate
// ---------------------------------------------------------------------------

test("blizz_templates.xml — UIPanelGoldButtonTemplate size and requestAssets", async ({ page }) => {
  const assetsDir = getExtractedAssetsDir();
  test.skip(assetsDir === null, "scryer.cacheDir not set in dev/settings.local.json");
  const addonsDir = join(assetsDir!, "Interface", "AddOns");
  test.skip(!existsSync(addonsDir), `AddOns dir not found: ${addonsDir} — extract first`);

  await renderFrames(page, parseFixture(assetsDir!));

  const rendered = await queryRendered(page);
  const btn = rendered.find((f) => f.name === "GoldBtn");
  expect(btn).toBeDefined();
  expect(btn!.width).toBe(120);
  expect(btn!.height).toBe(32);

  const messages = await page.evaluate(
    () => (window as Window & { _vscodeMessages: unknown[] })._vscodeMessages,
  );
  const paths = (messages as Array<{ type: string; path?: string }>)
    .filter((m) => m.type === "requestAsset")
    .map((m) => normPath(m.path ?? "").toLowerCase());

  expect(paths.some((p) => p.includes("goldbutton-up-left"))).toBe(true);
  expect(paths.some((p) => p.includes("goldbutton-up-right"))).toBe(true);
  expect(paths.some((p) => p.includes("goldbutton-up-middle"))).toBe(true);
});

// ---------------------------------------------------------------------------
// UIMenuButtonStretchTemplate
// ---------------------------------------------------------------------------

test("blizz_templates.xml — UIMenuButtonStretchTemplate size and requestAsset", async ({
  page,
}) => {
  const assetsDir = getExtractedAssetsDir();
  test.skip(assetsDir === null, "scryer.cacheDir not set in dev/settings.local.json");
  const addonsDir = join(assetsDir!, "Interface", "AddOns");
  test.skip(!existsSync(addonsDir), `AddOns dir not found: ${addonsDir} — extract first`);

  await renderFrames(page, parseFixture(assetsDir!));

  const rendered = await queryRendered(page);
  const btn = rendered.find((f) => f.name === "SilverBtn");
  expect(btn).toBeDefined();
  expect(btn!.width).toBe(160);
  expect(btn!.height).toBe(26);

  const messages = await page.evaluate(
    () => (window as Window & { _vscodeMessages: unknown[] })._vscodeMessages,
  );
  const paths = (messages as Array<{ type: string; path?: string }>)
    .filter((m) => m.type === "requestAsset")
    .map((m) => normPath(m.path ?? "").toLowerCase());

  expect(paths.some((p) => p.includes("ui-silver-button-up"))).toBe(true);
});

// ---------------------------------------------------------------------------
// InsetFrameTemplate
// ---------------------------------------------------------------------------

test("blizz_templates.xml — InsetFrameTemplate size and marble requestAsset", async ({ page }) => {
  const assetsDir = getExtractedAssetsDir();
  test.skip(assetsDir === null, "scryer.cacheDir not set in dev/settings.local.json");
  const addonsDir = join(assetsDir!, "Interface", "AddOns");
  test.skip(!existsSync(addonsDir), `AddOns dir not found: ${addonsDir} — extract first`);

  await renderFrames(page, parseFixture(assetsDir!));

  const rendered = await queryRendered(page);
  const inset = rendered.find((f) => f.name === "InsetTest");
  expect(inset).toBeDefined();
  expect(inset!.width).toBe(200);
  expect(inset!.height).toBe(100);

  const messages = await page.evaluate(
    () => (window as Window & { _vscodeMessages: unknown[] })._vscodeMessages,
  );
  const paths = (messages as Array<{ type: string; path?: string }>)
    .filter((m) => m.type === "requestAsset")
    .map((m) => normPath(m.path ?? "").toLowerCase());

  expect(paths.some((p) => p.includes("ui-background-marble"))).toBe(true);
});
