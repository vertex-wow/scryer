import * as fs from "fs";

export interface AtlasEntry {
  /** WoW-relative path to the sprite sheet (e.g. "Interface/Glues/..."). */
  file: string;
  /** Pixel X offset of the region in the sheet (CommittedLeft). */
  x: number;
  /** Pixel Y offset of the region in the sheet (CommittedTop). */
  y: number;
  /** Pixel width of the region. */
  width: number;
  /** Pixel height of the region. */
  height: number;
  /** Total pixel width of the sprite sheet. */
  sheetW: number;
  /** Total pixel height of the sprite sheet. */
  sheetH: number;
  tilesH: boolean;
  tilesV: boolean;
}

export type AtlasManifest = Record<string, AtlasEntry>;

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
