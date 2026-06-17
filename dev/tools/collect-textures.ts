/**
 * Collect texture paths referenced across a set of WoW addons and print them
 * to stdout, one per line, normalized for use with rustydemon-cli --paths-file.
 *
 * Usage:
 *   node dist/collect-textures.js [addons-dir [addon-name ...]]
 *
 * Arguments:
 *   addons-dir   Path to extracted Interface/AddOns/ directory.
 *                Default: .wow-cache/interface/addons
 *   addon-name   One or more addon folder names to scan.
 *                Default: every subdirectory found in addons-dir.
 *
 * Output: normalized WoW-relative texture paths to stdout (.blp appended if no ext).
 * Stats:  file counts and totals to stderr.
 *
 * Example — generate a manifest for all addons, then extract:
 *   node dist/collect-textures.js > /tmp/textures.txt
 *   ./dev/extract.sh retail --paths-file /tmp/textures.txt
 *
 * Example — just the Blizzard UI addons:
 *   node dist/collect-textures.js .wow-cache/interface/addons \
 *     Blizzard_SharedXML Blizzard_FrameXML
 */

import * as fs from "fs";
import * as path from "path";
import { collectAddonTexturePaths } from "../../src/parser/addon-textures.js";

const REPO_ROOT = path.join(__dirname, "../..");

const [, , rawAddonsDir, ...argAddonNames] = process.argv;

const addonsDir = rawAddonsDir
  ? path.resolve(rawAddonsDir)
  : path.join(REPO_ROOT, ".wow-cache", "interface", "addons");

if (!fs.existsSync(addonsDir)) {
  process.stderr.write(
    `Error: addons dir not found: ${addonsDir}\n` +
      `Run dev/extract.sh retail --type interface first.\n`,
  );
  process.exit(1);
}

// Resolve addon list: explicit args, or every directory entry in addons-dir.
let addonNames: string[];
if (argAddonNames.length > 0) {
  addonNames = argAddonNames;
} else {
  try {
    addonNames = fs
      .readdirSync(addonsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (err) {
    process.stderr.write(`Error reading addons dir: ${String(err)}\n`);
    process.exit(1);
  }
}

process.stderr.write(`Scanning ${addonNames.length} addon(s) in: ${addonsDir}\n`);

const t0 = performance.now();
const rawPaths = collectAddonTexturePaths(addonsDir, addonNames);
const scanMs = (performance.now() - t0).toFixed(0);

// Normalize: replace backslashes, append .blp if no extension.
const normalized = rawPaths.map((p) => {
  const slashed = p.replace(/\\/g, "/");
  return /\.\w+$/i.test(slashed) ? slashed : slashed + ".blp";
});

// Deduplicate (normalization may merge paths that differ only by extension presence).
const unique = Array.from(new Set(normalized)).sort();

process.stderr.write(
  `Scanned in ${scanMs}ms — ${rawPaths.length} raw refs, ${unique.length} unique paths\n`,
);

for (const p of unique) {
  process.stdout.write(p + "\n");
}
