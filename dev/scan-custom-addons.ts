/**
 * scan-custom-addons — mine 3rd party addon Lua files for API call counts.
 *
 * Outputs a compact counts-only JSON (no site context) for gap analysis.
 * Usage: pnpm tsx dev/scan-custom-addons.ts [--ref-dir <path>] [--out <path>]
 */

import * as fs from "fs";
import * as path from "path";

const PROJECT_ROOT = path.join(__dirname, "..");
const DEFAULT_REF_DIR = path.join(PROJECT_ROOT, "_live", "Addons");
const DEFAULT_OUT = path.join(PROJECT_ROOT, ".plan", "api-corpus", "custom-counts.json");

// ---------------------------------------------------------------------------
// Lua regexes (same as scan-corpus.ts)
// ---------------------------------------------------------------------------

const C_CALL_RE = /\b(C_[A-Za-z0-9]+)\.([A-Za-z0-9_]+)\s*\(/g;
const NS_CALL_RE = /\b([A-Z][A-Za-z][A-Za-z0-9_]*)\.([A-Za-z0-9_]+)\s*\(/g;
const METHOD_CALL_RE = /:([A-Za-z][A-Za-z0-9_]*)\s*\(/g;
const GLOBAL_CALL_RE = /(?<![.:\w])([A-Z][A-Za-z0-9_]+)\s*\(/g;

// ---------------------------------------------------------------------------
// File walker
// ---------------------------------------------------------------------------

function* walkFiles(dir: string, ext: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(full, ext);
    } else if (entry.name.toLowerCase().endsWith(ext)) {
      yield full;
    }
  }
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

function scanLuaLines(lines: string[], counts: Record<string, number>): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*--/.test(line)) continue;

    for (const m of line.matchAll(C_CALL_RE)) {
      const key = `${m[1]}.${m[2]}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    for (const m of line.matchAll(NS_CALL_RE)) {
      if (!m[1].startsWith("C_")) {
        const key = `${m[1]}.${m[2]}`;
        counts[key] = (counts[key] ?? 0) + 1;
      }
    }
    for (const m of line.matchAll(METHOD_CALL_RE)) {
      const key = `:${m[1]}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    for (const m of line.matchAll(GLOBAL_CALL_RE)) {
      counts[m[1]] = (counts[m[1]] ?? 0) + 1;
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let outFile = DEFAULT_OUT;
let refDir = DEFAULT_REF_DIR;

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case "--out":
      outFile = args[++i];
      break;
    case "--ref-dir":
      refDir = args[++i];
      break;
    default:
      console.error(`Unknown argument: ${args[i]}`);
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  if (!fs.existsSync(refDir)) {
    console.error(`Reference dir not found: ${refDir}`);
    process.exit(1);
  }

  const allAddons = fs
    .readdirSync(refDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  const counts: Record<string, number> = {};
  let luaFiles = 0;
  let addonsDone = 0;
  const tick = Math.max(1, Math.floor(allAddons.length / 40));

  console.log(`Scanning ${allAddons.length} addons from ${refDir}`);

  for (const addonName of allAddons) {
    const addonDir = path.join(refDir, addonName);
    for (const luaPath of walkFiles(addonDir, ".lua")) {
      luaFiles++;
      const content = fs.readFileSync(luaPath, "utf-8");
      scanLuaLines(content.split("\n"), counts);
    }
    addonsDone++;
    if (addonsDone % tick === 0) process.stdout.write(".");
  }
  console.log(" done");

  // Sort by count desc
  const sorted = Object.fromEntries(Object.entries(counts).sort(([, a], [, b]) => b - a));

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(sorted, null, 2), "utf-8");

  const sizeMb = (fs.statSync(outFile).size / 1_048_576).toFixed(1);
  console.log(`\nResults:`);
  console.log(`  Addons:     ${allAddons.length}`);
  console.log(`  Lua files:  ${luaFiles}`);
  console.log(`  API keys:   ${Object.keys(sorted).length}`);
  console.log(`  Output:     ${outFile} (${sizeMb} MB)`);
}

run().catch((err: unknown) => {
  console.error((err as Error).message ?? String(err));
  process.exit(1);
});
