/**
 * Collect all texture paths referenced by the Blizzard SharedXML + FrameXML
 * template corpus and print them to stdout, one per line, in extraction format
 * (WoW-relative path with .blp extension if no extension present).
 *
 * Run:  pnpm exec node dist/collect-blizz-textures.js [addons-dir] [cache-dir]
 *
 * Defaults:
 *   addons-dir  .wow-assets/interface/addons
 *   cache-dir   .scryer-cache
 *
 * Output goes to stdout; pipe to a file for use with extract.sh --paths-file.
 * Stats (file counts, totals) go to stderr so stdout stays clean.
 */

import * as fs from "fs";
import * as path from "path";
import { loadBlizzardRegistry } from "../src/parser/blizzard-registry.js";
import { collectTexturePaths } from "../src/parser/collect-textures.js";

const REPO_ROOT = path.join(__dirname, "..");

const addonsDir = process.argv[2] ?? path.join(REPO_ROOT, ".wow-assets", "interface", "addons");
const cacheDir = process.argv[3] ?? path.join(REPO_ROOT, ".scryer-cache");

if (!fs.existsSync(addonsDir)) {
  process.stderr.write(
    `Error: addons dir not found: ${addonsDir}\n` +
      `Run dev/extract.sh retail --type interface first.\n`,
  );
  process.exit(1);
}

process.stderr.write(`Loading Blizzard registry from: ${addonsDir}\n`);
const t0 = performance.now();
const registry = loadBlizzardRegistry(addonsDir, cacheDir);
const parseMs = (performance.now() - t0).toFixed(0);

process.stderr.write(`Registry loaded: ${registry.size} templates in ${parseMs}ms\n`);

const frames = Array.from(registry.values());
const texturePaths = collectTexturePaths(frames);

// Normalise: replace backslashes, append .blp if no extension
const normalized = texturePaths.map((p) => {
  const slashed = p.replace(/\\/g, "/");
  return /\.\w+$/i.test(slashed) ? slashed : slashed + ".blp";
});

// Deduplicate (collectTexturePaths already deduplicates, but normalisation may
// introduce new duplicates if the same path appears with/without extension)
const unique = Array.from(new Set(normalized)).sort();

process.stderr.write(
  `Unique texture paths: ${unique.length} (from ${texturePaths.length} raw references)\n`,
);

for (const p of unique) {
  process.stdout.write(p + "\n");
}
