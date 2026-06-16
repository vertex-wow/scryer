import type { Color, FontStringIR, FrameIR, TextureIR } from "../parser/ir.js";
import type { ResolvedFlavorConfig, Viewport } from "../protocol.js";
import type { Rect } from "./layout.js";
import { layoutAll } from "./layout.js";
import { makePlaceholder } from "./components/placeholder.js";
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
    if (tex.horizTile) el.dataset.horizTile = "true";
    if (tex.vertTile) el.dataset.vertTile = "true";
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
    // No file or color — transparent slot; render nothing visible.
    el.style.pointerEvents = "none";
  }

  if (tex.texCoords) {
    el.dataset.texCoords = JSON.stringify(tex.texCoords);
  }
  if (tex.maskFile) {
    el.dataset.maskFile = tex.maskFile;
  }

  // Suppress if hidden
  if (tex.hidden) el.style.opacity = "0.4";
  if (tex.alpha !== undefined) el.style.opacity = String(tex.alpha);

  // Position: explicit rect if sized; useAtlasSize falls back to atlas dimensions; else fill parent.
  if (rect.width > 0 || rect.height > 0) {
    // Seam bleed for h-only tiles (TopEdge, BottomEdge): extend 1 CSS px each side to
    // prevent the 1-device-pixel transparent gap that appears at corner/edge element
    // boundaries under fractional DPR × panZoom. These tiles are x-uniform (pure
    // y-gradient), so the overlap columns are visually identical to the main content.
    //
    // Seam bleed for v-only tiles (LeftEdge, RightEdge): same principle in the
    // orthogonal axis — extend 1 CSS px top and bottom. These tiles are y-uniform
    // (pure x-gradient), so the overlap rows are visually identical to the main
    // content. bgPosY stays 0 (crop.y = 0 for all DiamondMetal vertical atlas
    // entries), so atlas content begins at element y=0, covering the corner's
    // semi-transparent bottom row instead of leaving it uncoated.
    const ra = tex.resolvedAtlas;
    const seamBleed = ra && (tex.horizTile ?? ra.tilesH) && !(tex.vertTile ?? ra.tilesV) ? 1 : 0;
    const seamBleedV = ra && (tex.vertTile ?? ra.tilesV) && !(tex.horizTile ?? ra.tilesH) ? 1 : 0;
    el.style.left = `${Math.round(rect.left) - seamBleed}px`;
    el.style.top = `${Math.round(rect.top) - seamBleedV}px`;
    el.style.width = `${Math.round(rect.width) + 2 * seamBleed}px`;
    el.style.height = `${Math.round(rect.height) + 2 * seamBleedV}px`;
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
  // WoW never clips frame children — portrait icons, tooltips, and NineSlice corners all
  // intentionally bleed past their parent's bounds.
  el.style.overflow = "visible";
  // useParentLevel frames share the parent's frame level in WoW — their content should
  // composite below the parent's ARTWORK layer. CSS stacking can't split a child's layers
  // across parent layers, so we approximate by placing the whole child div in the BORDER
  // z-range (28), above parent BACKGROUND (8) but below parent ARTWORK (48).
  el.style.zIndex = frame.useParentLevel
    ? String(layerZ("BORDER", 0))
    : String(frameZ(frame.frameStrata, frame.frameLevel));

  applyRect(el, frameRect, parentRect);

  // Top-level hidden frames are the preview subject — show them normally.
  // Child hidden frames respect WoW's actual visibility: display:none so panels and
  // conditional overlays don't bleed through when programmatically hidden.
  if (frame.hidden && !isTopLevel) el.style.display = "none";
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

  // Attach drag listeners for movable frames (those with OnDragStart handlers).
  if (frame.draggable && frame.runtimeId !== undefined && onFrameEvent) {
    const rId = frame.runtimeId;
    el.style.cursor = "grab";
    el.addEventListener("mousedown", (e: MouseEvent) => {
      if (e.button !== 0) return;
      if (document.body.classList.contains("mode-grab")) return;
      e.stopPropagation();
      e.preventDefault();
      // Ratio of screen px to element-local CSS px, accounting for panZoom + frameScale + uiScale.
      const screenToLocal = el.offsetWidth / el.getBoundingClientRect().width;
      let prevX = e.clientX;
      let prevY = e.clientY;
      let tx = 0;
      let ty = 0;
      el.style.cursor = "grabbing";
      onFrameEvent(rId, "OnDragStart", ["LeftButton"]);
      const onMove = (me: MouseEvent) => {
        tx += (me.clientX - prevX) * screenToLocal;
        ty += (me.clientY - prevY) * screenToLocal;
        prevX = me.clientX;
        prevY = me.clientY;
        el.style.transform = `translate(${tx}px,${ty}px)`;
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        el.style.cursor = "grab";
        onFrameEvent(rId, "OnDragStop", []);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
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

  // Render layers (back → front), skipping HIGHLIGHT (hover-only in WoW — always showing
  // it causes ghosting on button templates that use ADD-blend hover textures).
  for (const layer of frame.layers) {
    if (layer.level === "HIGHLIGHT") continue;
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

  // Button state textures: normalTexture is the default visible state.
  // pushedTexture is rendered separately below and swapped in via CSS :active.
  // highlightTexture is rendered separately below with CSS :hover.
  const stateTextures = [frame.normalTexture].filter(Boolean) as TextureIR[];
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

  // pushedTexture: hidden by default; CSS swaps it in (and hides normalTexture) on :active.
  if (frame.pushedTexture && (frame.pushedTexture.resolvedAtlas || frame.pushedTexture.file)) {
    const pushedEl = document.createElement("div");
    pushedEl.dataset.layer = "pushed-texture";
    pushedEl.style.cssText = "position:absolute;inset:0;z-index:1;pointer-events:none;opacity:0;";
    pushedEl.appendChild(
      renderTexture(
        frame.pushedTexture,
        { left: 0, top: 0, width: frameRect.width, height: frameRect.height },
        config,
      ),
    );
    el.appendChild(pushedEl);
  }

  // highlightTexture: approximates WoW's ADD blend with mix-blend-mode:screen.
  // Hidden by default; CSS makes it visible on button hover.
  // Skip entirely if the texture has no resolved asset — no placeholder flash.
  if (
    frame.highlightTexture &&
    (frame.highlightTexture.resolvedAtlas || frame.highlightTexture.file)
  ) {
    const hlEl = document.createElement("div");
    hlEl.dataset.layer = "highlight-texture";
    hlEl.style.cssText =
      "position:absolute;inset:0;z-index:2;pointer-events:none;mix-blend-mode:screen;opacity:0;";
    hlEl.appendChild(
      renderTexture(
        frame.highlightTexture,
        { left: 0, top: 0, width: frameRect.width, height: frameRect.height },
        config,
      ),
    );
    el.appendChild(hlEl);
  }

  // StatusBar fill bar — rendered above layers, below children.
  if (frame.kind === "StatusBar" && frame.statusBarFill !== undefined) {
    const pct = frame.statusBarFill * 100;
    const vertical = frame.statusBarOrientation === "VERTICAL";
    const fillEl = document.createElement("div");
    fillEl.dataset.layer = "statusbar-fill";
    fillEl.style.position = "absolute";
    fillEl.style.pointerEvents = "none";
    fillEl.style.zIndex = String(layerZ("ARTWORK", 0)); // sits in the ARTWORK band
    if (vertical) {
      fillEl.style.left = "0";
      fillEl.style.right = "0";
      fillEl.style.bottom = "0";
      fillEl.style.height = `${pct}%`;
    } else {
      fillEl.style.top = "0";
      fillEl.style.bottom = "0";
      fillEl.style.left = "0";
      fillEl.style.width = `${pct}%`;
    }
    if (frame.statusBarFillPath) {
      fillEl.style.backgroundImage = `url("${frame.statusBarFillPath}")`;
      fillEl.style.backgroundSize = vertical ? "100% auto" : "auto 100%";
      fillEl.style.backgroundRepeat = "repeat";
    } else {
      const c = frame.statusBarFillColor;
      fillEl.style.backgroundColor = c
        ? `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${c.a})`
        : "rgba(0,120,220,0.85)";
    }
    el.appendChild(fillEl);
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
 * Set respectTopLevelHidden to honor the hidden flag on root-level frames (live update mode).
 */
export function renderFrames(
  frames: FrameIR[],
  viewport: Viewport,
  config: ResolvedFlavorConfig,
  onFrameEvent?: FrameEventCallback,
  opts?: { respectTopLevelHidden?: boolean },
): HTMLElement {
  const container = document.createElement("div");
  container.id = "wow-viewport";

  const scale = config.frameScale;
  const checkerSize = config.viewportCheckerSize;
  container.style.cssText = [
    "position:relative",
    `width:${config.screenWidth}px`,
    `height:${config.screenHeight}px`,
    "overflow:hidden",
    `background-color:${config.viewportBg}`,
    `background-image:repeating-conic-gradient(${config.viewportCheckerDark} 0% 25%,${config.viewportCheckerLight} 0% 50%)`,
    `background-size:${checkerSize}px ${checkerSize}px`,
    ...(scale !== 1 ? [`transform:scale(${scale})`, "transform-origin:top left"] : []),
  ].join(";");

  const uiScale = config.screenHeight / viewport.h;
  const logicalParent = document.createElement("div");
  logicalParent.id = "wow-logical-parent";
  logicalParent.style.cssText = [
    "position:absolute",
    "inset:0",
    "transform-origin:top left",
    `transform:scale(${uiScale})`,
  ].join(";");
  container.appendChild(logicalParent);

  const viewportRect: Rect = { left: 0, top: 0, width: viewport.w, height: viewport.h };

  // Filter out virtual frames (templates) — host should already do this, but be safe
  const renderable = frames.filter((f) => !f.virtual);
  const rectMap = layoutAll(renderable, viewport, {
    epsilon: config.layoutEpsilon,
    maxIterations: config.layoutMaxIterations,
  });

  const isTopLevelVisible = !opts?.respectTopLevelHidden;
  for (const frame of renderable) {
    const rect = rectMap.get(frame) ?? viewportRect;
    logicalParent.appendChild(
      renderFrame(
        frame,
        rect,
        viewportRect,
        rectMap,
        viewportRect,
        config,
        onFrameEvent,
        isTopLevelVisible,
      ),
    );
  }

  return container;
}
