import type { DrawLayer, FrameStrata } from "../parser/ir.js";

// Strata order (low → high). Index × 1000 = base z-index.
const STRATA_ORDER: FrameStrata[] = [
  "PARENT",
  "BACKGROUND",
  "LOW",
  "MEDIUM",
  "HIGH",
  "DIALOG",
  "FULLSCREEN",
  "FULLSCREEN_DIALOG",
  "TOOLTIP",
  "BLIZZARD",
];

const STRATA_INDEX: Record<FrameStrata, number> = Object.fromEntries(
  STRATA_ORDER.map((s, i) => [s, i]),
) as Record<FrameStrata, number>;

// Draw layer order (back → front). Multiplied by 20 to leave room for subLevel.
const LAYER_ORDER: DrawLayer[] = ["BACKGROUND", "BORDER", "ARTWORK", "OVERLAY", "HIGHLIGHT"];

const LAYER_INDEX: Record<DrawLayer, number> = Object.fromEntries(
  LAYER_ORDER.map((l, i) => [l, i]),
) as Record<DrawLayer, number>;

/** Frame-level z-index: strataBase * 1000 + frameLevel. */
export function frameZ(strata: FrameStrata | undefined, frameLevel: number | undefined): number {
  const strataBase = strata ? (STRATA_INDEX[strata] ?? 3) : 3; // default: MEDIUM
  return strataBase * 1000 + (frameLevel ?? 0);
}

/**
 * Layer z-index within a frame: (layerIndex * 20 + subLevel + 8).
 * subLevel range is −8..7, so adding 8 keeps it non-negative.
 */
export function layerZ(layer: DrawLayer, subLevel: number): number {
  return (LAYER_INDEX[layer] ?? 2) * 20 + subLevel + 8;
}
