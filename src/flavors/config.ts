import * as fs from "fs";

/** One layer of flavor config — all keys optional so layers can be sparse. */
export interface FlavorConfigLayer {
  /** Physical monitor resolution. WoW UIParent units are derived from these. */
  screenWidth?: number;
  screenHeight?: number;
  /** WoW-relative path to the default font file, e.g. "Fonts/FRIZQT__.TTF". */
  defaultFont?: string;
  defaultFontSize?: number;
  defaultFontFlags?: string;
  defaultTextColor?: { r: number; g: number; b: number; a: number };
  /** Global scale applied to the preview viewport (CSS transform). */
  frameScale?: number;
}

/** Shape of a flavor config JSON file (defaults.json or user-supplied). */
export interface FlavorConfigFile {
  default?: FlavorConfigLayer;
  [flavor: string]: FlavorConfigLayer | undefined;
}

/** Fully resolved config — every field present after all layers are merged. */
export interface ResolvedFlavorConfig {
  screenWidth: number;
  screenHeight: number;
  /** Derived from screenWidth/screenHeight: Math.round(768 * screenWidth / screenHeight) */
  uiParentWidth: number;
  /** Always 768 — WoW's fixed UIParent height in logical units. */
  uiParentHeight: number;
  defaultFont: string;
  defaultFontSize: number;
  defaultFontFlags: string;
  defaultTextColor: { r: number; g: number; b: number; a: number };
  frameScale: number;
}

// Absolute fallback — matches the values in src/flavors/defaults.json.
const HARD_DEFAULTS: Required<FlavorConfigLayer> = {
  screenWidth: 1920,
  screenHeight: 1080,
  defaultFont: "Fonts/FRIZQT__.TTF",
  defaultFontSize: 12,
  defaultFontFlags: "",
  defaultTextColor: { r: 1, g: 0.82, b: 0, a: 1 },
  frameScale: 1,
};

// Built-in per-flavor config — mirrors src/flavors/defaults.json exactly.
const BUILTIN_CONFIG: FlavorConfigFile = {
  default: {
    screenWidth: 1920,
    screenHeight: 1080,
    defaultFont: "Fonts/FRIZQT__.TTF",
    defaultFontSize: 12,
    defaultFontFlags: "",
    defaultTextColor: { r: 1, g: 0.82, b: 0, a: 1 },
    frameScale: 1,
  },
  retail: {},
  classic: {},
  classic_era: {},
};

function mergeLayer(
  base: Required<FlavorConfigLayer>,
  layer: FlavorConfigLayer | undefined,
): Required<FlavorConfigLayer> {
  if (!layer) return base;
  const result = { ...base };
  for (const [k, v] of Object.entries(layer)) {
    if (v !== undefined) (result as Record<string, unknown>)[k] = v;
  }
  return result;
}

function loadUserConfig(filePath: string): FlavorConfigFile | null {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    return JSON.parse(content) as FlavorConfigFile;
  } catch {
    return null;
  }
}

/**
 * Merge order: hard defaults → built-in default → built-in per-flavor →
 * user default → user per-flavor. Later layers win per key.
 */
export function resolveFlavorConfig(flavor: string, userConfigPath?: string): ResolvedFlavorConfig {
  const user = userConfigPath ? (loadUserConfig(userConfigPath) ?? {}) : {};

  let resolved: Required<FlavorConfigLayer> = { ...HARD_DEFAULTS };
  resolved = mergeLayer(resolved, BUILTIN_CONFIG.default);
  resolved = mergeLayer(resolved, BUILTIN_CONFIG[flavor]);
  resolved = mergeLayer(resolved, user.default);
  resolved = mergeLayer(resolved, user[flavor]);

  // WoW UIParent height is always 768 logical units; width scales with aspect ratio.
  const uiParentHeight = 768;
  const uiParentWidth = Math.round((uiParentHeight * resolved.screenWidth) / resolved.screenHeight);

  return { ...resolved, uiParentWidth, uiParentHeight };
}
