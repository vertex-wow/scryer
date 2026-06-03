import * as fs from "fs";
import * as path from "path";

const CONFIG_PATH = path.join(__dirname, "../../dev/config.local.json");

interface DevConfig {
  extractedAssetsDir?: string;
  [key: string]: unknown;
}

/**
 * Returns extractedAssetsDir from dev/config.local.json if the key is set and
 * the directory exists on disk. Returns null otherwise — CASC tests must skip
 * when this returns null.
 */
export function getExtractedAssetsDir(): string | null {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as DevConfig;
    const dir = config.extractedAssetsDir;
    if (dir && fs.existsSync(dir)) return dir;
  } catch {
    // config.local.json missing or malformed
  }
  return null;
}
