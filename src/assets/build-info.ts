import * as fs from "fs";
import * as path from "path";

/** Maps scryer flavor names to their .build.info product key and WoW install subdirectory. */
export const FLAVOR_INFO: Record<string, { product: string; subdir: string }> = {
  retail: { product: "wow", subdir: "_retail_" },
  classic: { product: "wow_classic", subdir: "_classic_" },
  classic_era: { product: "wow_classic_era", subdir: "_classic_era_" },
};

export function flavorSubdir(flavor: string): string {
  return FLAVOR_INFO[flavor]?.subdir ?? "_retail_";
}

export function flavorProduct(flavor: string): string {
  return FLAVOR_INFO[flavor]?.product ?? "wow";
}

/**
 * Parse the pipe-delimited .build.info file written by the Battle.net launcher.
 * Returns a map of Product key → BuildText version string (e.g. "wow" → "11.1.7.60000").
 * Accepts both "Version" and "BuildText" as the version column name.
 * Never throws — returns an empty map on any parse failure.
 */
export function parseBuildInfo(content: string): Map<string, string> {
  const result = new Map<string, string>();
  const lines = content.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return result;

  const headers = lines[0].split("|").map((h) => h.replace(/!.*$/, "").toLowerCase());
  const productIdx = headers.indexOf("product");
  const versionIdx = headers.findIndex((h) => h === "version" || h === "buildtext");
  if (productIdx === -1 || versionIdx === -1) return result;

  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split("|");
    if (cells.length <= Math.max(productIdx, versionIdx)) continue;
    const product = cells[productIdx].trim();
    const version = cells[versionIdx].trim();
    if (product) result.set(product, version);
  }
  return result;
}

/**
 * Read the .build.info from the WoW root and return the BuildText for the given flavor.
 * Returns null if the file is absent, unreadable, or the product is not listed.
 */
export function readBuildText(wowRoot: string, flavor: string): string | null {
  try {
    const content = fs.readFileSync(path.join(wowRoot, ".build.info"), "utf8");
    return parseBuildInfo(content).get(flavorProduct(flavor)) ?? null;
  } catch {
    return null;
  }
}

/** Read the build stamp written after extraction. Returns null if absent. */
export function readBuildStamp(cacheRoot: string, flavor: string): string | null {
  try {
    return fs.readFileSync(path.join(cacheRoot, flavor, ".build-stamp"), "utf8").trim();
  } catch {
    return null;
  }
}

/** Write the BuildText to <cacheRoot>/<flavor>/.build-stamp, creating the dir if needed. */
export function writeBuildStamp(cacheRoot: string, flavor: string, buildText: string): void {
  const dir = path.join(cacheRoot, flavor);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".build-stamp"), buildText, "utf8");
}

/** Delete the entire <cacheRoot>/<flavor>/ subtree. No-op if it does not exist. */
export function clearFlavorCache(cacheRoot: string, flavor: string): void {
  fs.rmSync(path.join(cacheRoot, flavor), { recursive: true, force: true });
}
