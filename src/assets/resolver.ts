import * as fs from "fs";
import * as path from "path";

export type AssetKind = "png" | "blp" | "tga";

export interface ResolvedAsset {
  absPath: string;
  kind: AssetKind;
}

const EXT_KIND: Record<string, AssetKind> = { png: "png", blp: "blp", tga: "tga" };

/** Lower-case, backslash→slash. Does NOT strip leading `interface/`. */
export function normalizePath(rawPath: string): string {
  return rawPath.replace(/\\/g, "/").toLowerCase();
}

function extKind(absPath: string): AssetKind | null {
  return EXT_KIND[path.extname(absPath).toLowerCase().slice(1)] ?? null;
}

/** Check a single candidate file. Returns ResolvedAsset or null. */
function probe(absPath: string): ResolvedAsset | null {
  try {
    fs.accessSync(absPath, fs.constants.R_OK);
    const kind = extKind(absPath);
    if (!kind) return null;
    return { absPath, kind };
  } catch {
    return null;
  }
}

/**
 * Build the list of candidate file paths to probe for a given normalized texture path.
 * WoW paths typically begin with `interface/` but may or may not include the prefix
 * depending on how assets were extracted.
 */
function candidates(norm: string, dir: string): string[] {
  const withoutInterface = norm.replace(/^interface\//, "");
  const hasExt = /\.(blp|tga|png)$/.test(norm);
  const exts = hasExt ? [""] : [".blp", ".tga", ".png"];

  const stems = [norm];
  if (withoutInterface !== norm) stems.push(withoutInterface);

  const results: string[] = [];
  for (const stem of stems) {
    for (const ext of exts) {
      results.push(path.join(dir, stem + ext));
    }
  }
  return results;
}

/** Reject paths that escape outside their search root via `..` traversal. */
function isSafe(absPath: string, root: string): boolean {
  const rel = path.relative(root, absPath);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

const memo = new Map<string, ResolvedAsset | null>();

/**
 * Resolve a raw WoW texture path to an absolute disk file.
 *
 * Search order: extractedAssetsDir, installDir, addonDir (addon-bundled textures).
 * Returns the first readable match, or null if nothing found.
 */
export function resolveTexturePath(
  rawPath: string,
  searchDirs: string[],
  addonDir?: string,
): ResolvedAsset | null {
  const memoKey = rawPath + "\0" + searchDirs.join(",") + "\0" + (addonDir ?? "");
  if (memo.has(memoKey)) return memo.get(memoKey) ?? null;

  const norm = normalizePath(rawPath);

  // Reject traversal attempts
  if (norm.includes("..")) {
    memo.set(memoKey, null);
    return null;
  }

  const allDirs = addonDir ? [...searchDirs, addonDir] : searchDirs;

  for (const dir of allDirs) {
    if (!dir) continue;
    for (const candidate of candidates(norm, dir)) {
      if (!isSafe(candidate, dir)) continue;
      const found = probe(candidate);
      if (found) {
        memo.set(memoKey, found);
        return found;
      }
    }
  }

  memo.set(memoKey, null);
  return null;
}

/** Clear memoized resolution results (call when config changes). */
export function clearResolutionMemo(): void {
  memo.clear();
}
