import { expect, type Page } from "@playwright/test";
import { readFileSync } from "fs";
import { resolve } from "path";

// ---------------------------------------------------------------------------
// Fixture config — read defaults.json directly so values stay in sync.
// ---------------------------------------------------------------------------

const DEFAULTS_JSON = JSON.parse(
  readFileSync(resolve(__dirname, "../../src/flavors/defaults.json"), "utf8"),
);
const D = DEFAULTS_JSON.default;

export const FLAVOR_CONFIG = {
  ...D,
  uiParentWidth: Math.round((D.uiParentHeight * D.screenWidth) / D.screenHeight),
};

export const VIEWPORT = { w: FLAVOR_CONFIG.uiParentWidth, h: FLAVOR_CONFIG.uiParentHeight };
export const TOOLBAR_STATE = { flavor: "retail", locale: "enUS", screenResolution: "1920x1080" };
export const HARNESS = `file://${resolve(__dirname, "harness.html")}`;

// ---------------------------------------------------------------------------
// Frame / texture factories
// ---------------------------------------------------------------------------

export function makeFrame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

export function makeTexture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

// ---------------------------------------------------------------------------
// Webview helpers
// ---------------------------------------------------------------------------

export async function renderFrames(page: Page, frames: Record<string, unknown>[]): Promise<void> {
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
}

/** Query all named rendered elements from the live DOM. */
export async function queryRendered(page: Page) {
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
