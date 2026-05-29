import * as fs from "fs";

/** One layer of flavor config — all keys optional so layers can be sparse. */
export interface FlavorConfigLayer {
  /** Physical monitor resolution. WoW UIParent units are derived from these. */
  screenWidth?: number;
  screenHeight?: number;
  /** WoW engine constant: UIParent logical height (width is derived from aspect ratio). */
  uiParentHeight?: number;
  /** WoW-relative path to the default font file, e.g. "Fonts/FRIZQT__.TTF". */
  defaultFont?: string;
  defaultFontSize?: number;
  defaultFontFlags?: string;
  defaultTextColor?: { r: number; g: number; b: number; a: number };
  /** Global scale applied to the preview viewport (CSS transform). */
  frameScale?: number;
  /** CSS letter-spacing value (e.g. "0.033em") to compensate for WoW DirectWrite vs browser advance-width difference. */
  fontLetterSpacing?: string;
  /** Fallback font size = frame height × this ratio, used when no explicit size is set. */
  autoFontSizeRatio?: number;
  /**
   * Maps to CSS -webkit-font-smoothing on FontString elements.
   * "antialiased" (default) matches WoW's DirectWrite grayscale AA; "auto" uses the
   * browser default (ClearType/subpixel on Windows), "none" disables AA entirely.
   */
  fontSmoothing?: string;
  /** Preview viewport background color (solid base under checkerboard). */
  viewportBg?: string;
  /** Checkerboard light square color (indicates transparent areas). */
  viewportCheckerLight?: string;
  /** Checkerboard dark square color. */
  viewportCheckerDark?: string;
  /** Checkerboard tile size in CSS pixels. */
  viewportCheckerSize?: number;
  /** Ruler strip thickness in CSS px. */
  rulerSize?: number;
  /** Ruler strip background color. */
  rulerBg?: string;
  /** Ruler border line color. */
  rulerBorder?: string;
  /** Major tick mark color. */
  rulerTickMajorColor?: string;
  /** Minor tick mark color. */
  rulerTickMinorColor?: string;
  /** Ruler numeric label color. */
  rulerLabelColor?: string;
  /** WoW-pixel interval between numeric labels on the ruler. */
  rulerLabelInterval?: number;
  /** WoW-pixel spacing for major tick marks. */
  rulerTickMajor?: number;
  /** WoW-pixel spacing for minor tick marks. */
  rulerTickMinor?: number;
  /** Dark halo color behind ruler labels. */
  rulerShadowColor?: string;
  /** Blur radius (px) of the ruler label shadow. */
  rulerShadowBlur?: number;
  /** Status bar height in CSS px. */
  statusBarHeight?: number;
  /** Status bar background color. */
  statusBarBg?: string;
  /** Status bar text color. */
  statusBarColor?: string;
  /** Status bar CSS font shorthand. */
  statusBarFont?: string;
  /** HSL saturation (0–100) for placeholder tiles. */
  placeholderSaturation?: number;
  /** HSL lightness (0–100) for placeholder tiles. */
  placeholderLightness?: number;
  /** Opacity (0–1) of placeholder label text. */
  placeholderLabelOpacity?: number;
  /** Floating-point epsilon for anchor axis comparison in the layout solver. */
  layoutEpsilon?: number;
  /** Maximum iterations for the iterative layout dependency pass. */
  layoutMaxIterations?: number;
  /** Per-call Lua execution timeout in milliseconds. Each JS→Lua call is killed if it exceeds this limit. */
  sandboxTimeout?: number;
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
  /** Derived from uiParentHeight and aspect ratio: Math.round(uiParentHeight * screenWidth / screenHeight) */
  uiParentWidth: number;
  /** WoW engine constant: UIParent logical height (768 for all known flavors). */
  uiParentHeight: number;
  defaultFont: string;
  defaultFontSize: number;
  defaultFontFlags: string;
  defaultTextColor: { r: number; g: number; b: number; a: number };
  frameScale: number;
  fontLetterSpacing: string;
  autoFontSizeRatio: number;
  fontSmoothing: string;
  viewportBg: string;
  viewportCheckerLight: string;
  viewportCheckerDark: string;
  viewportCheckerSize: number;
  rulerSize: number;
  rulerBg: string;
  rulerBorder: string;
  rulerTickMajorColor: string;
  rulerTickMinorColor: string;
  rulerLabelColor: string;
  rulerLabelInterval: number;
  rulerTickMajor: number;
  rulerTickMinor: number;
  rulerShadowColor: string;
  rulerShadowBlur: number;
  statusBarHeight: number;
  statusBarBg: string;
  statusBarColor: string;
  statusBarFont: string;
  placeholderSaturation: number;
  placeholderLightness: number;
  placeholderLabelOpacity: number;
  layoutEpsilon: number;
  layoutMaxIterations: number;
  sandboxTimeout: number;
}

// Absolute fallback — matches the values in src/flavors/defaults.json.
const HARD_DEFAULTS: Required<FlavorConfigLayer> = {
  screenWidth: 1920,
  screenHeight: 1080,
  uiParentHeight: 768,
  defaultFont: "Fonts/FRIZQT__.TTF",
  defaultFontSize: 12,
  defaultFontFlags: "",
  defaultTextColor: { r: 1, g: 0.82, b: 0, a: 1 },
  frameScale: 1,
  fontLetterSpacing: "0.033em",
  autoFontSizeRatio: 0.75,
  fontSmoothing: "antialiased",
  viewportBg: "#555",
  viewportCheckerLight: "#666",
  viewportCheckerDark: "#444",
  viewportCheckerSize: 128,
  rulerBg: "#1a1a1a",
  rulerBorder: "#2a2a2a",
  rulerTickMajorColor: "#666",
  rulerTickMinorColor: "#3a3a3a",
  rulerLabelColor: "#c8c8c8",
  rulerLabelInterval: 100,
  rulerTickMajor: 50,
  rulerTickMinor: 10,
  rulerSize: 20,
  rulerShadowColor: "rgba(0,0,0,0.9)",
  rulerShadowBlur: 3,
  statusBarHeight: 20,
  statusBarBg: "#222",
  statusBarColor: "#888",
  statusBarFont: "11px monospace",
  placeholderSaturation: 45,
  placeholderLightness: 30,
  placeholderLabelOpacity: 0.7,
  layoutEpsilon: 1e-9,
  layoutMaxIterations: 64,
  sandboxTimeout: 5000,
};

// Built-in per-flavor config — mirrors src/flavors/defaults.json exactly.
const BUILTIN_CONFIG: FlavorConfigFile = {
  default: {
    screenWidth: 1920,
    screenHeight: 1080,
    uiParentHeight: 768,
    defaultFont: "Fonts/FRIZQT__.TTF",
    defaultFontSize: 12,
    defaultFontFlags: "",
    defaultTextColor: { r: 1, g: 0.82, b: 0, a: 1 },
    frameScale: 1,
    fontLetterSpacing: "0.033em",
    autoFontSizeRatio: 0.75,
    fontSmoothing: "antialiased",
    viewportBg: "#555",
    viewportCheckerLight: "#666",
    viewportCheckerDark: "#444",
    viewportCheckerSize: 128,
    rulerBg: "#1a1a1a",
    rulerBorder: "#2a2a2a",
    rulerTickMajorColor: "#666",
    rulerTickMinorColor: "#3a3a3a",
    rulerLabelColor: "#c8c8c8",
    rulerLabelInterval: 100,
    rulerTickMajor: 50,
    rulerTickMinor: 10,
    rulerSize: 20,
    rulerShadowColor: "rgba(0,0,0,0.9)",
    rulerShadowBlur: 3,
    statusBarHeight: 20,
    statusBarBg: "#222",
    statusBarColor: "#888",
    statusBarFont: "11px monospace",
    placeholderSaturation: 45,
    placeholderLightness: 30,
    placeholderLabelOpacity: 0.7,
    layoutEpsilon: 1e-9,
    layoutMaxIterations: 64,
    sandboxTimeout: 5000,
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

  const uiParentHeight = resolved.uiParentHeight;
  const uiParentWidth = Math.round((uiParentHeight * resolved.screenWidth) / resolved.screenHeight);

  return { ...resolved, uiParentWidth, uiParentHeight };
}
