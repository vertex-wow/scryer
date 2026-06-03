import * as fs from "fs";
import * as path from "path";

export type AssetKind = "png" | "blp" | "tga" | "font";

export interface ResolvedAsset {
  absPath: string;
  kind: AssetKind;
}

const EXT_KIND: Record<string, AssetKind> = {
  png: "png",
  blp: "blp",
  tga: "tga",
  ttf: "font",
  otf: "font",
};

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
  const hasExt = /\.(blp|tga|png|ttf|otf)$/.test(norm);
  const exts = hasExt ? [""] : [".png", ".blp", ".tga"];

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
 * Search order:
 *   1. extractedAssetsDir, installDir, addonDir — standard dirs with the full path
 *   2. Interface/AddOns/<Name>/... paths → parent of addonDir, with CI addon-folder lookup
 *
 * Returns the first readable match, or null if nothing found.
 */
export function resolveTexturePath(
  rawPath: string,
  searchDirs: string[],
  addonDir?: string,
  log?: (msg: string) => void,
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
        log?.(`    resolve: hit ${found.absPath}`);
        memo.set(memoKey, found);
        return found;
      }
    }
  }

  // Interface/AddOns/<AddonName>/... → resolve relative to the addons root (parent of addonDir).
  // Handles own-addon and cross-addon references. CI first-segment probe for the addon folder
  // name so case-sensitive file systems (Linux) work when the path has been lowercased.
  if (addonDir && norm.startsWith("interface/addons/")) {
    const rel = norm.slice("interface/addons/".length);
    const addonsRoot = path.dirname(addonDir);
    log?.(`    resolve: addon-relative check — root=${addonsRoot} rel=${rel}`);
    const found = probeAddonRelative(addonsRoot, rel, log);
    if (found) {
      log?.(`    resolve: hit ${found.absPath}`);
      memo.set(memoKey, found);
      return found;
    }
  }

  log?.(`    resolve: miss — ${rawPath}`);
  memo.set(memoKey, null);
  return null;
}

/**
 * Resolve a path relative to an addons root directory.
 * The first segment (addon folder name) is matched case-insensitively so that
 * lowercased WoW paths work on case-sensitive file systems.
 */
function probeAddonRelative(
  addonsRoot: string,
  normRel: string,
  log?: (msg: string) => void,
): ResolvedAsset | null {
  const slashIdx = normRel.indexOf("/");
  const firstSeg = slashIdx >= 0 ? normRel.slice(0, slashIdx) : normRel;
  const rest = slashIdx >= 0 ? normRel.slice(slashIdx + 1) : "";

  let entries: string[];
  try {
    entries = fs.readdirSync(addonsRoot);
  } catch (err) {
    log?.(`    resolve: addon-relative readdirSync failed — ${addonsRoot}: ${err}`);
    return null;
  }

  const match = entries.find((e) => e.toLowerCase() === firstSeg);
  if (!match) {
    log?.(
      `    resolve: addon-relative no match for "${firstSeg}" in ${addonsRoot} (entries: ${entries.slice(0, 8).join(", ")}${entries.length > 8 ? ", …" : ""})`,
    );
    return null;
  }

  const addonRoot = path.join(addonsRoot, match);
  log?.(`    resolve: addon-relative matched "${match}", probing rest="${rest}" in ${addonRoot}`);

  if (!rest) return probe(addonRoot);

  for (const candidate of candidates(rest, addonRoot)) {
    if (!isSafe(candidate, addonsRoot)) continue;
    const found = probe(candidate);
    if (found) return found;
    log?.(`    resolve: addon-relative miss ${candidate}`);
  }
  return null;
}

/** Clear memoized resolution results (call when config changes). */
export function clearResolutionMemo(): void {
  memo.clear();
}
