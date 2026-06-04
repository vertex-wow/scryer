import * as fs from "fs";
import * as path from "path";
import type { Page } from "@playwright/test";
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
import { renderFrames } from "../webview/helpers";
import { getExtractedAssetsDir } from "../unit-casc/helpers";

export { queryRendered, VIEWPORT } from "../webview/helpers";
export { getExtractedAssetsDir };

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

  const registry = new FrameRegistry(1024, 768);
  const clock = new VirtualClock();
  const lua = await createSandbox(WASM_PATH);
  await registerWowApi(lua, { clock });
  await registerFrameModel(lua, registry, blizzardTemplates, blizzardTextureTemplates);

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

  // Resolve atlas names if a manifest is available (<cacheDir>/<flavor>/derived/atlas-manifest.json).
  // assetsDir is <cacheDir>/<flavor>/source, so the manifest is one sibling dir up.
  if (assetsDir) {
    const manifestPath = path.join(assetsDir, "..", "derived", "atlas-manifest.json");
    const manifest = loadAtlasManifest(manifestPath);
    if (manifest) resolveAtlasNames(frames, manifest);
  }

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
