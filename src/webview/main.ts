import type { HostMessage, ResolvedFlavorConfig, WebviewMessage } from "../protocol.js";
import { renderFrames } from "./renderer.js";
import { initRulers, setRulersVisible, updateRulers } from "./ruler.js";

declare function acquireVsCodeApi(): {
  postMessage(msg: WebviewMessage): void;
};

const vscode = acquireVsCodeApi();

const viewport = document.getElementById("viewport");
const debug = document.getElementById("debug");
if (!viewport) throw new Error("Missing #viewport element");

// Current WoW viewport element, scale, and config — retained so resize/zoom can redraw rulers.
let currentWowViewport: HTMLElement | null = null;
let currentScale = 1;
let currentConfig: ResolvedFlavorConfig | null = null;

// ---------------------------------------------------------------------------
// Pan / zoom state
// ---------------------------------------------------------------------------

let panX = 0;
let panY = 0;
let panZoom = 1;

type CanvasMode = "grab" | "interact";
let canvasMode: CanvasMode = "grab";

const grabBtn = document.getElementById("grab-toggle");
const interactBtn = document.getElementById("interact-toggle");
const zoomSelect = document.getElementById("zoom-select") as HTMLSelectElement | null;

const ZOOM_PRESETS = [25, 50, 75, 100, 150, 200, 400];

function applyTransform(): void {
  viewport!.style.transform = `translate(${panX}px,${panY}px) scale(${panZoom})`;
}

function updateZoomDisplay(): void {
  if (!zoomSelect) return;
  const pct = Math.round(panZoom * 100);
  const match = ZOOM_PRESETS.find((p) => p === pct);
  if (match !== undefined) {
    zoomSelect.value = String(match);
  } else {
    let customOpt = zoomSelect.querySelector<HTMLOptionElement>('option[value="custom"]');
    if (!customOpt) {
      customOpt = document.createElement("option");
      customOpt.value = "custom";
      zoomSelect.insertBefore(customOpt, zoomSelect.firstChild);
    }
    customOpt.textContent = `${pct}%`;
    zoomSelect.value = "custom";
  }
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
    updateRulers(currentWowViewport, currentScale, currentConfig);
}

function zoomToFit(config: ResolvedFlavorConfig): void {
  const wowW = config.uiParentWidth * config.frameScale;
  const wowH = config.uiParentHeight * config.frameScale;
  const availW = window.innerWidth;
  const availH = window.innerHeight - config.statusBarHeight;
  panZoom = Math.min(availW / wowW, availH / wowH) * 0.92;
  panX = (availW - wowW * panZoom) / 2;
  panY = config.statusBarHeight + (availH - wowH * panZoom) / 2;
  applyTransform();
  updateZoomDisplay();
  if (currentWowViewport) updateRulers(currentWowViewport, currentScale, config);
}

function centerOnContent(config: ResolvedFlavorConfig): void {
  const wowVp = document.getElementById("wow-viewport");
  const scale = config.frameScale;

  let minL = Infinity,
    minT = Infinity,
    maxR = -Infinity,
    maxB = -Infinity;
  if (wowVp) {
    for (const child of Array.from(wowVp.children)) {
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

  // Bbox center in #viewport-local CSS px (frameScale converts WoW logical → CSS px).
  const bboxCssX = isFinite(minL)
    ? ((minL + maxR) / 2) * scale
    : (config.uiParentWidth * scale) / 2;
  const bboxCssY = isFinite(minT)
    ? ((minT + maxB) / 2) * scale
    : (config.uiParentHeight * scale) / 2;

  const visH = window.innerHeight - config.statusBarHeight;
  panX = window.innerWidth / 2 - bboxCssX * panZoom;
  panY = config.statusBarHeight + visH / 2 - bboxCssY * panZoom;
  applyTransform();
  if (currentWowViewport) updateRulers(currentWowViewport, currentScale, config);
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

setMode("grab");
applyTransform();
updateZoomDisplay();

// ---------------------------------------------------------------------------
// Debug / status
// ---------------------------------------------------------------------------

// Last render message — restored when loading status clears.
let lastRenderMsg = "";

function dbg(msg: string): void {
  if (debug) debug.textContent = msg;
  vscode.postMessage({ type: "dbg", text: msg });
}

function dbgRender(msg: string): void {
  lastRenderMsg = msg;
  dbg(msg);
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

grabBtn?.addEventListener("click", () => setMode("grab"));
interactBtn?.addEventListener("click", () => setMode("interact"));

document.getElementById("recenter-btn")?.addEventListener("click", () => {
  if (currentConfig) centerOnContent(currentConfig);
});

zoomSelect?.addEventListener("change", () => {
  const val = zoomSelect.value;
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
    updateRulers(currentWowViewport, currentScale, currentConfig);
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
      zoomAt(Math.max(0.05, Math.min(20, panZoom * factor)), e.clientX, e.clientY);
    } else {
      panX -= e.deltaX;
      panY -= e.deltaY;
      applyTransform();
      if (currentWowViewport && currentConfig)
        updateRulers(currentWowViewport, currentScale, currentConfig);
    }
  },
  { passive: false },
);

// ---------------------------------------------------------------------------
// Resize
// ---------------------------------------------------------------------------

window.addEventListener("resize", () => {
  if (currentWowViewport && currentConfig)
    updateRulers(currentWowViewport, currentScale, currentConfig);
});

// ---------------------------------------------------------------------------
// Asset helpers
// ---------------------------------------------------------------------------

/** After a render, collect all unique [data-asset-path] values and request each. */
function requestRenderedAssets(): void {
  const els = Array.from(viewport!.querySelectorAll<HTMLElement>("[data-asset-path]"));
  const seen = new Set<string>();
  for (const el of els) {
    const p = el.dataset.assetPath;
    if (p && !seen.has(p)) {
      seen.add(p);
      vscode.postMessage({ type: "requestAsset", path: p });
    }
  }
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

/** Apply a resolved asset URI to all texture elements sharing that path. */
function applyAsset(rawPath: string, uri: string): void {
  const selector = `[data-asset-path="${rawPath.replace(/"/g, '\\"')}"]`;
  const els = Array.from(viewport!.querySelectorAll<HTMLElement>(selector));
  for (const el of els) {
    el.style.backgroundImage = `url("${uri}")`;
    el.style.backgroundRepeat = "no-repeat";

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
      // Scale the sheet so that the atlas region exactly fills the element.
      // Never override the element's CSS dimensions here — the layout engine has
      // already set them correctly (e.g. NineSlice Center spans the full inner area
      // via two opposing anchors; overriding to atlas size would shrink it to 64×64).
      const elemW = el.offsetWidth || crop.width;
      const elemH = el.offsetHeight || crop.height;
      const scaleX = elemW / crop.width;
      const scaleY = elemH / crop.height;
      const bgW = crop.sheetW * scaleX;
      const bgH = crop.sheetH * scaleY;
      el.style.backgroundSize = `${bgW}px ${bgH}px`;
      el.style.backgroundPosition = `${-crop.x * scaleX}px ${-crop.y * scaleY}px`;
      el.style.backgroundRepeat = crop.tilesH || crop.tilesV ? "repeat" : "no-repeat";
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
      el.style.backgroundSize = "100% 100%";
      el.style.backgroundPosition = "0% 0%";
    }

    const ph = el.querySelector("[data-placeholder]");
    if (ph) ph.remove();
    el.style.pointerEvents = "none";
  }
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
      try {
        if (msg.defaultFontUri) applyDefaultFont(msg.defaultFontUri);
        viewport!.innerHTML = "";
        const root = renderFrames(
          msg.frames,
          msg.viewport,
          msg.flavorConfig,
          (frameId, event, extra) => {
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
        currentConfig = msg.flavorConfig;
        currentScale = currentConfig.frameScale;
        if (currentWowViewport) updateRulers(currentWowViewport, currentScale, currentConfig);
        // On first render (not hot-reload), center the frame content in view.
        if (msg.type === "render") centerOnContent(msg.flavorConfig);
        let suffix = " ✓";
        if (msg.extractionPending)
          suffix =
            msg.pendingFiles > 0
              ? ` — ${msg.pendingFiles} texture${msg.pendingFiles === 1 ? "" : "s"} pending`
              : ` — pending`;
        else if (msg.warnings > 0)
          suffix = ` — ${msg.warnings} warning${msg.warnings === 1 ? "" : "s"}`;
        dbgRender(
          `rendered ${msg.frames.length} frame${msg.frames.length === 1 ? "" : "s"}${suffix}`,
        );
        requestRenderedAssets();
      } catch (e) {
        dbg(`render error: ${String(e)}`);
      }
      break;
    }

    case "assetResolved": {
      applyAsset(msg.path, msg.uri);
      break;
    }

    case "fontResolved": {
      applyDefaultFont(msg.uri);
      break;
    }

    case "setRuler": {
      setRulersVisible(msg.show);
      if (msg.show && currentWowViewport && currentConfig)
        updateRulers(currentWowViewport, currentScale, currentConfig);
      break;
    }

    case "setStatus": {
      if (msg.state === "idle") {
        if (debug && lastRenderMsg) debug.textContent = lastRenderMsg;
      } else {
        const label =
          msg.state === "extracting" ? "⏳ Extracting game assets…" : "⏳ Building atlas manifest…";
        if (debug) debug.textContent = label;
      }
      break;
    }
  }
});

// Tell the host we're ready
dbg("scryer ready, waiting for content");
vscode.postMessage({ type: "ready" });
