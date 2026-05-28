import type { Color, FontStringIR, FrameIR, TextureIR } from "../parser/ir.js";
import type { ResolvedFlavorConfig, Viewport } from "../protocol.js";
import type { Rect } from "./layout.js";
import { layoutAll } from "./layout.js";
import { frameZ, layerZ } from "./strata.js";
import { makePlaceholder } from "./placeholder.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cssColor(c: Color): string {
  const a = c.a ?? 1;
  return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`;
}

function applyRect(el: HTMLElement, rect: Rect, parentRect: Rect): void {
  el.style.position = "absolute";
  el.style.left = `${Math.round(rect.left - parentRect.left)}px`;
  el.style.top = `${Math.round(rect.top - parentRect.top)}px`;
  el.style.width = `${Math.round(rect.width)}px`;
  el.style.height = `${Math.round(rect.height)}px`;
}

// ---------------------------------------------------------------------------
// Texture rendering
// ---------------------------------------------------------------------------

function renderTexture(tex: TextureIR, rect: Rect): HTMLElement {
  const el = document.createElement("div");
  el.dataset.name = tex.name ?? "";
  el.dataset.kind = tex.kind;
  el.style.cssText = "position:absolute;overflow:hidden;";

  if (tex.color) {
    el.style.background = cssColor(tex.color);
  } else if (tex.file) {
    el.dataset.assetPath = tex.file;
    const ph = makePlaceholder(tex.file);
    ph.dataset.placeholder = "1";
    el.appendChild(ph);
  } else if (tex.atlas) {
    // Atlas resolution deferred (requires manifest); show labeled placeholder
    el.dataset.atlasName = tex.atlas;
    el.appendChild(makePlaceholder(tex.atlas, `[atlas] ${tex.atlas}`));
  } else {
    // No file or color — transparent slot; still show a faint outline
    el.style.outline = "1px dashed rgba(255,255,255,0.15)";
  }

  // Apply texCoords clipping hint as a data attribute (M3 will use these)
  if (tex.texCoords) {
    el.dataset.texCoords = JSON.stringify(tex.texCoords);
  }

  // Suppress if hidden
  if (tex.hidden) el.style.opacity = "0.4";
  if (tex.alpha !== undefined) el.style.opacity = String(tex.alpha);

  // Position: explicit rect if sized, otherwise fill parent with inset:0
  if (rect.width > 0 || rect.height > 0) {
    el.style.left = `${Math.round(rect.left)}px`;
    el.style.top = `${Math.round(rect.top)}px`;
    el.style.width = `${Math.round(rect.width)}px`;
    el.style.height = `${Math.round(rect.height)}px`;
  } else {
    el.style.inset = "0";
  }

  return el;
}

// ---------------------------------------------------------------------------
// FontString rendering
// ---------------------------------------------------------------------------

// CSS font-family stack for WoW text. "WoWDefaultFont" is populated by an
// @font-face rule injected by main.ts when the asset is available.
const WOW_FONT_STACK = '"WoWDefaultFont","Palatino Linotype","Book Antiqua",serif';

function renderFontString(fs: FontStringIR, rect: Rect, config: ResolvedFlavorConfig): HTMLElement {
  const el = document.createElement("div");
  el.dataset.name = fs.name ?? "";
  el.dataset.kind = "FontString";
  el.style.cssText = "position:absolute;overflow:hidden;display:flex;";

  // justifyH → text-align + flexbox justify
  const jh = fs.justifyH ?? "LEFT";
  const jv = fs.justifyV ?? "MIDDLE";

  const textAlignMap: Record<string, string> = { LEFT: "left", CENTER: "center", RIGHT: "right" };
  const justifyContentMap: Record<string, string> = {
    LEFT: "flex-start",
    CENTER: "center",
    RIGHT: "flex-end",
  };
  const alignItemsMap: Record<string, string> = {
    TOP: "flex-start",
    MIDDLE: "center",
    BOTTOM: "flex-end",
  };

  el.style.textAlign = textAlignMap[jh] ?? "left";
  el.style.justifyContent = justifyContentMap[jh] ?? "flex-start";
  el.style.alignItems = alignItemsMap[jv] ?? "center";

  const explicitSize = fs.fontSize ?? (rect.height > 0 ? Math.round(rect.height * 0.75) : 0);
  const fontSize = explicitSize > 0 ? explicitSize : config.defaultFontSize;
  const color = fs.color ? cssColor(fs.color) : cssColor(config.defaultTextColor);

  const span = document.createElement("span");
  span.textContent = fs.text ?? "";
  span.title = `FontString (approximate rendering)`;
  span.style.cssText = [
    `font-family:${WOW_FONT_STACK}`,
    `font-size:${fontSize}px`,
    `color:${color}`,
    "pointer-events:none",
  ].join(";");

  el.appendChild(span);

  if (rect.width > 0 || rect.height > 0) {
    el.style.left = `${Math.round(rect.left)}px`;
    el.style.top = `${Math.round(rect.top)}px`;
    el.style.width = `${Math.round(rect.width)}px`;
    el.style.height = `${Math.round(rect.height)}px`;
    el.style.inset = "";
  }

  if (fs.hidden) el.style.opacity = "0.4";

  return el;
}

// ---------------------------------------------------------------------------
// Frame rendering
// ---------------------------------------------------------------------------

function renderFrame(
  frame: FrameIR,
  frameRect: Rect,
  parentRect: Rect,
  rectMap: Map<FrameIR, Rect>,
  viewportRect: Rect,
  config: ResolvedFlavorConfig,
  isTopLevel = false,
): HTMLElement {
  const el = document.createElement("div");
  el.dataset.name = frame.name ?? "";
  el.dataset.kind = frame.kind;
  el.style.position = "absolute";
  el.style.overflow = "hidden";
  el.style.zIndex = String(frameZ(frame.frameStrata, frame.frameLevel));

  applyRect(el, frameRect, parentRect);

  // Top-level hidden frames are the preview subject — show them normally.
  // Child hidden frames are conditional overlays — dim them so layout is visible but reads inactive.
  if (frame.hidden && !isTopLevel) el.style.opacity = "0.4";
  if (frame.alpha !== undefined) el.style.opacity = String(frame.alpha);

  // Render layers (back → front)
  for (const layer of frame.layers) {
    const layerEl = document.createElement("div");
    layerEl.dataset.layer = layer.level;
    layerEl.style.cssText = `position:absolute;inset:0;z-index:${layerZ(layer.level, layer.subLevel)};`;

    // Layout all objects in the layer together so relativeKey references between
    // sibling render objects (e.g. Middle anchored to Left/Right) can resolve.
    const layerObjRectMap = layoutAll(layer.objects as unknown as FrameIR[], {
      w: frameRect.width,
      h: frameRect.height,
    });

    for (const obj of layer.objects) {
      const objFrameIR = obj as unknown as FrameIR;
      const objRect = layerObjRectMap.get(objFrameIR) ?? {
        left: 0,
        top: 0,
        width: frameRect.width,
        height: frameRect.height,
      };

      let objEl: HTMLElement;
      if (obj.kind === "FontString") {
        objEl = renderFontString(obj, objRect, config);
      } else {
        objEl = renderTexture(obj as TextureIR, objRect);
      }
      layerEl.appendChild(objEl);
    }

    el.appendChild(layerEl);
  }

  // Button state textures (rendered in BORDER layer equivalent)
  const stateTextures = [
    frame.normalTexture,
    frame.pushedTexture,
    frame.disabledTexture,
    frame.highlightTexture,
  ].filter(Boolean) as TextureIR[];
  if (stateTextures.length > 0) {
    const stateEl = document.createElement("div");
    stateEl.dataset.layer = "state-textures";
    stateEl.style.cssText = "position:absolute;inset:0;z-index:1;";
    for (const tex of stateTextures) {
      stateEl.appendChild(
        renderTexture(tex, { left: 0, top: 0, width: frameRect.width, height: frameRect.height }),
      );
    }
    el.appendChild(stateEl);
  }

  // Recursively render children
  for (const child of frame.children) {
    const childRect = rectMap.get(child) ?? frameRect;
    el.appendChild(renderFrame(child, childRect, frameRect, rectMap, viewportRect, config));
  }

  return el;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Render a list of resolved FrameIRs into a container div sized to the viewport.
 * All layout is computed here (no DOM measurements needed for M2).
 */
export function renderFrames(
  frames: FrameIR[],
  viewport: Viewport,
  config: ResolvedFlavorConfig,
): HTMLElement {
  const container = document.createElement("div");
  container.id = "wow-viewport";

  const scale = config.frameScale;
  container.style.cssText = [
    "position:relative",
    `width:${viewport.w}px`,
    `height:${viewport.h}px`,
    "overflow:hidden",
    "background-color:#555",
    "background-image:repeating-conic-gradient(#444 0% 25%,#666 0% 50%)",
    "background-size:128px 128px",
    ...(scale !== 1 ? [`transform:scale(${scale})`, "transform-origin:top left"] : []),
  ].join(";");

  const viewportRect: Rect = { left: 0, top: 0, width: viewport.w, height: viewport.h };

  // Filter out virtual frames (templates) — host should already do this, but be safe
  const renderable = frames.filter((f) => !f.virtual);
  const rectMap = layoutAll(renderable, viewport);

  for (const frame of renderable) {
    const rect = rectMap.get(frame) ?? viewportRect;
    container.appendChild(
      renderFrame(frame, rect, viewportRect, rectMap, viewportRect, config, true),
    );
  }

  return container;
}
