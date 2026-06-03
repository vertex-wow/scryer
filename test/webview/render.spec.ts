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
const TOOLBAR_STATE = { flavor: "retail", locale: "enUS", screenResolution: "1920x1080" };
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
  // Wait for render — #debug updates to "rendered N frame(s) ✓" synchronously after the message.
  await expect(page.locator("#debug")).toContainText("rendered", { timeout: 2000 });
}

/**
 * Query all named rendered elements from the live DOM.
 * Returns CSS layout values (WoW logical pixels, unaffected by pan/zoom transforms).
 */
async function queryRendered(page: Page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>("#viewport [data-name]"))
      .filter((el) => el.dataset.name !== "")
      .map((el) => ({
        name: el.dataset.name!,
        kind: el.dataset.kind ?? "unknown",
        width: parseInt(el.style.width) || el.offsetWidth,
        height: parseInt(el.style.height) || el.offsetHeight,
        left: parseInt(el.style.left),
        top: parseInt(el.style.top),
        text:
          el.dataset.kind === "FontString"
            ? (el.querySelector("span")?.textContent ?? "")
            : undefined,
      })),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("emits ready message on load before any render", async ({ page }) => {
  await page.goto(HARNESS);
  const messages = await page.evaluate(
    () => (window as Window & { _vscodeMessages: unknown[] })._vscodeMessages,
  );
  expect(messages).toContainEqual({ type: "ready" });
});

test("renders a centered frame at the correct size", async ({ page }) => {
  await renderFrames(page, [
    makeFrame({
      name: "TestFrame",
      size: { x: 400, y: 300 },
      anchors: [{ point: "CENTER" }],
      layers: [
        {
          level: "BACKGROUND",
          subLevel: 0,
          objects: [makeTexture({ name: "TestBg", color: { r: 0.1, g: 0.1, b: 0.1, a: 0.9 } })],
        },
      ],
    }),
  ]);

  const rendered = await queryRendered(page);
  const frame = rendered.find((f) => f.name === "TestFrame");
  expect(frame).toBeDefined();
  expect(frame!.width).toBe(400);
  expect(frame!.height).toBe(300);
});

test("debug label shows rendered frame count", async ({ page }) => {
  await renderFrames(page, [makeFrame({ name: "F1", anchors: [{ point: "CENTER" }] })]);
  await expect(page.locator("#debug")).toContainText("rendered 1 frame");
});

test("renders multiple frames", async ({ page }) => {
  await renderFrames(page, [
    makeFrame({
      name: "FrameA",
      size: { x: 200, y: 100 },
      anchors: [{ point: "TOPLEFT", x: 10, y: -10 }],
    }),
    makeFrame({
      name: "FrameB",
      size: { x: 150, y: 80 },
      anchors: [{ point: "TOPRIGHT", x: -10, y: -10 }],
    }),
  ]);

  await expect(page.locator("#debug")).toContainText("rendered 2 frames");
  const rendered = await queryRendered(page);
  expect(rendered.find((f) => f.name === "FrameA")).toBeDefined();
  expect(rendered.find((f) => f.name === "FrameB")).toBeDefined();
});

test("re-render replaces previous content", async ({ page }) => {
  await renderFrames(page, [makeFrame({ name: "First", anchors: [{ point: "CENTER" }] })]);
  // Second render
  await page.evaluate(
    ({ frames, viewport, flavorConfig, toolbarState }) => {
      window.postMessage(
        {
          type: "reload",
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
      frames: [makeFrame({ name: "Second", anchors: [{ point: "CENTER" }] })],
      viewport: VIEWPORT,
      flavorConfig: FLAVOR_CONFIG,
      toolbarState: TOOLBAR_STATE,
    },
  );
  await expect(page.locator("#debug")).toContainText("rendered 1 frame");

  const rendered = await queryRendered(page);
  expect(rendered.find((f) => f.name === "First")).toBeUndefined();
  expect(rendered.find((f) => f.name === "Second")).toBeDefined();
});

test("emits requestAsset for textures with file paths", async ({ page }) => {
  await renderFrames(page, [
    makeFrame({
      name: "TexturedFrame",
      size: { x: 200, y: 200 },
      anchors: [{ point: "CENTER" }],
      layers: [
        {
          level: "BACKGROUND",
          subLevel: 0,
          objects: [
            makeTexture({ name: "FileTexture", file: "Interface\\Icons\\spell_holy_flash.blp" }),
          ],
        },
      ],
    }),
  ]);

  const messages = await page.evaluate(
    () => (window as Window & { _vscodeMessages: unknown[] })._vscodeMessages,
  );
  const assetRequests = (messages as Array<{ type: string; path?: string }>).filter(
    (m) => m.type === "requestAsset",
  );
  expect(assetRequests.length).toBeGreaterThan(0);
  expect(assetRequests.some((m) => m.path?.includes("spell_holy_flash"))).toBe(true);
});

test("FontString text content appears in DOM", async ({ page }) => {
  await renderFrames(page, [
    makeFrame({
      name: "LabelFrame",
      size: { x: 300, y: 60 },
      anchors: [{ point: "CENTER" }],
      layers: [
        {
          level: "ARTWORK",
          subLevel: 0,
          objects: [
            {
              kind: "FontString",
              name: "LabelText",
              inherits: [],
              mixin: [],
              virtual: false,
              anchors: [{ point: "CENTER" }],
              keyValues: [],
              sourceFile: "test",
              text: "Hello World",
            },
          ],
        },
      ],
    }),
  ]);

  const rendered = await queryRendered(page);
  const fs = rendered.find((el) => el.name === "LabelText");
  expect(fs).toBeDefined();
  expect(fs!.kind).toBe("FontString");
  expect(fs!.text).toBe("Hello World");
});
