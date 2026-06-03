/**
 * E2E pipeline test — vertex-icon variant (no CASC required).
 * Runs the real extension parsing pipeline from file to rendered webview.
 *
 * Renderer behaviors (assetResolved → backgroundImage, backgroundSize) are
 * covered by test/webview/render.spec.ts. This test asserts only what the
 * parse pipeline is responsible for: correct frame geometry and the texture
 * file path surfacing as a requestAsset message.
 */

import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { parseXmlFile, resolveInheritance } from "../../src/parser";
import { VIEWPORT, renderFrames, queryRendered } from "../webview/helpers";

function parseE2eXml(filename: string): Record<string, unknown>[] {
  const xmlPath = resolve(__dirname, filename);
  const doc = parseXmlFile(xmlPath, readFileSync(xmlPath, "utf8"));
  const [resolved] = resolveInheritance([doc]);
  return resolved.frames as unknown as Record<string, unknown>[];
}

test("direct_texture_vertex.xml — full parse→render pipeline", async ({ page }) => {
  const frames = parseE2eXml("direct_texture_vertex.xml");
  await renderFrames(page, frames);

  // <Frame name="TextureTestFrame"> <Size x="64" y="64"/> <Anchor point="CENTER"/>
  const rendered = await queryRendered(page);
  const frame = rendered.find((f) => f.name === "TextureTestFrame");
  expect(frame).toBeDefined();
  expect(frame!.width).toBe(64);
  expect(frame!.height).toBe(64);
  expect(frame!.left).toBe(Math.round(VIEWPORT.w / 2 - 32));
  expect(frame!.top).toBe(VIEWPORT.h / 2 - 32);

  // Parser extracted the texture file path → webview emits requestAsset with it.
  const messages = await page.evaluate(
    () => (window as Window & { _vscodeMessages: unknown[] })._vscodeMessages,
  );
  const assetReq = (messages as Array<{ type: string; path?: string }>).find(
    (m) => m.type === "requestAsset",
  );
  expect(assetReq).toBeDefined();
  expect(assetReq!.path).toContain("vertex-icon");
});
