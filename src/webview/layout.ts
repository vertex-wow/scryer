import type { Anchor, FrameIR, FramePoint } from "../parser/ir.js";

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Point fractions in CSS space: (0,0) = top-left, (1,1) = bottom-right
// WoW y-up is inverted: TOPLEFT.y_wow=1 → CSS y=0 (top), BOTTOMRIGHT.y_wow=0 → CSS y=1 (bottom)
// ---------------------------------------------------------------------------

export const POINT_FRACTION: Record<FramePoint, { x: number; y: number }> = {
  TOPLEFT: { x: 0, y: 0 },
  TOP: { x: 0.5, y: 0 },
  TOPRIGHT: { x: 1, y: 0 },
  LEFT: { x: 0, y: 0.5 },
  CENTER: { x: 0.5, y: 0.5 },
  RIGHT: { x: 1, y: 0.5 },
  BOTTOMLEFT: { x: 0, y: 1 },
  BOTTOM: { x: 0.5, y: 1 },
  BOTTOMRIGHT: { x: 1, y: 1 },
};

/** CSS pixel position of a named point on a rect. */
export function pointOnRect(point: FramePoint, rect: Rect): { x: number; y: number } {
  const f = POINT_FRACTION[point];
  return { x: rect.left + f.x * rect.width, y: rect.top + f.y * rect.height };
}

/**
 * Resolve the CSS pixel position (in viewport coords) where the anchor's
 * relativePoint lands on the target, with WoW offsets applied.
 * xOffset: positive = right. yOffset: positive = up (WoW) = negative CSS y.
 */
export function resolveAnchorPoint(anchor: Anchor, targetRect: Rect): { x: number; y: number } {
  const relPt = anchor.relativePoint ?? anchor.point;
  const base = pointOnRect(relPt, targetRect);
  return { x: base.x + (anchor.x ?? 0), y: base.y - (anchor.y ?? 0) };
}

/** Layout from a single anchor + explicit size. Returns absolute rect. */
export function layoutByOneAnchor(
  anchor: Anchor,
  targetRect: Rect,
  width: number,
  height: number,
): Rect {
  const { x: ax, y: ay } = resolveAnchorPoint(anchor, targetRect);
  const self = POINT_FRACTION[anchor.point];
  return { left: ax - self.x * width, top: ay - self.y * height, width, height };
}

/**
 * Layout from two anchors. Derives size from the span between anchor points
 * (or uses explicit size if provided). Returns absolute rect.
 *
 * Solves:
 *   frameLeft + f1.x * w = p1.x   →   left = p1.x - f1.x * w
 *   frameLeft + f2.x * w = p2.x   →   w = (p2.x - p1.x) / (f2.x - f1.x)
 * (same for y/height)
 */
export function layoutByTwoAnchors(
  anchor1: Anchor,
  target1: Rect,
  anchor2: Anchor,
  target2: Rect,
  explicitWidth?: number,
  explicitHeight?: number,
): Rect {
  const p1 = resolveAnchorPoint(anchor1, target1);
  const p2 = resolveAnchorPoint(anchor2, target2);
  const f1 = POINT_FRACTION[anchor1.point];
  const f2 = POINT_FRACTION[anchor2.point];

  let width = explicitWidth;
  if (width === undefined && Math.abs(f2.x - f1.x) > 1e-9) {
    width = (p2.x - p1.x) / (f2.x - f1.x);
  }
  width ??= 0;

  let height = explicitHeight;
  if (height === undefined && Math.abs(f2.y - f1.y) > 1e-9) {
    height = (p2.y - p1.y) / (f2.y - f1.y);
  }
  height ??= 0;

  return { left: p1.x - f1.x * width, top: p1.y - f1.y * height, width, height };
}

// ---------------------------------------------------------------------------
// Multi-frame layout pass
// ---------------------------------------------------------------------------

const UI_PARENT = "UIParent";
const MAX_LAYOUT_ITERATIONS = 64;

type FrameRegistry = Map<string, FrameIR>;
type RectMap = Map<FrameIR, Rect>;

/** Collect all named frames (recursively) into the registry. */
function collectNames(frames: FrameIR[], registry: FrameRegistry): void {
  for (const frame of frames) {
    if (frame.name) registry.set(frame.name.toLowerCase(), frame);
    if (frame.children) collectNames(frame.children, registry);
  }
}

/** Collect all frames in BFS order (parents before children). */
function collectAll(frames: FrameIR[], out: FrameIR[]): void {
  for (const f of frames) {
    out.push(f);
    if (f.children) collectAll(f.children, out);
  }
}

/**
 * Resolve the anchor target rect. Returns undefined if the target hasn't been
 * laid out yet (caller should retry later).
 */
function resolveTarget(
  anchor: Anchor,
  parentRect: Rect,
  viewportRect: Rect,
  rectMap: RectMap,
  registry: FrameRegistry,
): Rect | undefined {
  const relativeTo = anchor.relativeTo;
  if (!relativeTo || relativeTo === UI_PARENT) return viewportRect;

  // Named target
  const target = registry.get(relativeTo.toLowerCase());
  if (!target) return viewportRect; // unresolvable name → fall back to viewport
  return rectMap.get(target); // undefined if not yet laid out
}

/**
 * Try to compute the layout rect for a single frame given current resolved rects.
 * Returns undefined if any anchor target hasn't been resolved yet.
 */
function tryLayout(
  frame: FrameIR,
  parentRect: Rect,
  viewportRect: Rect,
  rectMap: RectMap,
  registry: FrameRegistry,
): Rect | undefined {
  const w = frame.size?.x;
  const h = frame.size?.y;

  // setAllPoints: match first anchor's target exactly (or parent if no target)
  if (frame.setAllPoints) {
    const anchor: Anchor = { point: "TOPLEFT", relativeTo: frame.anchors[0]?.relativeTo };
    const target = resolveTarget(anchor, parentRect, viewportRect, rectMap, registry);
    return target;
  }

  const anchors = frame.anchors;

  if (anchors.length >= 2) {
    const t1 = resolveTarget(anchors[0], parentRect, viewportRect, rectMap, registry);
    const t2 = resolveTarget(anchors[1], parentRect, viewportRect, rectMap, registry);
    if (!t1 || !t2) return undefined;
    return layoutByTwoAnchors(anchors[0], t1, anchors[1], t2, w, h);
  }

  if (anchors.length === 1) {
    const t = resolveTarget(anchors[0], parentRect, viewportRect, rectMap, registry);
    if (!t) return undefined;
    return layoutByOneAnchor(anchors[0], t, w ?? 0, h ?? 0);
  }

  // No anchors: place at parent top-left with explicit or zero size
  return { left: parentRect.left, top: parentRect.top, width: w ?? 0, height: h ?? 0 };
}

/**
 * Compute absolute layout rects for all frames (relative to the viewport).
 * Uses an iterative approach to handle anchor chains and forward references.
 */
export function layoutAll(frames: FrameIR[], viewport: { w: number; h: number }): RectMap {
  const viewportRect: Rect = { left: 0, top: 0, width: viewport.w, height: viewport.h };

  const registry: FrameRegistry = new Map();
  collectNames(frames, registry);

  const allFrames: FrameIR[] = [];
  collectAll(frames, allFrames);

  // Build parent map so we can find each frame's parent rect
  const parentMap = new Map<FrameIR, FrameIR | null>();
  function buildParents(children: FrameIR[], parent: FrameIR | null): void {
    for (const f of children) {
      parentMap.set(f, parent);
      if (f.children) buildParents(f.children, f);
    }
  }
  buildParents(frames, null);

  const rectMap: RectMap = new Map();

  for (let iter = 0; iter < MAX_LAYOUT_ITERATIONS; iter++) {
    let changed = false;
    for (const frame of allFrames) {
      if (rectMap.has(frame)) continue;

      const parent = parentMap.get(frame) ?? null;
      const parentRect = parent ? rectMap.get(parent) : viewportRect;
      if (!parentRect) continue; // parent not resolved yet

      const rect = tryLayout(frame, parentRect, viewportRect, rectMap, registry);
      if (rect) {
        rectMap.set(frame, rect);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Assign fallback rects to anything still unresolved
  for (const frame of allFrames) {
    if (!rectMap.has(frame)) {
      const parent = parentMap.get(frame) ?? null;
      const parentRect = (parent ? rectMap.get(parent) : undefined) ?? viewportRect;
      rectMap.set(frame, { left: parentRect.left, top: parentRect.top, width: 0, height: 0 });
    }
  }

  return rectMap;
}
