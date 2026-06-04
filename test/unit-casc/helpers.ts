import * as fs from "fs";
import * as path from "path";

const SETTINGS_PATH = path.join(__dirname, "../../dev/settings.local.json");

interface DevSettings {
  "scryer.cacheDir"?: string;
  "scryer.flavor"?: string;
  [key: string]: unknown;
}

/**
 * Returns the extracted assets directory (<scryer.cacheDir>/<scryer.flavor>/source)
 * from dev/settings.local.json if scryer.cacheDir is set and the directory exists.
 * Returns null otherwise — CASC tests must skip when this returns null.
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
