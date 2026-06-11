import type { HostMessage, ResolvedFlavorConfig, WebviewMessage } from "../protocol.js";
import { renderFrames } from "./renderer.js";
import { initRulers, setRulersVisible, updateRulers } from "./components/ruler.js";
import type { CanvasMode } from "../constants.js";
import {
  ZOOM_PRESETS,
  DEFAULT_CANVAS_MODE,
  WORKAREA_BG_BLACK,
  WORKAREA_BG_WHITE,
  WORKAREA_BG_GRAY,
  WORKAREA_BG_MAGENTA,
  WORKAREA_BG_CHECKERBOARD_DARK_COLOR1,
  WORKAREA_BG_CHECKERBOARD_DARK_COLOR2,
  WORKAREA_BG_CHECKERBOARD_DARK_SIZE,
  WORKAREA_BG_CHECKERBOARD_LIGHT_COLOR1,
  WORKAREA_BG_CHECKERBOARD_LIGHT_COLOR2,
  WORKAREA_BG_CHECKERBOARD_LIGHT_SIZE,
} from "../constants.js";

declare function acquireVsCodeApi(): {
  postMessage(msg: WebviewMessage): void;
};

const vscode = acquireVsCodeApi();

const viewport = document.getElementById("viewport");
const debug = document.getElementById("debug");
if (!viewport) throw new Error("Missing #viewport element");

let currentWowViewport: HTMLElement | null = null;
let currentScale = 1;
let currentUiScale = 1;
let currentConfig: ResolvedFlavorConfig | null = null;

// ---------------------------------------------------------------------------
// Pan / zoom state
// ---------------------------------------------------------------------------

let panX = 0;
let panY = 0;
let panZoom = 1;

let canvasMode: CanvasMode = DEFAULT_CANVAS_MODE;

const interactBtn = document.getElementById("interact-toggle");
const grabBtn = document.getElementById("grab-toggle");
const bgDropdownMenu = document.getElementById("bg-dropdown-menu") as HTMLElement | null;
const bgPreview = document.getElementById("bg-preview") as HTMLElement | null;

let lastWorkareaBackground = "checkerBoard";
let lastCustomBackgroundUri: string | undefined = undefined;

function applyWorkareaBackground(bgType: string, customUri?: string) {
  let resolvedBg = bgType;
  if (resolvedBg === "checkerBoardAuto") {
    const isLight = document.body.classList.contains("vscode-light");
    resolvedBg = isLight ? "checkerBoardLight" : "checkerBoard";
  }

  if (currentWowViewport) {
    if (resolvedBg === "black") {
      currentWowViewport.style.background = WORKAREA_BG_BLACK;
    } else if (resolvedBg === "white") {
      currentWowViewport.style.background = WORKAREA_BG_WHITE;
    } else if (resolvedBg === "neutralGray") {
      currentWowViewport.style.background = WORKAREA_BG_GRAY;
    } else if (resolvedBg === "magenta") {
      currentWowViewport.style.background = WORKAREA_BG_MAGENTA;
    } else if (resolvedBg === "custom" && customUri) {
      currentWowViewport.style.background = `url("${customUri}") no-repeat center center`;
      currentWowViewport.style.backgroundSize = "cover";
    } else if (resolvedBg === "checkerBoardLight") {
      currentWowViewport.style.background = `repeating-conic-gradient(${WORKAREA_BG_CHECKERBOARD_LIGHT_COLOR1} 0% 25%, ${WORKAREA_BG_CHECKERBOARD_LIGHT_COLOR2} 0% 50%) 50% / ${WORKAREA_BG_CHECKERBOARD_LIGHT_SIZE} ${WORKAREA_BG_CHECKERBOARD_LIGHT_SIZE}`;
    } else {
      currentWowViewport.style.background = `repeating-conic-gradient(${WORKAREA_BG_CHECKERBOARD_DARK_COLOR1} 0% 25%, ${WORKAREA_BG_CHECKERBOARD_DARK_COLOR2} 0% 50%) 50% / ${WORKAREA_BG_CHECKERBOARD_DARK_SIZE} ${WORKAREA_BG_CHECKERBOARD_DARK_SIZE}`;
    }
  }

  if (bgPreview) {
    bgPreview.textContent = "";
    bgPreview.style.border = "1px solid rgba(255,255,255,0.2)";
    if (resolvedBg === "black") {
      bgPreview.style.background = WORKAREA_BG_BLACK;
    } else if (resolvedBg === "white") {
      bgPreview.style.background = WORKAREA_BG_WHITE;
    } else if (resolvedBg === "neutralGray") {
      bgPreview.style.background = WORKAREA_BG_GRAY;
    } else if (resolvedBg === "magenta") {
      bgPreview.style.background = WORKAREA_BG_MAGENTA;
    } else if (resolvedBg === "custom") {
      bgPreview.style.background = "transparent";
      bgPreview.style.border = "none";
      bgPreview.textContent = "🖼️";
      bgPreview.style.fontSize = "12px";
      bgPreview.style.display = "flex";
      bgPreview.style.alignItems = "center";
      bgPreview.style.justifyContent = "center";
    } else if (resolvedBg === "checkerBoardLight") {
      bgPreview.style.background = `repeating-conic-gradient(${WORKAREA_BG_CHECKERBOARD_LIGHT_COLOR1} 0% 25%, ${WORKAREA_BG_CHECKERBOARD_LIGHT_COLOR2} 0% 50%) 50% / 10px 10px`;
    } else {
      bgPreview.style.background = `repeating-conic-gradient(${WORKAREA_BG_CHECKERBOARD_DARK_COLOR1} 0% 25%, ${WORKAREA_BG_CHECKERBOARD_DARK_COLOR2} 0% 50%) 50% / 10px 10px`;
    }
  }
}

const themeObserver = new MutationObserver(() => {
  applyWorkareaBackground(lastWorkareaBackground, lastCustomBackgroundUri);
});
themeObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });

function applyTransform(): void {
  viewport!.style.transform = `translate(${panX}px,${panY}px) scale(${panZoom})`;
}

function updateZoomDisplay(): void {
  const label = document.getElementById("zoom-dropdown-label");
  if (!label) return;
  const pct = Math.round(panZoom * 100);
  label.textContent = `${pct}%`;
}

function zoomAt(newZoom: number, mx: number, my: number): void {
  const vpx = (mx - panX) / panZoom;
  const vpy = (my - panY) / panZoom;
  panZoom = newZoom;
  panX = mx - vpx * panZoom;
  panY = my - vpy * panZoom;
  applyTransform();
  updateZoomDisplay();
  if (currentWowViewport && currentConfig)
    updateRulers(currentWowViewport, currentScale * currentUiScale * panZoom, currentConfig);
}

function zoomToFit(config: ResolvedFlavorConfig): void {
  const wowW = config.screenWidth * config.frameScale;
  const wowH = config.screenHeight * config.frameScale;
  const availW = window.innerWidth;
  const availH = window.innerHeight - config.statusBarHeight;
  panZoom = Math.min(availW / wowW, availH / wowH) * 0.92;
  panX = (availW - wowW * panZoom) / 2;
  panY = config.statusBarHeight + (availH - wowH * panZoom) / 2;
  applyTransform();
  updateZoomDisplay();
  if (currentWowViewport)
    updateRulers(currentWowViewport, currentScale * currentUiScale * panZoom, config);
}

function centerOnContent(config: ResolvedFlavorConfig): void {
  const wowVp = document.getElementById("wow-viewport");
  const logicalParent = document.getElementById("wow-logical-parent");
  const scale = config.frameScale;
  const uiScale = config.screenHeight / config.uiParentHeight;

  let minL = Infinity,
    minT = Infinity,
    maxR = -Infinity,
    maxB = -Infinity;
  const container = logicalParent || wowVp;
  if (container) {
    for (const child of Array.from(container.children)) {
      const el = child as HTMLElement;
      const w = el.offsetWidth,
        h = el.offsetHeight;
      if (w > 0 || h > 0) {
        minL = Math.min(minL, el.offsetLeft);
        minT = Math.min(minT, el.offsetTop);
        maxR = Math.max(maxR, el.offsetLeft + w);
        maxB = Math.max(maxB, el.offsetTop + h);
      }
    }
  }

  const effectiveScale = scale * uiScale;
  // Bbox center in #viewport-local CSS px (frameScale converts WoW logical → CSS px).
  const bboxCssX = isFinite(minL)
    ? ((minL + maxR) / 2) * effectiveScale
    : (config.screenWidth * scale) / 2;
  const bboxCssY = isFinite(minT)
    ? ((minT + maxB) / 2) * effectiveScale
    : (config.screenHeight * scale) / 2;

  const visH = window.innerHeight - config.statusBarHeight;
  panX = window.innerWidth / 2 - bboxCssX * panZoom;
  panY = config.statusBarHeight + visH / 2 - bboxCssY * panZoom;
  applyTransform();
  if (currentWowViewport)
    updateRulers(currentWowViewport, currentScale * currentUiScale * panZoom, config);
}

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------

function updateTempGrabCursor(): void {
  if (canvasMode === "grab") return; // CSS handles it via body classes
  document.body.style.cursor = isDragging ? "grabbing" : spaceDown ? "grab" : "";
}

function setMode(mode: CanvasMode): void {
  canvasMode = mode;
  document.body.classList.toggle("mode-grab", mode === "grab");
  document.body.classList.toggle("mode-interact", mode === "interact");
  grabBtn?.classList.toggle("active", mode === "grab");
  interactBtn?.classList.toggle("active", mode === "interact");
}

let initialModeSet = false;
setMode(DEFAULT_CANVAS_MODE); // fallback initial mode
applyTransform();
updateZoomDisplay();

// ---------------------------------------------------------------------------
// Debug / status
// ---------------------------------------------------------------------------

// Last render message parts — base is e.g. "rendered 3 frames", suffix is " ✓" or " — 2 warnings".
let lastRenderBase = "";
let lastRenderSuffix = "";
let failedTextureCount = 0;

/** Sync Phase 2 cursor state: progress cursor while placeholders remain in viewport. */
function syncLoadingState(): void {
  const hasPending = (viewport?.querySelectorAll("[data-placeholder]").length ?? 0) > 0;
  document.body.classList.toggle("loading-assets", hasPending);
}

/** Update #debug text to reflect current failure state, replacing the suffix when failures exist. */
function updateDebugText(): void {
  if (!debug || !lastRenderBase) return;
  if (failedTextureCount > 0) {
    const n = failedTextureCount;
    debug.innerHTML = `${lastRenderBase} <strong style="color:var(--vscode-errorForeground,#f44747)">✗</strong> ${n} texture${n === 1 ? "" : "s"} missing`;
  } else {
    debug.textContent = lastRenderBase + lastRenderSuffix;
  }
}

/** Mark all texture elements for a path as permanently failed. */
function applyAssetFailed(rawPath: string): void {
  const selector = `[data-asset-path="${rawPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
  const els = Array.from(viewport!.querySelectorAll<HTMLElement>(selector));
  for (const el of els) {
    const ph = el.querySelector("[data-placeholder]");
    if (ph) {
      ph.remove();
      failedTextureCount++;
      el.classList.add("texture-failed");
    }
  }
  syncLoadingState();
  updateDebugText();
}

function dbg(msg: string): void {
  if (debug) debug.textContent = msg;
  vscode.postMessage({ type: "dbg", text: msg });
}

function dbgRender(base: string, suffix: string): void {
  lastRenderBase = base;
  lastRenderSuffix = suffix;
  dbg(base + suffix);
}

dbg("view ready, waiting for scryer");

initRulers();

// ---------------------------------------------------------------------------
// Placeholder tooltip
// ---------------------------------------------------------------------------

const phTooltip = document.createElement("div");
phTooltip.style.cssText = [
  "position:fixed",
  "z-index:99999",
  "background:rgba(15,15,15,0.92)",
  "color:#e8e8e8",
  "font:11px/1.4 monospace",
  "padding:3px 7px",
  "border-radius:3px",
  "border:1px solid rgba(255,255,255,0.15)",
  "pointer-events:none",
  "white-space:pre-wrap",
  "max-width:400px",
  "word-break:break-all",
  "display:none",
].join(";");
document.body.appendChild(phTooltip);

function positionPhTooltip(x: number, y: number): void {
  phTooltip.style.left = `${x + 12}px`;
  phTooltip.style.top = `${y + 16}px`;
}

viewport!.addEventListener("mousemove", (e: MouseEvent) => {
  // elementsFromPoint finds placeholders that are visually beneath stacked child frames,
  // which closest() on the event target alone cannot reach.
  const elements = document.elementsFromPoint(e.clientX, e.clientY);
  let label: string | undefined;
  for (const el of elements) {
    if (!viewport!.contains(el)) continue;
    if (el instanceof HTMLElement && el.dataset.phLabel) {
      label = el.dataset.phLabel;
      break;
    }
  }
  if (label !== undefined) {
    phTooltip.textContent = label;
    phTooltip.style.display = "block";
    positionPhTooltip(e.clientX, e.clientY);
  } else {
    phTooltip.style.display = "none";
  }
});
viewport!.addEventListener("mouseleave", () => {
  phTooltip.style.display = "none";
});

// ---------------------------------------------------------------------------
// Toolbar button handlers
// ---------------------------------------------------------------------------

document.getElementById("ruler-toggle")?.addEventListener("click", () => {
  vscode.postMessage({ type: "toggleRuler" });
});

interactBtn?.addEventListener("click", () => setMode("interact"));
grabBtn?.addEventListener("click", () => setMode("grab"));

document.getElementById("recenter-btn")?.addEventListener("click", () => {
  if (currentConfig) centerOnContent(currentConfig);
});

import { setupDropdown } from "./components/dropdown.js";
import { setupLocaleDropdown, getLocaleLabel } from "./components/locale-dropdown.js";

setupDropdown("zoom-dropdown", "zoom-dropdown-menu", (val) => {
  if (val === "fit") {
    if (currentConfig) zoomToFit(currentConfig);
  } else if (val !== "custom") {
    const pct = parseInt(val, 10);
    if (!isNaN(pct)) {
      const cx = window.innerWidth / 2;
      const cy = window.innerHeight / 2;
      zoomAt(pct / 100, cx, cy);
    }
  }
});

setupDropdown("flavor-dropdown", "flavor-dropdown-menu", (value) => {
  vscode.postMessage({ type: "settingChange", key: "flavor", value });
});

setupDropdown("resolution-dropdown", "resolution-dropdown-menu", (value) => {
  vscode.postMessage({ type: "settingChange", key: "screenResolution", value });
});

setupDropdown("bg-dropdown", "bg-dropdown-menu", (value) => {
  vscode.postMessage({ type: "settingChange", key: "workareaBackground", value });
});

setupLocaleDropdown();

document.addEventListener("localeChange", (e) => {
  vscode.postMessage({ type: "settingChange", key: "locale", value: (e as CustomEvent).detail });
});

// ---------------------------------------------------------------------------
// Eyedropper
// ---------------------------------------------------------------------------

type EyedropperState = "off" | "sampling";
let eyedropperState: EyedropperState = "off";
let eyedropperText: string | null = null;

const eyedropperBtn = document.getElementById("eyedropper-toggle");

function setEyedropperState(next: EyedropperState): void {
  eyedropperState = next;
  const active = next !== "off";
  document.body.classList.toggle("mode-eyedropper", active);
  eyedropperBtn?.classList.toggle("active", active);
  if (next === "off") {
    eyedropperText = null;
    updateDebugText();
    vscode.postMessage({ type: "eyedropperOff" });
  } else if (next === "sampling") {
    vscode.postMessage({ type: "eyedropperOn" });
  }
}

eyedropperBtn?.addEventListener("click", () => {
  if (eyedropperState === "off") {
    setEyedropperState("sampling");
  } else {
    setEyedropperState("off");
  }
});

let eyedropperCanvas: HTMLCanvasElement | null = null;
function getEyedropperCanvas(): HTMLCanvasElement {
  if (!eyedropperCanvas) {
    eyedropperCanvas = document.createElement("canvas");
    eyedropperCanvas.width = 1;
    eyedropperCanvas.height = 1;
    eyedropperCanvas.style.display = "none";
    document.body.appendChild(eyedropperCanvas);
  }
  return eyedropperCanvas;
}

const eyedropperImageCache = new Map<string, HTMLImageElement>();

function parseDim(value: string, ref: number): number {
  if (!value || value === "auto") return ref;
  if (value.endsWith("%")) return (parseFloat(value) / 100) * ref;
  return parseFloat(value);
}

function sampleTexture(
  el: HTMLElement,
  bgImg: string,
  clientX: number,
  clientY: number,
): [number, number, number, number] | null {
  const m = bgImg.match(/url\("(.+?)"\)/);
  if (!m) return null;
  const url = m[1];

  let img = eyedropperImageCache.get(url);
  if (!img) {
    img = new Image();
    img.crossOrigin = "anonymous";
    img.src = url;
    eyedropperImageCache.set(url, img);
  }
  if (!img.complete || img.naturalWidth === 0) return null;

  const rect = el.getBoundingClientRect();
  // getBoundingClientRect includes CSS transform scale; offsetWidth/Height are layout-only.
  // Normalize to layout pixel space so relX/relY match getComputedStyle background values.
  const layoutW = el.offsetWidth || 1;
  const layoutH = el.offsetHeight || 1;
  const relX = (clientX - rect.left) * (layoutW / rect.width);
  const relY = (clientY - rect.top) * (layoutH / rect.height);

  const cs = getComputedStyle(el);
  const parts = cs.backgroundSize.trim().split(/\s+/);
  const bgW = parseDim(parts[0], layoutW);
  const bgH = parseDim(parts[1] ?? parts[0], layoutH);

  const posParts = cs.backgroundPosition.trim().split(/\s+/);
  const bgX = posParts[0].endsWith("%")
    ? (parseFloat(posParts[0]) / 100) * (layoutW - bgW)
    : parseFloat(posParts[0] || "0");
  const bgY = (posParts[1] ?? "0").endsWith("%")
    ? (parseFloat(posParts[1] ?? "0") / 100) * (layoutH - bgH)
    : parseFloat(posParts[1] ?? "0");

  const imgX = Math.round(((relX - bgX) / bgW) * img.naturalWidth);
  const imgY = Math.round(((relY - bgY) / bgH) * img.naturalHeight);

  if (imgX < 0 || imgY < 0 || imgX >= img.naturalWidth || imgY >= img.naturalHeight) return null;

  const canvas = getEyedropperCanvas();
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.clearRect(0, 0, 1, 1);
  try {
    ctx.drawImage(img, imgX, imgY, 1, 1, 0, 0, 1, 1);
    const data = ctx.getImageData(0, 0, 1, 1).data;
    return [data[0], data[1], data[2], data[3]];
  } catch {
    return null;
  }
}

function parseRgba(color: string): [number, number, number, number] {
  const m = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/);
  if (!m) return [0, 0, 0, 255];
  const r = parseInt(m[1]);
  const g = parseInt(m[2]);
  const b = parseInt(m[3]);
  let a = 255;
  if (m[4] !== undefined) {
    a = m[4].endsWith("%")
      ? Math.round((parseFloat(m[4]) / 100) * 255)
      : Math.round(parseFloat(m[4]) * 255);
  }
  return [r, g, b, a];
}

// Walk root's subtree and return the deepest descendant that contains (clientX, clientY)
// and has a visible background-color or background-image. Children are visited last-first
// (last DOM child = highest stacking context in the flat renderer layout).
// This intentionally ignores pointer-events so texture/layer elements are reachable.
function hitTestForColor(root: Element, clientX: number, clientY: number): HTMLElement | null {
  for (let i = root.children.length - 1; i >= 0; i--) {
    const child = root.children[i] as HTMLElement;
    const rect = child.getBoundingClientRect();
    if (
      clientX >= rect.left &&
      clientX < rect.right &&
      clientY >= rect.top &&
      clientY < rect.bottom
    ) {
      const found = hitTestForColor(child, clientX, clientY);
      if (found) return found;
      const cs = getComputedStyle(child);
      if (cs.backgroundColor !== "transparent" && cs.backgroundColor !== "rgba(0, 0, 0, 0)")
        return child;
      if (cs.backgroundImage && cs.backgroundImage !== "none") return child;
    }
  }
  return null;
}

function sampleAtPoint(clientX: number, clientY: number): [number, number, number, number] | null {
  const vp = document.getElementById("viewport");
  const el = vp ? hitTestForColor(vp, clientX, clientY) : null;
  if (el) {
    const cs = getComputedStyle(el);
    const bgImg = cs.backgroundImage;
    if (bgImg && bgImg !== "none") {
      const pixel = sampleTexture(el, bgImg, clientX, clientY);
      if (pixel) return pixel;
    }
    const bgColor = cs.backgroundColor;
    if (bgColor !== "transparent" && bgColor !== "rgba(0, 0, 0, 0)") return parseRgba(bgColor);
  }
  return parseRgba(getComputedStyle(document.body).backgroundColor);
}

function formatEyedropperColor(
  r: number,
  g: number,
  b: number,
  a: number,
  x: number,
  y: number,
): string {
  const h = (n: number) => Math.round(n).toString(16).toUpperCase().padStart(2, "0");
  const hex = `#${h(r)}${h(g)}${h(b)}`;
  const wow = `|c${h(a)}${h(r)}${h(g)}${h(b)}`;
  const css = `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${(a / 255).toFixed(2)})`;
  const cc = `CreateColor(${(r / 255).toFixed(2)}, ${(g / 255).toFixed(2)}, ${(b / 255).toFixed(2)}, ${(a / 255).toFixed(2)})`;
  return `(${x}, ${y})  ${hex}  ${wow}  ${css}  ${cc}`;
}

window.addEventListener("mousemove", (e: MouseEvent) => {
  if (eyedropperState !== "sampling") return;
  const pixel = sampleAtPoint(e.clientX, e.clientY);
  if (!pixel) return;
  const [r, g, b, a] = pixel;
  // Convert viewport client coords → WoW logical pixel coords
  const x = Math.round((e.clientX - panX) / panZoom / currentScale / currentUiScale);
  const y = Math.round((e.clientY - panY) / panZoom / currentScale / currentUiScale);
  eyedropperText = formatEyedropperColor(r, g, b, a, x, y);
  if (debug) debug.textContent = eyedropperText;
  vscode.postMessage({ type: "eyedropperSample", r, g, b, a, x, y });
});

document.body.addEventListener("click", (e: MouseEvent) => {
  if (eyedropperState === "off") return;
  const statusBar = document.getElementById("status-bar");
  if (statusBar && (e.target === statusBar || statusBar.contains(e.target as Node))) return;
  e.stopPropagation();
  setEyedropperState("off");
});

window.addEventListener("keydown", (e: KeyboardEvent) => {
  if (eyedropperState !== "off" && e.code === "Escape") {
    e.stopPropagation();
    setEyedropperState("off");
  }
  if (eyedropperState !== "off" && (e.ctrlKey || e.metaKey) && e.code === "KeyC") {
    if (eyedropperText) {
      e.preventDefault();
      vscode.postMessage({ type: "eyedropperCopy", text: eyedropperText });
    }
  }
});

// ---------------------------------------------------------------------------
// Drag pan
// ---------------------------------------------------------------------------

let isDragging = false;
let dragStartX = 0,
  dragStartY = 0;
let panStartX = 0,
  panStartY = 0;
let spaceDown = false;

function isGrabActive(e: MouseEvent): boolean {
  return canvasMode === "grab" || e.button === 1 || spaceDown;
}

document.body.addEventListener("mousedown", (e: MouseEvent) => {
  if (e.button === 2) return;
  if ((e.target as HTMLElement)?.closest?.("#status-bar")) return;
  if (eyedropperState !== "off") return;
  if (!isGrabActive(e)) return;
  e.preventDefault();
  isDragging = true;
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  panStartX = panX;
  panStartY = panY;
  document.body.classList.add("panning");
  updateTempGrabCursor();
});

window.addEventListener("mousemove", (e: MouseEvent) => {
  if (!isDragging) return;
  panX = panStartX + (e.clientX - dragStartX);
  panY = panStartY + (e.clientY - dragStartY);
  applyTransform();
  if (currentWowViewport && currentConfig)
    updateRulers(currentWowViewport, currentScale * currentUiScale * panZoom, currentConfig);
});

window.addEventListener("mouseup", () => {
  if (!isDragging) return;
  isDragging = false;
  document.body.classList.remove("panning");
  updateTempGrabCursor();
});

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

window.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.code === "Space" && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    spaceDown = true;
    updateTempGrabCursor();
  }
  if ((e.ctrlKey || e.metaKey) && e.code === "Digit0") {
    e.preventDefault();
    if (e.shiftKey) {
      panZoom = 1;
      updateZoomDisplay();
      if (currentConfig) centerOnContent(currentConfig);
    } else {
      if (currentConfig) zoomToFit(currentConfig);
    }
  }
});

window.addEventListener("keyup", (e: KeyboardEvent) => {
  if (e.code === "Space") {
    spaceDown = false;
    updateTempGrabCursor();
  }
});

// ---------------------------------------------------------------------------
// Wheel zoom / pan
// ---------------------------------------------------------------------------

document.body.addEventListener(
  "wheel",
  (e: WheelEvent) => {
    const isZoom = e.ctrlKey || e.metaKey;
    if (!isZoom && canvasMode !== "grab") return;
    e.preventDefault();
    if (isZoom) {
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      zoomAt(Math.max(0.05, Math.min(80, panZoom * factor)), e.clientX, e.clientY);
    } else {
      panX -= e.deltaX;
      panY -= e.deltaY;
      applyTransform();
      if (currentWowViewport && currentConfig)
        updateRulers(currentWowViewport, currentScale * currentUiScale * panZoom, currentConfig);
    }
  },
  { passive: false },
);

// ---------------------------------------------------------------------------
// Resize
// ---------------------------------------------------------------------------

window.addEventListener("resize", () => {
  if (currentWowViewport && currentConfig)
    updateRulers(currentWowViewport, currentScale * currentUiScale * panZoom, currentConfig);
});

// ---------------------------------------------------------------------------
// Asset helpers
// ---------------------------------------------------------------------------

/** After a render, collect all unique [data-asset-path] and [data-mask-file] values and request each. */
function requestRenderedAssets(): void {
  const seen = new Set<string>();
  const request = (p: string | undefined) => {
    if (p && !seen.has(p)) {
      seen.add(p);
      vscode.postMessage({ type: "requestAsset", path: p });
    }
  };
  for (const el of viewport!.querySelectorAll<HTMLElement>("[data-asset-path]"))
    request(el.dataset.assetPath);
  for (const el of viewport!.querySelectorAll<HTMLElement>("[data-mask-file]"))
    request(el.dataset.maskFile);
}

/** Inject or update the @font-face rule for the WoWDefaultFont family. */
function applyDefaultFont(uri: string): void {
  const id = "scryer-default-font";
  let style = document.getElementById(id) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = id;
    document.head.appendChild(style);
  }
  style.textContent = `@font-face { font-family: "WoWDefaultFont"; src: url("${uri}"); }`;
}

// ---------------------------------------------------------------------------
// Canvas sprite extraction — used when a tiling sprite doesn't fill its sheet
// ---------------------------------------------------------------------------

const imageCache = new Map<string, Promise<HTMLImageElement>>();
const spriteDataUrlCache = new Map<string, string>();

function loadImage(uri: string): Promise<HTMLImageElement> {
  if (!imageCache.has(uri)) {
    imageCache.set(
      uri,
      new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = uri;
      }),
    );
  }
  return imageCache.get(uri)!;
}

/**
 * Extract a sprite sub-region from its sheet to a canvas data URL.
 * The canvas is drawn at physical resolution (img.naturalWidth / sheetW scale)
 * so CSS can render it at logical size without double-resampling.
 * Results are cached keyed by "uri:x,y,w,h".
 */
function extractSpriteDataUrl(
  uri: string,
  crop: { x: number; y: number; width: number; height: number; sheetW: number; sheetH: number },
): Promise<string> {
  const key = `${uri}:${crop.x},${crop.y},${crop.width},${crop.height}`;
  const cached = spriteDataUrlCache.get(key);
  if (cached) return Promise.resolve(cached);
  return loadImage(uri).then((img) => {
    const physicalScale = img.naturalWidth / crop.sheetW;
    const physW = Math.round(crop.width * physicalScale);
    const physH = Math.round(crop.height * physicalScale);
    const canvas = document.createElement("canvas");
    canvas.width = physW;
    canvas.height = physH;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(
      img,
      Math.round(crop.x * physicalScale),
      Math.round(crop.y * physicalScale),
      physW,
      physH,
      0,
      0,
      physW,
      physH,
    );
    const dataUrl = canvas.toDataURL();
    spriteDataUrlCache.set(key, dataUrl);
    return dataUrl;
  });
}

/** Apply a resolved asset URI to all texture elements sharing that path. */
function applyAsset(rawPath: string, uri: string): void {
  const selector = `[data-asset-path="${rawPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
  const els = Array.from(viewport!.querySelectorAll<HTMLElement>(selector));
  let didUpgrade = false;
  for (const el of els) {
    if (el.classList.contains("texture-failed")) {
      el.classList.remove("texture-failed");
      failedTextureCount = Math.max(0, failedTextureCount - 1);
      didUpgrade = true;
    }
    el.style.backgroundImage = `url("${uri}")`;
    el.style.backgroundRepeat = "no-repeat";
    el.style.imageRendering = "pixelated";

    const cropRaw = el.dataset.atlasCrop;
    const coordsRaw = el.dataset.texCoords;

    if (cropRaw) {
      const crop = JSON.parse(cropRaw) as {
        x: number;
        y: number;
        width: number;
        height: number;
        sheetW: number;
        sheetH: number;
        tilesH: boolean;
        tilesV: boolean;
        useAtlasSize: boolean;
      };

      // Scale the sheet so the atlas region fills the element.
      // For tiling axes: keep native scale so tiles repeat at their natural logical size
      // rather than being stretched to fill the element (which zooms/distorts the tile).
      // For non-tiling axes: scale to fill (element dimension drives the scale).
      // Never override the element's CSS dimensions here — the layout engine has
      // already set them correctly (e.g. NineSlice Center spans the full inner area
      // via two opposing anchors; overriding to atlas size would shrink it to 64×64).
      const elemW = el.offsetWidth || crop.width;
      const elemH = el.offsetHeight || crop.height;

      // H-only tiles (TopEdge, BottomEdge) are extended 1px each side in renderer.ts
      // (seam bleed) so that no device pixel falls between adjacent element boxes at
      // fractional DPR × panZoom. elemW here is the already-extended width; the
      // background must fill that extended width, so scaleX uses elemW directly.
      // bgPosX shifts right by 1 to keep atlas content visually aligned after the
      // element shifted left by 1px.
      const seamBleed = crop.tilesH && !crop.tilesV ? 1 : 0;

      // When a tiling sprite doesn't fill its sheet width/height, CSS background-repeat
      // strides at the full sheet dimension rather than the sprite dimension, producing
      // gaps. Extract the sprite sub-region to a canvas and tile that instead.
      const needsCanvasH = crop.tilesH && crop.tilesV && crop.sheetW > crop.width;
      const needsCanvasV = crop.tilesH && crop.tilesV && crop.sheetH > crop.height;
      if (needsCanvasH || needsCanvasV) {
        const capturedEl = el;
        const capturedElemW = elemW;
        const capturedElemH = elemH;
        void extractSpriteDataUrl(uri, crop)
          .then((dataUrl) => {
            capturedEl.style.backgroundImage = `url("${dataUrl}")`;
            if (needsCanvasH && !needsCanvasV) {
              capturedEl.style.backgroundSize = `${crop.width}px ${capturedElemH}px`;
              capturedEl.style.backgroundPosition = `${seamBleed}px 0px`;
              capturedEl.style.backgroundRepeat = "repeat-x";
            } else if (needsCanvasV && !needsCanvasH) {
              capturedEl.style.backgroundSize = `${capturedElemW}px ${crop.height}px`;
              capturedEl.style.backgroundPosition = `0px 0px`;
              capturedEl.style.backgroundRepeat = "repeat-y";
            } else {
              capturedEl.style.backgroundSize = `${crop.width}px ${crop.height}px`;
              capturedEl.style.backgroundPosition = `0px 0px`;
              capturedEl.style.backgroundRepeat = "repeat";
            }
            const ph = capturedEl.querySelector("[data-placeholder]");
            if (ph) ph.remove();
            const wasFailedCanvas = capturedEl.classList.contains("texture-failed");
            if (wasFailedCanvas) {
              capturedEl.classList.remove("texture-failed");
              failedTextureCount = Math.max(0, failedTextureCount - 1);
            }
            capturedEl.style.pointerEvents = "none";
            syncLoadingState();
            if (wasFailedCanvas) updateDebugText();
          })
          .catch((err) => {
            console.error("canvas extraction failed:", err);
          });
        continue; // placeholder stays until async resolves; skip CSS path below
      }

      // H-only tiles: stretch to element width instead of repeating. The
      // TopEdge tile is y-gradient/x-uniform so stretching is visually identical
      // to repeat-x, but forces no-repeat on X — the same Chromium render path
      // as the corner pieces. This eliminates the device-pixel phase snapping that
      // repeat-x applies on the tiling axis, which causes a 1-device-pixel Y shift
      // vs no-repeat corners at non-integer DPR.
      const scaleX =
        crop.tilesH && !crop.tilesV ? elemW / crop.width : crop.tilesH ? 1 : elemW / crop.width;
      const scaleY =
        crop.tilesV && !crop.tilesH ? elemH / crop.height : crop.tilesV ? 1 : elemH / crop.height;
      const bgW = Math.round(crop.sheetW * scaleX);
      const bgH = Math.round(crop.sheetH * scaleY);
      el.style.backgroundSize = `${bgW}px ${bgH}px`;
      el.style.backgroundPosition = `${Math.round(-crop.x * scaleX) + seamBleed}px ${Math.round(-crop.y * scaleY)}px`;
      // All pieces use no-repeat now that tiling is handled by stretching.
      el.style.backgroundRepeat = "no-repeat";
    } else if (coordsRaw) {
      const { left, right, top, bottom } = JSON.parse(coordsRaw) as {
        left: number;
        right: number;
        top: number;
        bottom: number;
      };
      // Use pixel math: CSS background-position percentages don't mean
      // "offset by N% of container" — they use a relative-to-(container - image)
      // coordinate that gives wrong results when the image exceeds the container.
      const bgW = el.offsetWidth / (right - left);
      const bgH = el.offsetHeight / (bottom - top);
      el.style.backgroundSize = `${bgW}px ${bgH}px`;
      el.style.backgroundPosition = `${-left * bgW}px ${-top * bgH}px`;
    } else {
      const horizTile = el.dataset.horizTile === "true";
      const vertTile = el.dataset.vertTile === "true";
      if (horizTile && vertTile) {
        el.style.backgroundRepeat = "repeat";
        el.style.backgroundSize = "auto";
      } else if (horizTile) {
        el.style.backgroundRepeat = "repeat-x";
        el.style.backgroundSize = "auto 100%";
      } else if (vertTile) {
        el.style.backgroundRepeat = "repeat-y";
        el.style.backgroundSize = "100% auto";
      } else {
        el.style.backgroundRepeat = "no-repeat";
        el.style.backgroundSize = "100% 100%";
      }
      el.style.backgroundPosition = "0px 0px";
    }

    const ph = el.querySelector("[data-placeholder]");
    if (ph) ph.remove();
    el.style.pointerEvents = "none";
  }
  syncLoadingState();
  if (didUpgrade) updateDebugText();

  // Apply as mask-image to any texture masked by this path.
  // VS Code's webview is Electron/Chromium, which honors the -webkit- prefixed
  // mask properties; set both prefixed and unprefixed for safety.
  // WoW portrait masks (e.g. TempPortraitAlphaMask.blp) are grayscale luminance
  // masks — a white circle on black. CSS defaults to mask-mode:alpha, and the
  // BLP→PNG conversion yields an opaque image (alpha=1 everywhere), so an alpha
  // mask is a no-op and the full square shows. Force luminance mode so the
  // brightness channel drives the clip.
  const escapedMask = rawPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const masked = viewport!.querySelectorAll<HTMLElement>(`[data-mask-file="${escapedMask}"]`);
  for (const el of masked) {
    el.style.webkitMaskImage = `url("${uri}")`;
    el.style.maskImage = `url("${uri}")`;
    el.style.webkitMaskSize = "100% 100%";
    el.style.maskSize = "100% 100%";
    el.style.webkitMaskRepeat = "no-repeat";
    el.style.maskRepeat = "no-repeat";
    // No webkit-prefixed mask-mode exists; -webkit-mask-source-type is the legacy
    // equivalent (luminance|alpha). Set both so whichever Chromium honors takes effect.
    el.style.setProperty("-webkit-mask-source-type", "luminance");
    el.style.maskMode = "luminance";
  }
  if (masked.length > 0)
    dbg(`applied mask ${rawPath} to ${masked.length} element${masked.length === 1 ? "" : "s"}`);
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case "render":
    case "reload": {
      dbg(`received ${msg.frames.length} frame${msg.frames.length === 1 ? "" : "s"}`);
      const updateDropdown = (
        menuId: string,
        value: string,
        updateTrigger: (selectedLabel: string) => void,
      ) => {
        const menu = document.getElementById(menuId);
        if (!menu) return;
        let selectedLabel = value;
        for (const item of menu.querySelectorAll(".dropdown-item")) {
          if (item.getAttribute("data-value") === value) {
            item.classList.add("selected");
            const textEl = item.querySelector(".dropdown-item-text");
            if (textEl) selectedLabel = textEl.textContent || value;
          } else {
            item.classList.remove("selected");
          }
        }
        updateTrigger(selectedLabel);
      };

      updateDropdown("flavor-dropdown-menu", msg.toolbarState.flavor, (label) => {
        const trigger = document.querySelector("#flavor-dropdown-trigger .dropdown-trigger-label");
        if (trigger) trigger.textContent = label;
      });

      updateDropdown("resolution-dropdown-menu", msg.toolbarState.screenResolution, (label) => {
        const trigger = document.querySelector(
          "#resolution-dropdown-trigger .dropdown-trigger-label",
        );
        if (trigger) trigger.textContent = msg.toolbarState.screenResolution;
      });

      updateDropdown("locale-dropdown-menu", msg.toolbarState.locale, (label) => {
        const trigger = document.getElementById("locale-dropdown-trigger");
        if (trigger) {
          const loc = msg.toolbarState.locale;
          let displayTop = loc;
          let displayBottom = "";
          if (loc && loc.length === 4) {
            displayTop = loc.substring(0, 2);
            // It's a simplification, we could import the full logic but this suffices to render
            if (
              loc !== "enUS" &&
              loc !== "deDE" &&
              loc !== "frFR" &&
              loc !== "ruRU" &&
              loc !== "koKR" &&
              loc !== "itIT"
            ) {
              displayBottom = loc.substring(2, 4);
            }
          }
          trigger.innerHTML = displayBottom
            ? `<div class="locale-stack"><span>${displayTop}</span><span>${displayBottom}</span></div>`
            : `<span class="locale-single">${displayTop}</span>`;
        }
      });
      if (bgDropdownMenu && msg.toolbarState) {
        // Update selected class
        for (const item of bgDropdownMenu.querySelectorAll(".dropdown-item")) {
          if (item.getAttribute("data-value") === msg.toolbarState.workareaBackground) {
            item.classList.add("selected");
          } else {
            item.classList.remove("selected");
          }
        }
        // Update custom label
        const customLabel = bgDropdownMenu.querySelector("#custom-bg-label");
        if (customLabel) {
          customLabel.textContent = msg.toolbarState.workareaBackgroundPath || "Custom...";
        }
        // Update custom icon based on whether it is a folder
        const customPreview = bgDropdownMenu.querySelector("#custom-bg-preview");
        if (customPreview) {
          customPreview.textContent = msg.customBackgroundIsFolder ? "📁" : "🖼️";
        }
        const bgDropdown = document.getElementById("bg-dropdown");
        if (bgDropdown) {
          let currentBgText = msg.toolbarState.workareaBackground;
          for (const item of bgDropdownMenu.querySelectorAll(".dropdown-item")) {
            if (item.classList.contains("selected")) {
              const textSpan = item.querySelector(".dropdown-item-text");
              if (textSpan && textSpan.textContent) {
                currentBgText = textSpan.textContent;
              }
              break;
            }
          }
          bgDropdown.title = `Workarea Background\n${currentBgText}`;
        }
      }
      const localeDropdownMenu = document.getElementById("locale-dropdown-menu");
      if (localeDropdownMenu && msg.toolbarState) {
        for (const item of localeDropdownMenu.querySelectorAll(".dropdown-item")) {
          if (item.getAttribute("data-value") === msg.toolbarState.locale) {
            item.classList.add("selected");
          } else {
            item.classList.remove("selected");
          }
        }

        // Update top display
        const trigger = document.getElementById("locale-dropdown-trigger");
        if (trigger) {
          const currentLocale = msg.toolbarState.locale;
          let displayTop = currentLocale;
          let displayBottom = "";

          if (currentLocale && currentLocale.length === 4) {
            const lang = currentLocale.substring(0, 2);
            const region = currentLocale.substring(2, 4);

            // To figure out if it's unique, we could duplicate the LOCALES logic,
            // or we could just count items in the dropdown menu that start with lang.
            let count = 0;
            for (const item of localeDropdownMenu.querySelectorAll(".dropdown-item")) {
              const val = item.getAttribute("data-value");
              if (val && val.startsWith(lang)) {
                count++;
              }
            }
            if (count === 1) {
              displayTop = lang;
            } else {
              displayTop = lang;
              displayBottom = region;
            }
          }

          const triggerLabel = displayBottom
            ? `<div class="locale-stack"><span>${displayTop}</span><span>${displayBottom}</span></div>`
            : `<span class="locale-single">${displayTop}</span>`;

          trigger.innerHTML = triggerLabel;
          const localeDropdown = document.getElementById("locale-dropdown");
          if (localeDropdown) {
            const fullLabel = getLocaleLabel(currentLocale);
            localeDropdown.title = `WoW locale (GetLocale)\n${fullLabel}`;
          }
        }
      }

      if (!initialModeSet && msg.toolbarState.defaultCanvasMode) {
        initialModeSet = true;
        setMode(msg.toolbarState.defaultCanvasMode);
      }
      try {
        if (msg.defaultFontUri) applyDefaultFont(msg.defaultFontUri);
        failedTextureCount = 0;
        viewport!.innerHTML = "";
        const root = renderFrames(
          msg.frames,
          msg.viewport,
          msg.flavorConfig,
          (frameId, event, extra) => {
            if (eyedropperState !== "off") return;
            vscode.postMessage({
              type: "frameEvent",
              frameId,
              event: event as "OnClick" | "OnEnter" | "OnLeave",
              extra,
            });
          },
        );
        viewport!.appendChild(root);
        currentWowViewport = document.getElementById("wow-viewport");
        lastWorkareaBackground = msg.toolbarState.workareaBackground || "checkerBoard";
        lastCustomBackgroundUri = msg.customBackgroundUri;
        applyWorkareaBackground(lastWorkareaBackground, lastCustomBackgroundUri);

        currentConfig = msg.flavorConfig;
        currentScale = currentConfig.frameScale;
        currentUiScale = currentConfig.screenHeight / currentConfig.uiParentHeight;
        if (currentWowViewport)
          updateRulers(currentWowViewport, currentScale * currentUiScale * panZoom, currentConfig);
        // On first render (not hot-reload), center the frame content in view.
        if (msg.type === "render") centerOnContent(msg.flavorConfig);
        const renderBase = `rendered ${msg.frames.length} frame${msg.frames.length === 1 ? "" : "s"}`;
        let renderSuffix = " ✓";
        if (msg.extractionPending)
          renderSuffix =
            msg.pendingFiles > 0
              ? ` — ${msg.pendingFiles} texture${msg.pendingFiles === 1 ? "" : "s"} pending`
              : ` — pending`;
        else if (msg.warnings > 0)
          renderSuffix = ` — ${msg.warnings} warning${msg.warnings === 1 ? "" : "s"}`;
        dbgRender(renderBase, renderSuffix);
        requestRenderedAssets();
        document.body.classList.remove("loading-initial");
        syncLoadingState();
      } catch (e) {
        dbg(`render error: ${String(e)}`);
      }
      break;
    }

    case "assetResolved": {
      applyAsset(msg.path, msg.uri);
      break;
    }

    case "assetFailed": {
      applyAssetFailed(msg.path);
      break;
    }

    case "fontResolved": {
      applyDefaultFont(msg.uri);
      break;
    }

    case "setRuler": {
      setRulersVisible(msg.show);
      if (msg.show && currentWowViewport && currentConfig)
        updateRulers(currentWowViewport, currentScale * currentUiScale * panZoom, currentConfig);
      break;
    }

    case "setStatus": {
      const loadingLabel = document.getElementById("loading-label");
      if (msg.state === "idle") {
        updateDebugText();
        if (loadingLabel) loadingLabel.textContent = "Loading…";
      } else {
        const bare =
          msg.state === "extracting" ? "Extracting game assets…" : "Building atlas manifest…";
        if (debug) debug.textContent = `⏳ ${bare}`;
        if (loadingLabel) loadingLabel.textContent = bare;
      }
      break;
    }

    case "setEyedropper": {
      if (msg.active && eyedropperState === "off") {
        setEyedropperState("sampling");
      } else if (!msg.active && eyedropperState !== "off") {
        setEyedropperState("off");
      }
      break;
    }

    case "setCanvasMode": {
      setMode(msg.mode);
      break;
    }

    case "recenterCanvas": {
      if (currentConfig) centerOnContent(currentConfig);
      break;
    }
  }
});

// Tell the host we're ready
dbg("scryer ready, waiting for content");
vscode.postMessage({ type: "ready" });
