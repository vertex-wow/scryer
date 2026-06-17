import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { blpToPng } from "../../src/assets/blp";
import {
  VIEWPORT,
  FLAVOR_CONFIG,
  TOOLBAR_STATE,
  HARNESS,
  makeFrame,
  makeTexture,
  renderFrames,
  queryRendered,
} from "./helpers";

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

test("applies assetResolved uri to texture backgroundImage (BLP fixture)", async ({ page }) => {
  const pngBuf = blpToPng(resolve(__dirname, "../fixtures/assets/vertex-icon.blp"));
  const dataUri = `data:image/png;base64,${pngBuf.toString("base64")}`;

  const texturePath = "Interface\\Textures\\vertex-icon.blp";

  await renderFrames(page, [
    makeFrame({
      name: "BlpTextureFrame",
      size: { x: 64, y: 64 },
      anchors: [{ point: "CENTER" }],
      layers: [
        {
          level: "ARTWORK",
          subLevel: 0,
          objects: [makeTexture({ name: "BlpTex", file: texturePath })],
        },
      ],
    }),
  ]);

  // Frame is 64×64 and centered in the viewport.
  const rendered = await queryRendered(page);
  const frame = rendered.find((f) => f.name === "BlpTextureFrame");
  expect(frame).toBeDefined();
  expect(frame!.width).toBe(64);
  expect(frame!.height).toBe(64);
  expect(frame!.left).toBe(Math.round(VIEWPORT.w / 2 - 32));
  expect(frame!.top).toBe(VIEWPORT.h / 2 - 32);

  // Verify the webview requested the asset.
  const messages = await page.evaluate(
    () => (window as Window & { _vscodeMessages: unknown[] })._vscodeMessages,
  );
  const requested = (messages as Array<{ type: string; path?: string }>).some(
    (m) => m.type === "requestAsset" && m.path === texturePath,
  );
  expect(requested).toBe(true);

  // Simulate the extension responding with the decoded PNG.
  await page.evaluate(
    ({ path, uri }) => {
      window.postMessage({ type: "assetResolved", path, uri }, "*");
    },
    { path: texturePath, uri: dataUri },
  );

  // Texture fills the frame (setAllPoints=true) and backgroundImage is applied.
  const texStyle = await page.evaluate((path) => {
    const escaped = path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const el = document.querySelector<HTMLElement>(`[data-asset-path="${escaped}"]`);
    return el
      ? { backgroundImage: el.style.backgroundImage, backgroundSize: el.style.backgroundSize }
      : null;
  }, texturePath);

  expect(texStyle).not.toBeNull();
  expect(texStyle!.backgroundImage).toContain("url(");
  expect(texStyle!.backgroundSize).toBe("100% 100%");
});

test("assetResolved with TexCoords applies UV-to-CSS background formula", async ({ page }) => {
  const texturePath = "Interface\\Buttons\\UI-Silver-Button-Up";
  // Minimal 1x1 transparent PNG — content irrelevant; only the CSS formula is under test.
  const dummyUri =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

  await renderFrames(page, [
    makeFrame({
      name: "SliceFrame",
      size: { x: 48, y: 24 },
      anchors: [{ point: "CENTER" }],
      layers: [
        {
          level: "BACKGROUND",
          subLevel: 0,
          objects: [
            makeTexture({
              file: texturePath,
              texCoords: { left: 0.53125, right: 0.625, top: 0, bottom: 0.1875 },
            }),
          ],
        },
      ],
    }),
  ]);

  await page.evaluate(
    ({ path, uri }) => {
      window.postMessage({ type: "assetResolved", path, uri }, "*");
    },
    { path: texturePath, uri: dummyUri },
  );

  // bgW = 48 / (0.625 - 0.53125) = 512
  // bgH = 24 / 0.1875            = 128
  // backgroundPosition = -0.53125 * 512 = -272px, -0 * 128 = 0px
  const texStyle = await page.evaluate((path) => {
    const escaped = path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const el = document.querySelector<HTMLElement>(`[data-asset-path="${escaped}"]`);
    return el
      ? {
          backgroundSize: el.style.backgroundSize,
          backgroundPosition: el.style.backgroundPosition,
        }
      : null;
  }, texturePath);

  expect(texStyle).not.toBeNull();
  expect(texStyle!.backgroundSize).toBe("512px 128px");
  expect(texStyle!.backgroundPosition).toBe("-272px 0px");
});

test("frameStrata maps to correct z-index", async ({ page }) => {
  await renderFrames(page, [
    makeFrame({ name: "MediumFrame", frameStrata: "MEDIUM", anchors: [{ point: "CENTER" }] }),
    makeFrame({ name: "HighFrame", frameStrata: "HIGH", anchors: [{ point: "CENTER" }] }),
    makeFrame({ name: "BgFrame", frameStrata: "BACKGROUND", anchors: [{ point: "CENTER" }] }),
  ]);

  const zIndices = await page.evaluate(() => {
    function z(name: string) {
      const el = document.querySelector<HTMLElement>(`[data-name="${name}"]`);
      return el ? parseInt(el.style.zIndex) : null;
    }
    return { medium: z("MediumFrame"), high: z("HighFrame"), bg: z("BgFrame") };
  });

  // strataIndex * 1000: BACKGROUND=1, MEDIUM=3, HIGH=4
  expect(zIndices.bg).toBe(1000);
  expect(zIndices.medium).toBe(3000);
  expect(zIndices.high).toBe(4000);
});

test("layer level maps to correct z-index within a frame", async ({ page }) => {
  await renderFrames(page, [
    makeFrame({
      name: "LayerFrame",
      anchors: [{ point: "CENTER" }],
      layers: [
        { level: "BACKGROUND", subLevel: 0, objects: [makeTexture({ name: "BgTex" })] },
        { level: "ARTWORK", subLevel: 0, objects: [makeTexture({ name: "ArtTex" })] },
        { level: "OVERLAY", subLevel: 0, objects: [makeTexture({ name: "OvTex" })] },
      ],
    }),
  ]);

  const layerZ = await page.evaluate(() => {
    function z(layer: string) {
      const el = document.querySelector<HTMLElement>(`[data-layer="${layer}"]`);
      return el ? parseInt(el.style.zIndex) : null;
    }
    return { bg: z("BACKGROUND"), art: z("ARTWORK"), ov: z("OVERLAY") };
  });

  // layerIndex * 20 + subLevel(0) + 8: BACKGROUND=8, ARTWORK=48, OVERLAY=68
  expect(layerZ.bg).toBe(8);
  expect(layerZ.art).toBe(48);
  expect(layerZ.ov).toBe(68);
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

// ---------------------------------------------------------------------------
// Eyedropper
// ---------------------------------------------------------------------------

test("eyedropper: setEyedropper activates and mousemove sends eyedropperSample", async ({
  page,
}) => {
  // Fill a large frame with a known red color so it's easy to hit
  await renderFrames(page, [
    makeFrame({
      name: "RedFrame",
      size: { x: VIEWPORT.w, y: VIEWPORT.h },
      anchors: [{ point: "CENTER" }],
      layers: [
        {
          level: "BACKGROUND",
          subLevel: 0,
          objects: [makeTexture({ name: "RedBg", color: { r: 1.0, g: 0.0, b: 0.0, a: 1.0 } })],
        },
      ],
    }),
  ]);

  // Activate eyedropper from host
  await page.evaluate(() => window.postMessage({ type: "setEyedropper", active: true }, "*"));
  await page.waitForTimeout(50);

  const hasClass = await page.evaluate(() => document.body.classList.contains("mode-eyedropper"));
  expect(hasClass).toBe(true);

  await page.evaluate(() => {
    (window as Window & { _vscodeMessages: unknown[] })._vscodeMessages = [];
  });
  await page.mouse.move(400, 300);
  await page.waitForTimeout(50);

  const messages = await page.evaluate(
    () => (window as Window & { _vscodeMessages: unknown[] })._vscodeMessages,
  );
  const sample = messages.find((m: unknown) => (m as { type: string }).type === "eyedropperSample");
  expect(sample).toBeDefined();
  // Solid red frame: r should dominate, g/b should be near zero
  expect((sample as { r: number }).r).toBeGreaterThan(200);
  expect((sample as { g: number }).g).toBeLessThan(50);
});

// ---------------------------------------------------------------------------
// Drag
// ---------------------------------------------------------------------------

const DRAG_FRAME = makeFrame({
  name: "DragFrame",
  size: { x: 200, y: 200 },
  anchors: [{ point: "CENTER" }],
  draggable: true,
  runtimeId: 1,
  layers: [
    {
      level: "BACKGROUND",
      subLevel: 0,
      objects: [makeTexture({ name: "DragBg", color: { r: 0, g: 0.5, b: 1, a: 1 } })],
    },
  ],
});

// Drag the element by (dx, dy) screen pixels, starting from its current visual center.
async function dragBy(
  page: Parameters<typeof renderFrames>[0],
  el: ReturnType<typeof page.locator>,
  dx: number,
  dy: number,
) {
  const box = await el.boundingBox();
  if (!box) throw new Error("element not found");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx, cy + dy, { steps: 3 });
  await page.mouse.up();
}

test("drag: frame screen position shifts by drag delta after single drag", async ({ page }) => {
  await renderFrames(page, [DRAG_FRAME]);
  const el = page.locator('[data-name="DragFrame"]');

  const before = await el.boundingBox();
  await dragBy(page, el, 80, 40);
  const after = await el.boundingBox();

  // screenToLocal in the renderer is offsetWidth / getBoundingClientRect().width.
  // The resulting CSS-px translation, when converted back to screen px, equals dx exactly.
  expect(after!.x - before!.x).toBeCloseTo(80, 0);
  expect(after!.y - before!.y).toBeCloseTo(40, 0);
});

test("drag: second drag accumulates onto first drag position", async ({ page }) => {
  await renderFrames(page, [DRAG_FRAME]);
  const el = page.locator('[data-name="DragFrame"]');

  const origin = await el.boundingBox();
  await dragBy(page, el, 80, 40);
  // Re-query bounding box after first drag so second drag starts at the visual position.
  await dragBy(page, el, 20, 10);
  const final = await el.boundingBox();

  // Total displacement must equal the sum of both drags.
  // Bug: tx/ty reset to 0 on each mousedown, so second drag snaps frame back to
  // just (20, 10) from its original position instead of accumulating.
  expect(final!.x - origin!.x).toBeCloseTo(100, 0);
  expect(final!.y - origin!.y).toBeCloseTo(50, 0);
});
