// Pixel ruler overlay for the preview panel.
//
// Two fixed canvas strips — #ruler-top (horizontal) and #ruler-left (vertical) —
// show WoW logical-pixel coordinates matching the anchor layout coordinate system.
// A corner square at the intersection prevents tick-label overlap.
//
// The rulers sit below the status bar (config.statusBarHeight px tall). The left
// ruler canvas starts at viewport y = statusBarHeight so its canvas coordinates
// are offset by that amount: adjustedOriginY = rect.top - statusBarHeight.
//
// DPR: both canvases are sized at window.devicePixelRatio × the CSS logical size so
// every tick and label renders at native physical-pixel resolution on retina screens.

import type { ResolvedFlavorConfig } from "../protocol.js";

// sans-serif renders noticeably crisper than monospace at 9 px
const FONT = "9px system-ui,sans-serif";

let topCanvas: HTMLCanvasElement | null = null;
let leftCanvas: HTMLCanvasElement | null = null;
let cornerEl: HTMLDivElement | null = null;

/** Create the ruler DOM elements and append them to the body. Call once on load. */
export function initRulers(): void {
  if (topCanvas) return;

  topCanvas = document.createElement("canvas");
  topCanvas.id = "ruler-top";

  leftCanvas = document.createElement("canvas");
  leftCanvas.id = "ruler-left";

  cornerEl = document.createElement("div");
  cornerEl.id = "ruler-corner";

  document.body.appendChild(topCanvas);
  document.body.appendChild(leftCanvas);
  document.body.appendChild(cornerEl);
}

/**
 * Show or hide the ruler strips by toggling a CSS class on the body.
 * The `show-ruler` class is defined in the panel's HTML <style> block.
 */
export function setRulersVisible(show: boolean): void {
  document.body.classList.toggle("show-ruler", show);
}

/**
 * Redraw both ruler canvases to reflect the current scroll position.
 *
 * Uses getBoundingClientRect() on the WoW viewport element so the displayed
 * coordinates match the element's current visual position in the viewport —
 * the transform:scale() and body scroll are both accounted for automatically.
 */
export function updateRulers(
  wowViewportEl: HTMLElement,
  scale: number,
  config: ResolvedFlavorConfig,
): void {
  if (!topCanvas || !leftCanvas) return;
  if (!document.body.classList.contains("show-ruler")) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = wowViewportEl.getBoundingClientRect();
  const vpW = window.innerWidth;
  const vpH = window.innerHeight;
  const leftH = vpH - config.statusBarHeight;

  // Top ruler: full viewport width, positioned below the status bar.
  // Canvas (0,0) = viewport (0, statusBarHeight). X coordinates are identical to viewport.
  topCanvas.width = Math.round(vpW * dpr);
  topCanvas.height = Math.round(config.rulerSize * dpr);
  drawHorizontal(topCanvas, dpr, rect.left, scale, vpW, config);

  // Left ruler: full height below the status bar.
  // Canvas y=0 = viewport y=statusBarHeight, so all originY values need the offset subtracted.
  leftCanvas.width = Math.round(config.rulerSize * dpr);
  leftCanvas.height = Math.round(leftH * dpr);
  drawVertical(leftCanvas, dpr, rect.top - config.statusBarHeight, scale, leftH, config);
}

// ---------------------------------------------------------------------------
// Canvas drawing helpers
// ---------------------------------------------------------------------------

function drawHorizontal(
  canvas: HTMLCanvasElement,
  dpr: number,
  originX: number, // viewport x of WoW canvas left edge (from getBoundingClientRect)
  scale: number,
  vpW: number, // viewport width in CSS px (= canvas logical width)
  config: ResolvedFlavorConfig,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // Reset transform to logical (CSS-pixel) coordinates at DPR resolution.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const W = vpW;
  const H = config.rulerSize;

  ctx.fillStyle = config.rulerBg;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = config.rulerBorder;
  ctx.fillRect(0, H - 1, W, 1);

  // Full visible WoW x range across the canvas width.
  const wowXStart = (0 - originX) / scale;
  const wowXEnd = (W - originX) / scale;

  const firstTick = Math.floor(wowXStart / config.rulerTickMinor) * config.rulerTickMinor;
  const lastTick = Math.ceil(wowXEnd / config.rulerTickMinor) * config.rulerTickMinor;

  ctx.font = FONT;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";

  for (let wx = firstTick; wx <= lastTick; wx += config.rulerTickMinor) {
    const px = originX + wx * scale;
    // Skip the corner overlap area (covered by #ruler-corner) and out-of-bounds.
    if (px < config.rulerSize || px >= W) continue;

    const snapped = Math.round(px);
    const isMajor = wx % config.rulerTickMajor === 0;
    const isLabel = wx % config.rulerLabelInterval === 0;
    const tickH = isMajor ? Math.floor(H / 2) : Math.floor(H / 3);

    ctx.fillStyle = isMajor ? config.rulerTickMajorColor : config.rulerTickMinorColor;
    ctx.fillRect(snapped, H - tickH, 1, tickH);

    if (isLabel) {
      ctx.shadowColor = config.rulerShadowColor;
      ctx.shadowBlur = config.rulerShadowBlur;
      ctx.fillStyle = config.rulerLabelColor;
      ctx.fillText(String(wx), snapped + 2, 2);
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;
    }
  }
}

function drawVertical(
  canvas: HTMLCanvasElement,
  dpr: number,
  // originY adjusted for the status bar offset: rect.top - STATUS_BAR_H.
  // Canvas pixel py = adjustedOriginY + wy * scale.
  adjustedOriginY: number,
  scale: number,
  H: number, // logical CSS height of this canvas (vpH - STATUS_BAR_H)
  config: ResolvedFlavorConfig,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const W = config.rulerSize;

  ctx.fillStyle = config.rulerBg;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = config.rulerBorder;
  ctx.fillRect(W - 1, 0, 1, H);

  // Full visible WoW y range across the canvas height.
  const wowYStart = (0 - adjustedOriginY) / scale;
  const wowYEnd = (H - adjustedOriginY) / scale;

  const firstTick = Math.floor(wowYStart / config.rulerTickMinor) * config.rulerTickMinor;
  const lastTick = Math.ceil(wowYEnd / config.rulerTickMinor) * config.rulerTickMinor;

  ctx.font = FONT;

  for (let wy = firstTick; wy <= lastTick; wy += config.rulerTickMinor) {
    const py = adjustedOriginY + wy * scale;
    // Skip the corner overlap area (first RULER_SIZE px covered by #ruler-corner)
    // and out-of-bounds.
    if (py < config.rulerSize || py >= H) continue;

    const snapped = Math.round(py);
    const isMajor = wy % config.rulerTickMajor === 0;
    const isLabel = wy % config.rulerLabelInterval === 0;
    const tickW = isMajor ? Math.floor(W / 2) : Math.floor(W / 3);

    ctx.fillStyle = isMajor ? config.rulerTickMajorColor : config.rulerTickMinorColor;
    ctx.fillRect(W - tickW, snapped, tickW, 1);

    if (isLabel) {
      ctx.save();
      ctx.translate(W / 2, snapped - 2);
      ctx.rotate(-Math.PI / 2);
      ctx.shadowColor = config.rulerShadowColor;
      ctx.shadowBlur = config.rulerShadowBlur;
      ctx.fillStyle = config.rulerLabelColor;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(String(wy), 0, 0);
      ctx.restore();
    }
  }
}
