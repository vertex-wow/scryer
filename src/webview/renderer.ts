import type { Color, FontStringIR, FrameIR, TextureIR } from "../parser/ir.js";
import type { ResolvedFlavorConfig, Viewport } from "../protocol.js";
import type { Rect } from "./layout.js";
import { layoutAll } from "./layout.js";
import { makePlaceholder } from "./placeholder.js";
import { frameZ, layerZ } from "./strata.js";

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

function renderTexture(tex: TextureIR, rect: Rect, config: ResolvedFlavorConfig): HTMLElement {
  const el = document.createElement("div");
  el.dataset.name = tex.name ?? "";
  el.dataset.kind = tex.kind;
  el.style.cssText = "position:absolute;overflow:hidden;";

  if (tex.color) {
    el.style.background = cssColor(tex.color);
    el.style.pointerEvents = "none";
  } else if (tex.resolvedAtlas) {
    const ra = tex.resolvedAtlas;
    el.dataset.assetPath = ra.file;
    el.dataset.atlasCrop = JSON.stringify({
      x: ra.x,
      y: ra.y,
      width: ra.width,
      height: ra.height,
      sheetW: ra.sheetW,
      sheetH: ra.sheetH,
      tilesH: tex.horizTile ?? ra.tilesH,
      tilesV: tex.vertTile ?? ra.tilesV,
      useAtlasSize: tex.useAtlasSize ?? false,
    });
    const ph = makePlaceholder(ra.file, config);
    ph.dataset.placeholder = "1";
    el.appendChild(ph);
    el.style.pointerEvents = "auto";
  } else if (tex.file) {
    el.dataset.assetPath = tex.file;
    const ph = makePlaceholder(tex.file, config);
    ph.dataset.placeholder = "1";
    el.appendChild(ph);
    el.style.pointerEvents = "auto";
  } else if (tex.atlas) {
    // Atlas name present but no manifest entry — show labeled placeholder
    el.dataset.atlasName = tex.atlas;
    el.appendChild(makePlaceholder(tex.atlas, config, `[atlas] ${tex.atlas}`));
    el.style.pointerEvents = "auto";
  } else {
    // No file or color — transparent slot; still show a faint outline
    el.style.outline = "1px dashed rgba(255,255,255,0.15)";
    el.style.pointerEvents = "none";
  }

  if (tex.texCoords) {
    el.dataset.texCoords = JSON.stringify(tex.texCoords);
  }

  // Suppress if hidden
  if (tex.hidden) el.style.opacity = "0.4";
  if (tex.alpha !== undefined) el.style.opacity = String(tex.alpha);

  // Position: explicit rect if sized; useAtlasSize falls back to atlas dimensions; else fill parent.
  if (rect.width > 0 || rect.height > 0) {
    el.style.left = `${Math.round(rect.left)}px`;
    el.style.top = `${Math.round(rect.top)}px`;
    el.style.width = `${Math.round(rect.width)}px`;
    el.style.height = `${Math.round(rect.height)}px`;
  } else if (tex.useAtlasSize && tex.resolvedAtlas) {
    el.style.left = `${Math.round(rect.left)}px`;
    el.style.top = `${Math.round(rect.top)}px`;
    el.style.width = `${tex.resolvedAtlas.width}px`;
    el.style.height = `${tex.resolvedAtlas.height}px`;
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
const WOW_FONT_STACK = '"WoWDefaultFont",sans-serif';

function renderFontString(fs: FontStringIR, rect: Rect, config: ResolvedFlavorConfig): HTMLElement {
  const el = document.createElement("div");
  el.dataset.name = fs.name ?? "";
  el.dataset.kind = "FontString";
  el.style.cssText = "position:absolute;overflow:hidden;display:flex;";

  // justifyH → text-align + flexbox justify
  const jh = fs.justifyH ?? "CENTER";
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

  const explicitSize =
    fs.fontSize ?? (rect.height > 0 ? Math.round(rect.height * config.autoFontSizeRatio) : 0);
  const fontSize = explicitSize > 0 ? explicitSize : config.defaultFontSize;
  const color = fs.color ? cssColor(fs.color) : cssColor(config.defaultTextColor);

  const span = document.createElement("span");
  span.textContent = fs.text ?? "";
  span.title = `FontString (approximate rendering)`;
  span.style.cssText = [
    `font-family:${WOW_FONT_STACK}`,
    `font-size:${fontSize}px`,
    `color:${color}`,
    // WoW's DirectWrite renderer produces ~6.3% wider advance widths than the
    // browser's ClearType renderer for the same font. Calibrated against FRIZQT__
    // at height=12 (18 chars: WoW=151px vs browser=142px at 125% DPI → 0.033em).
    // Override fontLetterSpacingEm in your flavor config when using a different font.
    `letter-spacing:${config.fontLetterSpacing}`,
    // WoW uses DirectWrite grayscale AA; browser default on Windows is ClearType (subpixel).
    // Switching to antialiased makes rendered weight match more closely.
    `-webkit-font-smoothing:${config.fontSmoothing}`,
    "pointer-events:none",
  ].join(";");

  el.appendChild(span);

  // WoW FontStrings with no explicit size default to full parent width, auto height.
  // A zero-size rect means the anchor computed position but no size was given.
  el.style.inset = "";
  el.style.top = `${Math.round(rect.top)}px`;
  if (rect.width > 0) {
    el.style.left = `${Math.round(rect.left)}px`;
    el.style.width = `${Math.round(rect.width)}px`;
  } else {
    el.style.left = "0";
    el.style.width = "100%";
  }
  if (rect.height > 0) {
    el.style.height = `${Math.round(rect.height)}px`;
  }

  if (fs.hidden) el.style.opacity = "0.4";

  return el;
}

// ---------------------------------------------------------------------------
// Frame rendering
// ---------------------------------------------------------------------------

type FrameEventCallback = (frameId: number, event: string, extra: unknown[]) => void;

function renderFrame(
  frame: FrameIR,
  frameRect: Rect,
  parentRect: Rect,
  rectMap: Map<FrameIR, Rect>,
  viewportRect: Rect,
  config: ResolvedFlavorConfig,
  onFrameEvent: FrameEventCallback | undefined,
  isTopLevel = false,
): HTMLElement {
  const el = document.createElement("div");
  el.dataset.name = frame.name ?? "";
  el.dataset.kind = frame.kind;
  el.style.position = "absolute";
  el.style.overflow = "hidden";
  // useParentLevel frames share the parent's frame level in WoW — their content should
  // composite below the parent's ARTWORK layer. CSS stacking can't split a child's layers
  // across parent layers, so we approximate by placing the whole child div in the BORDER
  // z-range (28), above parent BACKGROUND (8) but below parent ARTWORK (48).
  el.style.zIndex = frame.useParentLevel
    ? String(layerZ("BORDER", 0))
    : String(frameZ(frame.frameStrata, frame.frameLevel));

  applyRect(el, frameRect, parentRect);

  // Top-level hidden frames are the preview subject — show them normally.
  // Child hidden frames are conditional overlays — dim them so layout is visible but reads inactive.
  if (frame.hidden && !isTopLevel) el.style.opacity = "0.4";
  if (frame.alpha !== undefined) el.style.opacity = String(frame.alpha);

  // Attach mouse event listeners for interactive frames (those with OnClick/OnEnter/OnLeave handlers).
  if (frame.interactive && frame.runtimeId !== undefined && onFrameEvent) {
    const rId = frame.runtimeId;
    el.style.cursor = "pointer";
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      onFrameEvent(rId, "OnClick", ["LeftButton", true]);
    });
    el.addEventListener("mouseenter", () => {
      onFrameEvent(rId, "OnEnter", []);
    });
    el.addEventListener("mouseleave", () => {
      onFrameEvent(rId, "OnLeave", []);
    });
  }

  // Inject atlas size for useAtlasSize textures across all layers before layout.
  // This mirrors WoW: SetAtlas(name, true) sets the initial size; opposing anchors
  // may then override on the constrained axis.
  for (const layer of frame.layers) {
    for (const obj of layer.objects) {
      if (obj.kind === "Texture" || obj.kind === "MaskTexture") {
        const tex = obj as TextureIR;
        if (tex.useAtlasSize && tex.resolvedAtlas && !tex.size) {
          tex.size = { x: tex.resolvedAtlas.width, y: tex.resolvedAtlas.height };
        }
      }
    }
  }

  // Single layout pass across ALL layer objects so cross-layer anchor references
  // resolve correctly (e.g. NineSlice Center anchors to BORDER-layer corners).
  const allObjects = frame.layers.flatMap((l) => l.objects);
  const globalRectMap = layoutAll(
    allObjects as unknown as FrameIR[],
    { w: frameRect.width, h: frameRect.height },
    { epsilon: config.layoutEpsilon, maxIterations: config.layoutMaxIterations },
  );

  // Render layers (back → front)
  for (const layer of frame.layers) {
    const layerEl = document.createElement("div");
    layerEl.dataset.layer = layer.level;
    layerEl.style.cssText = `position:absolute;inset:0;z-index:${layerZ(layer.level, layer.subLevel)};pointer-events:none;`;

    for (const obj of layer.objects) {
      const objFrameIR = obj as unknown as FrameIR;
      const objRect = globalRectMap.get(objFrameIR) ?? {
        left: 0,
        top: 0,
        width: frameRect.width,
        height: frameRect.height,
      };

      let objEl: HTMLElement;
      if (obj.kind === "FontString") {
        objEl = renderFontString(obj, objRect, config);
      } else {
        objEl = renderTexture(obj as TextureIR, objRect, config);
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
    stateEl.style.cssText = "position:absolute;inset:0;z-index:1;pointer-events:none;";
    for (const tex of stateTextures) {
      stateEl.appendChild(
        renderTexture(
          tex,
          { left: 0, top: 0, width: frameRect.width, height: frameRect.height },
          config,
        ),
      );
    }
    el.appendChild(stateEl);
  }

  // Recursively render children
  for (const child of frame.children) {
    const childRect = rectMap.get(child) ?? frameRect;
    el.appendChild(
      renderFrame(child, childRect, frameRect, rectMap, viewportRect, config, onFrameEvent),
    );
  }

  return el;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Render a list of resolved FrameIRs into a container div sized to the viewport.
 * All layout is computed here (no DOM measurements needed for M2).
 * Pass onFrameEvent to receive click/enter/leave events from interactive frames.
 */
export function renderFrames(
  frames: FrameIR[],
  viewport: Viewport,
  config: ResolvedFlavorConfig,
  onFrameEvent?: FrameEventCallback,
): HTMLElement {
  const container = document.createElement("div");
  container.id = "wow-viewport";

  const scale = config.frameScale;
  const checkerSize = config.viewportCheckerSize;
  container.style.cssText = [
    "position:relative",
    `width:${viewport.w}px`,
    `height:${viewport.h}px`,
    "overflow:hidden",
    `background-color:${config.viewportBg}`,
    `background-image:repeating-conic-gradient(${config.viewportCheckerDark} 0% 25%,${config.viewportCheckerLight} 0% 50%)`,
    `background-size:${checkerSize}px ${checkerSize}px`,
    ...(scale !== 1 ? [`transform:scale(${scale})`, "transform-origin:top left"] : []),
  ].join(";");

  const viewportRect: Rect = { left: 0, top: 0, width: viewport.w, height: viewport.h };

  // Filter out virtual frames (templates) — host should already do this, but be safe
  const renderable = frames.filter((f) => !f.virtual);
  const rectMap = layoutAll(renderable, viewport, {
    epsilon: config.layoutEpsilon,
    maxIterations: config.layoutMaxIterations,
  });

  for (const frame of renderable) {
    const rect = rectMap.get(frame) ?? viewportRect;
    container.appendChild(
      renderFrame(frame, rect, viewportRect, rectMap, viewportRect, config, onFrameEvent, true),
    );
  }

  return container;
}
