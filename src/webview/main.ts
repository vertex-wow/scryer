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

// Current WoW viewport element, scale, and config — retained so scroll/resize can redraw rulers.
let currentWowViewport: HTMLElement | null = null;
let currentScale = 1;
let currentConfig: ResolvedFlavorConfig | null = null;

function dbg(msg: string): void {
  if (debug) debug.textContent = msg;
}

dbg("script loaded — waiting for ready handshake");

initRulers();

// Tooltip for placeholder elements — custom overlay, immune to the DOM
// mutations that reset native title-attribute tooltip dwell timers.
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

document.getElementById("ruler-toggle")?.addEventListener("click", () => {
  vscode.postMessage({ type: "toggleRuler" });
});

window.addEventListener("scroll", () => {
  if (currentWowViewport && currentConfig)
    updateRulers(currentWowViewport, currentScale, currentConfig);
});

window.addEventListener("resize", () => {
  if (currentWowViewport && currentConfig)
    updateRulers(currentWowViewport, currentScale, currentConfig);
});

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

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case "render":
    case "reload": {
      dbg(
        `render received — ${msg.frames.length} frame(s), viewport ${msg.viewport.w}x${msg.viewport.h}`,
      );
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
        // On first render (not hot-reload), scroll so the WoW origin sits at the
        // natural gutter position rather than flush against the scroll boundary.
        if (msg.type === "render") {
          const padH = Math.round(msg.flavorConfig.uiParentWidth * msg.flavorConfig.frameScale);
          const padV = Math.round(msg.flavorConfig.uiParentHeight * msg.flavorConfig.frameScale);
          window.scrollTo(padH, padV);
        }
        let suffix = " OK";
        if (msg.extractionPending)
          suffix = msg.pendingFiles > 0 ? ` — ${msg.pendingFiles} file(s) pending` : ` — pending`;
        else if (msg.warnings > 0) suffix = ` — ${msg.warnings} warning(s)`;
        dbg(`rendered ${msg.frames.length} frame(s)${suffix}`);
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
  }
});

// Tell the host we're ready
dbg("posting ready");
vscode.postMessage({ type: "ready" });
