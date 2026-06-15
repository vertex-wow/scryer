import * as fs from "fs";
import * as path from "path";
import { expect, type Page } from "@playwright/test";
import { createSandbox } from "../../src/lua/sandbox";
import { registerWowApi, VirtualClock } from "../../src/lua/wow-api";
import { registerFrameModel } from "../../src/lua/createframe";
import { FrameRegistry } from "../../src/lua/frame-registry";
import { parseToc } from "../../src/parser/toc";
import { runTocAddon } from "../../src/lua/toc-runner";
import {
  blizzardAddonLuaFiles,
  loadBlizzardRegistry,
  SHARED_ADDON_NAMES,
  resolveCI,
} from "../../src/parser/blizzard-registry";
import type { FrameIR } from "../../src/parser/ir";
import { loadAtlasManifest, resolveAtlasNames } from "../../src/assets/atlas-manifest";
import { blpToPng } from "../../src/assets/blp";
import { extractPaths } from "../../src/assets/extract-core";
import { renderFrames, FLAVOR_CONFIG, HARNESS, TOOLBAR_STATE } from "../webview/helpers";
import { getExtractedAssetsDir, makeExtractCoreOpts } from "../unit-casc/helpers";

export { queryRendered, VIEWPORT } from "../webview/helpers";
export { getExtractedAssetsDir };

/**
 * Inject local PNG overrides from <addonDir>/assets/<path>.png for any
 * requestAsset messages pending in the page. Posts assetResolved for each found
 * override. Does not fall back to CASC — missing paths are silently skipped.
 *
 * Path convention: backslash→slash, strip extension, lowercase, append .png.
 * e.g. Interface/FrameGeneral/UIFrameMetal2X → assets/interface/framegeneral/uiframemetal2x.png
 */
export async function injectLocalAssets(page: Page, addonDir: string): Promise<void> {
  const msgs = await page.evaluate(
    () => (window as Window & { _vscodeMessages: unknown[] })._vscodeMessages,
  );
  const uniquePaths = [
    ...new Set(
      (msgs as Array<{ type: string; path?: string }>)
        .filter((m) => m.type === "requestAsset" && m.path)
        .map((m) => m.path!),
    ),
  ];

  for (const assetPath of uniquePaths) {
    const normalised = assetPath
      .replace(/\\/g, "/")
      .replace(/\.[^/.]+$/, "")
      .toLowerCase();
    const localPath = path.join(addonDir, "assets", normalised + ".png");
    if (!fs.existsSync(localPath)) continue;
    const uri = `data:image/png;base64,${fs.readFileSync(localPath).toString("base64")}`;
    await page.evaluate(
      ({ p, u }: { p: string; u: string }) =>
        window.postMessage({ type: "assetResolved", path: p, uri: u }, "*"),
      { p: assetPath, u: uri },
    );
  }
}

/**
 * Run a TOC addon fixture with Blizzard Lua, render at a custom screen
 * resolution, and inject local PNG overrides from the addon's assets/ directory.
 * Does not require an extracted CASC cache beyond Blizzard AddOns for templates.
 */
export async function renderTocFixtureWithLocalAssets(
  page: Page,
  tocDir: string,
  addonsDir: string,
  screenW: number,
  screenH: number,
): Promise<void> {
  const uiH = FLAVOR_CONFIG.uiParentHeight as number;
  const uiW = Math.round((uiH * screenW) / screenH);
  const wideConfig = { ...FLAVOR_CONFIG, uiParentWidth: uiW };
  const wideViewport = { w: uiW, h: uiH };

  await page.setViewportSize({
    width: Math.max(uiW + 100, 1600),
    height: Math.max(uiH + 200, 900),
  });

  const frames = await runTocFixtureWithBlizzard(tocDir, addonsDir);

  await page.goto(HARNESS);
  await page.evaluate(
    ({ frames, viewport, flavorConfig, toolbarState }) => {
      window.postMessage(
        {
          type: "render",
          frames,
          viewport,
          warnings: 0,
          extractionPending: false,
          pendingFiles: 0,
          flavorConfig,
          toolbarState,
        },
        "*",
      );
    },
    {
      frames: frames as unknown as Record<string, unknown>[],
      viewport: wideViewport,
      flavorConfig: wideConfig as Record<string, unknown>,
      toolbarState: {
        ...TOOLBAR_STATE,
        screenResolution: `${screenW}x${screenH}`,
      },
    },
  );
  await expect(page.locator("#debug")).toContainText("rendered", { timeout: 2000 });

  await injectLocalAssets(page, tocDir);
  await page.waitForTimeout(200);
}

const WASM_PATH = path.join(__dirname, "../../node_modules/wasmoon/dist/glue.wasm");

const BLIZZARD_ADDON_LOAD_ORDER = [
  "Blizzard_SharedXMLBase",
  "Blizzard_Colors",
  "Blizzard_SharedXML",
] as const;

/**
 * Returns the Interface/AddOns directory derived from scryer.cacheDir + scryer.flavor,
 * or null if not configured or if Blizzard_SharedXML is not present there.
 */
export function getBlizzardAddonsDir(): string | null {
  const assetsDir = getExtractedAssetsDir();
  if (!assetsDir) return null;
  const addonsDir = resolveCI(assetsDir, "Interface/AddOns");
  try {
    const entries = fs.readdirSync(addonsDir).map((e) => e.toLowerCase());
    if (!entries.some((e) => e === "blizzard_sharedxml")) return null;
  } catch {
    return null;
  }
  return addonsDir;
}

/**
 * Run a TOC addon fixture through the full Lua pipeline with Blizzard Lua
 * preloaded (SharedXMLBase → Blizzard_Colors → SharedXML) and Blizzard XML
 * templates loaded into the template registry. Matches the production path in
 * live-panel.ts: both Lua execution and XML template inheritance use the
 * extracted Blizzard assets.
 *
 * Skips Blizzard Lua files that are missing on disk (logs a warning) but does
 * NOT swallow Lua execution errors — those are hard failures per ADR 011.
 *
 * tocDir must contain exactly one .toc file. addonsDir must point to the
 * extracted Interface/AddOns directory.
 */
export async function runTocFixtureWithBlizzard(
  tocDir: string,
  addonsDir: string,
): Promise<FrameIR[]> {
  const tocFile = fs.readdirSync(tocDir).find((f) => f.endsWith(".toc"));
  if (!tocFile) throw new Error(`No .toc file found in ${tocDir}`);

  // Load Blizzard XML templates (same call production makes via asset-service).
  const assetsDir = getExtractedAssetsDir();
  const registryDir = assetsDir ? path.join(assetsDir, "..", "derived", "registry") : "";
  const { frames: blizzardTemplates, textures: blizzardTextureTemplates } = loadBlizzardRegistry(
    addonsDir,
    registryDir,
    SHARED_ADDON_NAMES,
  );

  // Load the atlas manifest before sandbox setup so SetAtlas(name, true) can
  // store the logical pixel size on the texture node — enabling GetWidth()/GetHeight()
  // to return the atlas dimensions during Lua execution (e.g. PanelTemplates_TabResize).
  const manifestPath = assetsDir
    ? path.join(assetsDir, "..", "derived", "atlas-manifest.json")
    : null;
  const atlasManifest = manifestPath ? loadAtlasManifest(manifestPath) : null;

  const registry = new FrameRegistry(1024, 768);
  const clock = new VirtualClock();
  const lua = await createSandbox(WASM_PATH);
  await registerWowApi(lua, { clock });
  await registerFrameModel(
    lua,
    registry,
    blizzardTemplates,
    blizzardTextureTemplates,
    atlasManifest ?? undefined,
  );

  try {
    // Load Blizzard Lua in dependency order before running the user's addon.
    for (const addonName of BLIZZARD_ADDON_LOAD_ORDER) {
      for (const luaPath of blizzardAddonLuaFiles(addonsDir, addonName)) {
        const content = fs.readFileSync(luaPath, "utf-8");
        await lua.doString(content);
      }
    }

    // Clear any frames Blizzard Lua created as side-effects.
    registry.clearBlizzardFrames();

    const tocContent = fs.readFileSync(path.join(tocDir, tocFile), "utf-8");
    const toc = parseToc(tocContent, path.join(tocDir, tocFile));

    await runTocAddon({
      toc,
      addonDir: tocDir,
      sandbox: lua,
      blizzardTemplates,
      blizzardTextureTemplates,
      readFile: async (p) => fs.readFileSync(p, "utf-8"),
      output: { info: () => {}, warn: () => {}, error: console.error },
    });
    clock.advance(0.001);
  } finally {
    lua.global.close();
  }

  const frames = registry.serialize();

  // Populate resolvedAtlas on serialized FrameIRs so the webview renderer can
  // render atlas textures without a separate asset-server round-trip.
  if (atlasManifest) resolveAtlasNames(frames, atlasManifest);

  return frames;
}

/**
 * Run a TOC addon fixture with Blizzard Lua and render into the webview harness.
 */
export async function renderTocFixtureWithBlizzard(
  page: Page,
  tocDir: string,
  addonsDir: string,
): Promise<void> {
  const frames = await runTocFixtureWithBlizzard(tocDir, addonsDir);
  await renderFrames(page, frames as unknown as Record<string, unknown>[]);
}

/**
 * Run a TOC addon fixture with Blizzard Lua, render at a custom screen
 * resolution, and inject resolved atlas assets from the cache. Intended for
 * pixel-color tests whose coordinates were sampled via the eyedropper at a
 * specific resolution in the Scryer live view.
 *
 * The browser viewport is widened automatically if the WoW UI width exceeds
 * the current window size. After this call the page is ready for
 * sampleAtWowCoord() calls — no additional waiting is required.
 */
export async function renderTocFixtureWithScreenResolution(
  page: Page,
  tocDir: string,
  addonsDir: string,
  assetsDir: string,
  screenW: number,
  screenH: number,
): Promise<void> {
  const uiH = FLAVOR_CONFIG.uiParentHeight as number;
  const uiW = Math.round((uiH * screenW) / screenH);
  const wideConfig = { ...FLAVOR_CONFIG, uiParentWidth: uiW };
  const wideViewport = { w: uiW, h: uiH };

  // Ensure the browser window is wide enough for the WoW viewport to fit after
  // centering (centering offsets by ~half the remaining space, so uiW + slack).
  await page.setViewportSize({
    width: Math.max(uiW + 100, 1600),
    height: Math.max(uiH + 200, 900),
  });

  const frames = await runTocFixtureWithBlizzard(tocDir, addonsDir);

  await page.goto(HARNESS);
  await page.evaluate(
    ({ frames, viewport, flavorConfig, toolbarState }) => {
      window.postMessage(
        {
          type: "render",
          frames,
          viewport,
          warnings: 0,
          extractionPending: false,
          pendingFiles: 0,
          flavorConfig,
          toolbarState,
        },
        "*",
      );
    },
    {
      frames: frames as unknown as Record<string, unknown>[],
      viewport: wideViewport,
      flavorConfig: wideConfig as Record<string, unknown>,
      toolbarState: {
        ...TOOLBAR_STATE,
        screenResolution: `${screenW}x${screenH}`,
      },
    },
  );
  await expect(page.locator("#debug")).toContainText("rendered", { timeout: 2000 });

  await injectResolvedAssets(page, assetsDir);

  // Let postMessage events drain and Chromium repaint before sampling.
  await page.waitForTimeout(200);
}

/**
 * Replicate the eyedropper's canvas-based pixel sampling at a WoW logical
 * coordinate. Returns the raw RGBA value from the atlas image (not the
 * composited screen color), matching exactly what the live-view eyedropper
 * reports in the status bar.
 *
 * Returns null if no element with a loaded background-image is found at the
 * given coordinate, or if the atlas image has not been resolved yet.
 */
export async function sampleAtWowCoord(
  page: Page,
  wowX: number,
  wowY: number,
): Promise<{ r: number; g: number; b: number; a: number } | null> {
  return page.evaluate(
    async ({ wowX, wowY }: { wowX: number; wowY: number }) => {
      const vp = document.getElementById("viewport");
      if (!vp) return null;

      const vpRect = vp.getBoundingClientRect();
      // WoW coordinates are in logical units. The DOM applies a chain of CSS transforms:
      //   #viewport:             translate(panX, panY) scale(panZoom)
      //   #wow-viewport:         scale(frameScale)  (often identity)
      //   #wow-logical-parent:   scale(uiScale = screenHeight / viewport.h)
      // Read each scale to convert WoW → client correctly.
      const lp = document.getElementById("wow-logical-parent");
      const wowVp = document.getElementById("wow-viewport");
      const uiScale = lp ? new DOMMatrix(window.getComputedStyle(lp).transform).a : 1;
      const frameScale = wowVp ? new DOMMatrix(window.getComputedStyle(wowVp).transform).a : 1;
      const panZoom = new DOMMatrix(window.getComputedStyle(vp).transform).a;
      const clientX = vpRect.left + wowX * uiScale * frameScale * panZoom;
      const clientY = vpRect.top + wowY * uiScale * frameScale * panZoom;

      function hitTest(root: Element, cx: number, cy: number): HTMLElement | null {
        for (let i = root.children.length - 1; i >= 0; i--) {
          const child = root.children[i] as HTMLElement;
          if (child.dataset.phLabel !== undefined) continue;
          const r = child.getBoundingClientRect();
          if (cx >= r.left && cx < r.right && cy >= r.top && cy < r.bottom) {
            const found = hitTest(child, cx, cy);
            if (found) return found;
            const cs = window.getComputedStyle(child);
            if (cs.backgroundColor !== "transparent" && cs.backgroundColor !== "rgba(0, 0, 0, 0)")
              return child;
            if (cs.backgroundImage && cs.backgroundImage !== "none") return child;
          }
        }
        return null;
      }

      const el = hitTest(vp, clientX, clientY);
      if (!el) return null;

      const cs = window.getComputedStyle(el);
      const bgImg = cs.backgroundImage;
      if (!bgImg || bgImg === "none") return null;

      const m = bgImg.match(/url\("(.+?)"\)/);
      if (!m) return null;
      const url = m[1];

      const img = new Image();
      await new Promise<void>((resolve) => {
        if (img.complete && img.naturalWidth > 0) {
          resolve();
          return;
        }
        img.onload = () => resolve();
        img.onerror = () => resolve();
        img.src = url;
        setTimeout(resolve, 2000);
      });
      if (img.naturalWidth === 0) return null;

      const rect = el.getBoundingClientRect();
      const layoutW = el.offsetWidth || 1;
      const layoutH = el.offsetHeight || 1;
      const relX = (clientX - rect.left) * (layoutW / rect.width);
      const relY = (clientY - rect.top) * (layoutH / rect.height);

      const parseDim = (v: string, ref: number): number => {
        if (!v || v === "auto") return ref;
        if (v.endsWith("%")) return (parseFloat(v) / 100) * ref;
        return parseFloat(v);
      };

      const sizeParts = cs.backgroundSize.trim().split(/\s+/);
      const bgW = parseDim(sizeParts[0], layoutW);
      const bgH = parseDim(sizeParts[1] ?? sizeParts[0], layoutH);

      const posParts = cs.backgroundPosition.trim().split(/\s+/);
      const bgX = posParts[0].endsWith("%")
        ? (parseFloat(posParts[0]) / 100) * (layoutW - bgW)
        : parseFloat(posParts[0] || "0");
      const bgY = (posParts[1] ?? "0").endsWith("%")
        ? (parseFloat(posParts[1] ?? "0") / 100) * (layoutH - bgH)
        : parseFloat(posParts[1] ?? "0");

      const imgX = Math.round(((relX - bgX) / bgW) * img.naturalWidth);
      const imgY = Math.round(((relY - bgY) / bgH) * img.naturalHeight);

      if (imgX < 0 || imgY < 0 || imgX >= img.naturalWidth || imgY >= img.naturalHeight)
        return null;

      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(img, imgX, imgY, 1, 1, 0, 0, 1, 1);
      const data = ctx.getImageData(0, 0, 1, 1).data;
      return { r: data[0], g: data[1], b: data[2], a: data[3] };
    },
    { wowX, wowY },
  );
}

function normalizeForExtract(p: string): string {
  const s = p.replace(/\\/g, "/");
  return (/\.\w+$/i.test(s) ? s : s + ".blp").toLowerCase();
}

async function injectSingleAsset(
  page: Page,
  assetsDir: string,
  assetPath: string,
): Promise<boolean> {
  let filePath: string;
  try {
    filePath = resolveCI(assetsDir, assetPath);
    if (!fs.existsSync(filePath) && !/\.\w+$/i.test(assetPath)) {
      filePath = resolveCI(assetsDir, assetPath + ".blp");
    }
  } catch {
    return false;
  }
  if (!fs.existsSync(filePath)) return false;
  let pngBuf: Buffer;
  try {
    pngBuf = blpToPng(filePath);
  } catch {
    return false;
  }
  const uri = `data:image/png;base64,${pngBuf.toString("base64")}`;
  await page.evaluate(
    ({ p, u }: { p: string; u: string }) =>
      window.postMessage({ type: "assetResolved", path: p, uri: u }, "*"),
    { p: assetPath, u: uri },
  );
  return true;
}

/**
 * Resolve all pending requestAsset messages by reading BLP files from assetsDir,
 * decoding them to PNG, and posting assetResolved back into the webview.
 *
 * Mirrors the production live-panel extraction loop: paths not found on disk are
 * extracted on demand via the asset server (using dev/settings.local.json), then
 * retried. Subsequent test runs hit the populated cache directly.
 */
export async function injectResolvedAssets(page: Page, assetsDir: string): Promise<void> {
  const msgs = await page.evaluate(
    () => (window as Window & { _vscodeMessages: unknown[] })._vscodeMessages,
  );
  const uniquePaths = [
    ...new Set(
      (msgs as Array<{ type: string; path?: string }>)
        .filter((m) => m.type === "requestAsset" && m.path)
        .map((m) => m.path!),
    ),
  ];

  const missing: string[] = [];
  for (const assetPath of uniquePaths) {
    if (!(await injectSingleAsset(page, assetsDir, assetPath))) missing.push(assetPath);
  }

  if (missing.length === 0) return;

  const coreOpts = makeExtractCoreOpts();
  if (!coreOpts) return;

  await extractPaths(missing.map(normalizeForExtract), coreOpts, "user");

  for (const assetPath of missing) {
    await injectSingleAsset(page, assetsDir, assetPath);
  }
}
