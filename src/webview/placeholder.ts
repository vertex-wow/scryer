import type { ResolvedFlavorConfig } from "../protocol.js";

/**
 * Deterministic placeholder color for a texture path.
 * Uses djb2-style hash (seed 5381) to produce a hue, then converts to a muted
 * HSL color so placeholders are visually distinct but don't scream.
 */
export function placeholderColor(path: string, config: ResolvedFlavorConfig): string {
  let hash = 5381;
  for (let i = 0; i < path.length; i++) {
    hash = ((hash << 5) + hash) ^ path.charCodeAt(i);
    hash = hash >>> 0; // keep unsigned 32-bit
  }
  const hue = hash % 360;
  return `hsl(${hue}, ${config.placeholderSaturation}%, ${config.placeholderLightness}%)`;
}

/** Build a placeholder div for a missing texture. */
export function makePlaceholder(
  path: string,
  config: ResolvedFlavorConfig,
  label?: string,
): HTMLDivElement {
  const div = document.createElement("div");
  div.title = label ?? path;
  div.style.cssText = [
    "position:absolute",
    "inset:0",
    `background:${placeholderColor(path, config)}`,
    "overflow:hidden",
  ].join(";");

  if (label ?? path) {
    const span = document.createElement("span");
    span.textContent = label ?? path;
    span.style.cssText = [
      "position:absolute",
      "bottom:2px",
      "left:2px",
      "right:2px",
      "font:9px/1.2 monospace",
      `color:rgba(255,255,255,${config.placeholderLabelOpacity})`,
      "white-space:nowrap",
      "overflow:hidden",
      "text-overflow:ellipsis",
      "pointer-events:none",
    ].join(";");
    div.appendChild(span);
  }

  return div;
}
