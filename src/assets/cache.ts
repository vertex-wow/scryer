import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

/** Stable cache key derived from the file's absolute path + mtime + size. */
export function cacheKey(absPath: string): string {
  try {
    const stat = fs.statSync(absPath);
    const raw = `${absPath}|${stat.mtimeMs}|${stat.size}`;
    return crypto.createHash("sha1").update(raw).digest("hex");
  } catch {
    return crypto.createHash("sha1").update(absPath).digest("hex");
  }
}

/** Returns the absolute path to the cached PNG if it exists, null otherwise. */
export function getCachedPath(cacheDir: string, key: string): string | null {
  const p = path.join(cacheDir, `${key}.png`);
  try {
    fs.accessSync(p, fs.constants.R_OK);
    return p;
  } catch {
    return null;
  }
}

/** Write PNG bytes to the cache; creates the cache directory if needed. Returns the cached path. */
export function writeCached(cacheDir: string, key: string, pngBytes: Buffer): string {
  fs.mkdirSync(cacheDir, { recursive: true });
  const p = path.join(cacheDir, `${key}.png`);
  fs.writeFileSync(p, pngBytes);
  return p;
}
