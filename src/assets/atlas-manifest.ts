import * as fs from "fs";
import type { FrameIR, TextureIR } from "../parser/ir.js";

export interface AtlasEntry {
  /** WoW-relative path to the sprite sheet (e.g. "Interface/Glues/..."). */
  file: string;
  /** Pixel X offset of the region in the sheet (CommittedLeft). */
  x: number;
  /** Pixel Y offset of the region in the sheet (CommittedTop). */
  y: number;
  /** Physical pixel width of the region (Width column). */
  width: number;
  /** Physical pixel height of the region (Height column). */
  height: number;
  /** Total pixel width of the sprite sheet. */
  sheetW: number;
  /** Total pixel height of the sprite sheet. */
  sheetH: number;
  tilesH: boolean;
  tilesV: boolean;
  /**
   * Explicit logical WoW-unit size from the DB2 OverrideWidth column (0 = not set).
   * When non-zero, `width / logicalW` gives the pixel-per-unit divisor for this atlas
   * family, which may differ from the naive ÷2 applied to all -2x entries.
   */
  logicalW: number;
  /**
   * Explicit logical WoW-unit size from the DB2 OverrideHeight column (0 = not set).
   */
  logicalH: number;
}

export type AtlasManifest = Record<string, AtlasEntry>;

function resolveAtlasInTexture(tex: TextureIR, manifest: AtlasManifest): void {
  if (!tex.atlas) return;
  const origLower = tex.atlas.toLowerCase();
  const stripped = tex.atlas.replace(/^[_!]+/, "");
  const strippedLower = stripped.toLowerCase();
  let entry =
    manifest[tex.atlas] ?? manifest[origLower] ?? manifest[stripped] ?? manifest[strippedLower];
  let scaleDivisor = 1;
  if (!entry) {
    entry = manifest[origLower + "-2x"] ?? manifest[strippedLower + "-2x"];
    if (entry) {
      // When the DB2 row carries an explicit logical-size override (OverrideWidth /
      // OverrideHeight), derive the divisor from it so we get the exact WoW logical size
      // without relying on a hardcoded "÷2 for all -2x" assumption.
      // For entries without an override (logicalW=0), fall back to ÷2.
      scaleDivisor = entry.logicalW > 0 ? entry.width / entry.logicalW : 2;
    }
  }
  if (!entry) return;
  const d = scaleDivisor;
  tex.resolvedAtlas = {
    file: entry.file,
    x: entry.x / d,
    y: entry.y / d,
    width: entry.width / d,
    height: entry.height / d,
    sheetW: entry.sheetW / d,
    sheetH: entry.sheetH / d,
    tilesH: entry.tilesH,
    tilesV: entry.tilesV,
  };
}

function resolveAtlasInFrame(frame: FrameIR, manifest: AtlasManifest): void {
  for (const layer of frame.layers) {
    for (const obj of layer.objects) {
      if (obj.kind === "Texture" || obj.kind === "MaskTexture") {
        resolveAtlasInTexture(obj as TextureIR, manifest);
      }
    }
  }
  for (const tex of [
    frame.normalTexture,
    frame.pushedTexture,
    frame.disabledTexture,
    frame.highlightTexture,
  ]) {
    if (tex) resolveAtlasInTexture(tex, manifest);
  }
  for (const child of frame.children) {
    resolveAtlasInFrame(child, manifest);
  }
}

export function resolveAtlasNames(frames: FrameIR[], manifest: AtlasManifest): void {
  for (const frame of frames) {
    resolveAtlasInFrame(frame, manifest);
  }
}

/**
 * Load the atlas manifest from disk. Returns null if the file is absent or unparseable.
 * The manifest is expected to be a JSON object mapping atlas name → AtlasEntry.
 */
export function loadAtlasManifest(manifestPath: string): AtlasManifest | null {
  try {
    const raw = fs.readFileSync(manifestPath, "utf-8");
    return JSON.parse(raw) as AtlasManifest;
  } catch {
    return null;
  }
}
