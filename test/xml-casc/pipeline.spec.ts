/**
 * E2E pipeline test — CASC variant.
 * Requires scryer.cacheDir in dev/settings.local.json; skips automatically otherwise.
 */

import { test, expect } from "@playwright/test";
import { readFileSync, existsSync } from "fs";
import { resolve, join } from "path";
import { parseXmlFile, resolveInheritance } from "../../src/parser";
import { blpToPng } from "../../src/assets/blp";
import { getExtractedAssetsDir } from "../unit-casc/helpers";
import { VIEWPORT, renderFrames, queryRendered } from "../webview/helpers";

function parseE2eXml(filename: string): Record<string, unknown>[] {
  const xmlPath = resolve(__dirname, filename);
  const doc = parseXmlFile(xmlPath, readFileSync(xmlPath, "utf8"));
  const [resolved] = resolveInheritance([doc]);
  return resolved.frames as unknown as Record<string, unknown>[];
}

test("direct_texture_casc.xml — full parse→render pipeline (CASC)", async ({ page }) => {
  const assetsDir = getExtractedAssetsDir();
  test.skip(assetsDir === null, "scryer.cacheDir not set in dev/settings.local.json");

  const blpPath = join(assetsDir!, "Interface", "Buttons", "UI-CheckBox-Check.blp");
  test.skip(!existsSync(blpPath), `BLP not found: ${blpPath} — extract textures first`);

  const frames = parseE2eXml("../e2e/direct_texture_casc.xml");

  const pngBuf = blpToPng(blpPath);
  const assetUri = `data:image/png;base64,${pngBuf.toString("base64")}`;

  await renderFrames(page, frames);

  const rendered = await queryRendered(page);
  const frame = rendered.find((f) => f.name === "TextureTestFrame");
  expect(frame).toBeDefined();
  expect(frame!.width).toBe(64);
  expect(frame!.height).toBe(64);
  expect(frame!.left).toBe(Math.round(VIEWPORT.w / 2 - 32));
  expect(frame!.top).toBe(VIEWPORT.h / 2 - 32);

  const messages = await page.evaluate(
    () => (window as Window & { _vscodeMessages: unknown[] })._vscodeMessages,
  );
  const assetReq = (messages as Array<{ type: string; path?: string }>).find(
    (m) => m.type === "requestAsset",
  );
  expect(assetReq).toBeDefined();
  expect(assetReq!.path).toContain("UI-CheckBox-Check");

  await page.evaluate(
    ({ path, uri }) => window.postMessage({ type: "assetResolved", path, uri }, "*"),
    { path: assetReq!.path!, uri: assetUri },
  );

  const texStyle = await page.evaluate((path) => {
    const escaped = path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const el = document.querySelector<HTMLElement>(`[data-asset-path="${escaped}"]`);
    return el
      ? { backgroundImage: el.style.backgroundImage, backgroundSize: el.style.backgroundSize }
      : null;
  }, assetReq!.path!);

  expect(texStyle).not.toBeNull();
  expect(texStyle!.backgroundImage).toContain("url(");
  expect(texStyle!.backgroundSize).toBe("100% 100%");
});
