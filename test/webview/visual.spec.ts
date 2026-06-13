import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "fs";
import { resolve } from "path";

// ---------------------------------------------------------------------------
// Fixture config — read defaults.json directly so values stay in sync.
// ---------------------------------------------------------------------------

const DEFAULTS_JSON = JSON.parse(
  readFileSync(resolve(__dirname, "../../src/flavors/defaults.json"), "utf8"),
);
const D = DEFAULTS_JSON.default;

const FLAVOR_CONFIG = {
  ...D,
  uiParentWidth: Math.round((D.uiParentHeight * D.screenWidth) / D.screenHeight),
};

const VIEWPORT = { w: FLAVOR_CONFIG.uiParentWidth, h: FLAVOR_CONFIG.uiParentHeight };
const TOOLBAR_STATE = {
  flavor: "retail",
  locale: "enUS",
  screenResolution: "1920x1080",
  localTextureOverrides: true,
};
const HARNESS = `file://${resolve(__dirname, "harness.html")}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFrame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "Frame",
    inherits: [],
    mixin: [],
    virtual: false,
    anchors: [],
    keyValues: [],
    layers: [],
    children: [],
    scripts: [],
    templateChain: [],
    sourceFile: "test",
    ...overrides,
  };
}

function makeTexture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "Texture",
    inherits: [],
    mixin: [],
    virtual: false,
    anchors: [],
    setAllPoints: true,
    keyValues: [],
    sourceFile: "test",
    ...overrides,
  };
}

async function renderFrames(page: Page, frames: Record<string, unknown>[]): Promise<void> {
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
    { frames, viewport: VIEWPORT, flavorConfig: FLAVOR_CONFIG, toolbarState: TOOLBAR_STATE },
  );
  await expect(page.locator("#debug")).toContainText("rendered", { timeout: 2000 });
  // Hide toolbar so it doesn't overlay the #viewport element screenshot.
  // #status-bar is fixed at top:0 with z-index 10001 and bleeds into the
  // viewport screenshot because #viewport also starts at top:0.
  await page.locator("#status-bar").evaluate((el) => ((el as HTMLElement).style.display = "none"));
}

// ---------------------------------------------------------------------------
// Visual regression tests
//
// All fixtures use only solid-color textures (no file textures, no FontStrings)
// so screenshots are deterministic across platforms without font-rendering variance.
// ---------------------------------------------------------------------------

test("visual fixture — solid color frames", async ({ page }) => {
  await renderFrames(page, [
    // Full-canvas background so canvas boundaries are clearly visible in the snapshot.
    makeFrame({
      name: "CanvasFill",
      size: { x: VIEWPORT.w, y: VIEWPORT.h },
      anchors: [{ point: "TOPLEFT" }],
      layers: [
        {
          level: "BACKGROUND",
          subLevel: 0,
          objects: [makeTexture({ name: "FillTex", color: { r: 0.08, g: 0.08, b: 0.12, a: 1 } })],
        },
      ],
    }),
    // Centered red box — catches layout offset/size regressions.
    makeFrame({
      name: "RedBox",
      size: { x: 300, y: 200 },
      anchors: [{ point: "CENTER" }],
      layers: [
        {
          level: "ARTWORK",
          subLevel: 0,
          objects: [makeTexture({ name: "RedTex", color: { r: 0.8, g: 0.15, b: 0.1, a: 1 } })],
        },
      ],
    }),
    // Top-left blue box — catches anchor/offset regressions.
    makeFrame({
      name: "BlueBox",
      size: { x: 150, y: 100 },
      anchors: [{ point: "TOPLEFT", x: 40, y: -40 }],
      layers: [
        {
          level: "ARTWORK",
          subLevel: 0,
          objects: [makeTexture({ name: "BlueTex", color: { r: 0.1, g: 0.3, b: 0.8, a: 1 } })],
        },
      ],
    }),
  ]);

  await expect(page.locator("#viewport")).toHaveScreenshot("visual-fixture.png");
});
