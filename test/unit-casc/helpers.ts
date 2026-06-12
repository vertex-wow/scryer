import * as fs from "fs";
import * as path from "path";
import type { ExtractCoreOptions } from "../../src/assets/extract-core";

const SETTINGS_PATH = path.join(__dirname, "../../dev/settings.local.json");
const BINARY_PATH = path.join(
  __dirname,
  "../../scryer-asset-server/target/release/scryer-asset-server",
);

interface DevSettings {
  "scryer.cacheDir"?: string;
  "scryer.flavor"?: string;
  "scryer.installDir"?: string;
  [key: string]: unknown;
}

/**
 * Returns the extracted assets directory (<scryer.cacheDir>/<scryer.flavor>/source)
 * from dev/settings.local.json if scryer.cacheDir is set and the directory exists.
 * Returns null otherwise — CASC tests must error as misconfigured when this returns null.
 */
export function getExtractedAssetsDir(): string | null {
  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")) as DevSettings;
    const cacheDir = settings["scryer.cacheDir"];
    if (!cacheDir) return null;
    const flavor = settings["scryer.flavor"] ?? "retail";
    const dir = path.join(cacheDir, flavor, "source");
    if (fs.existsSync(dir)) return dir;
  } catch {
    // settings.local.json missing or malformed
  }
  return null;
}

/**
 * Build ExtractCoreOptions from dev/settings.local.json.
 * Returns null when installDir or cacheDir are absent.
 * Used by casc test helpers to auto-extract missing assets on demand.
 */
export function makeExtractCoreOpts(): ExtractCoreOptions | null {
  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")) as DevSettings;
    const installDir = settings["scryer.installDir"];
    if (!installDir) return null;
    const cacheDir = settings["scryer.cacheDir"];
    if (!cacheDir) return null;
    const flavor = (settings["scryer.flavor"] ?? "retail") as "retail" | "classic" | "classic_era";
    return {
      flavor,
      outDir: path.join(cacheDir, flavor, "source"),
      wowDir: installDir,
      assetServerPath: BINARY_PATH,
      assetServerIdleTimeout: 10,
      listfileDir: path.join(cacheDir, "downloads"),
      // CDN fallback is always on for developer test runs: the developer explicitly
      // invoked pnpm test:casc and a Battle.net install has CDN coords available.
      // This is separate from the extension's per-user consent dialog.
      cdnEnabled: true,
    };
  } catch {
    return null;
  }
}

/** Like {@link getExtractedAssetsDir} but throws if not configured, for use in beforeAll hooks. */
export function requireExtractedAssetsDir(): string {
  const dir = getExtractedAssetsDir();
  if (!dir)
    throw new Error(
      "CASC not configured: set scryer.cacheDir (and optionally scryer.flavor) in dev/settings.local.json",
    );
  return dir;
}
