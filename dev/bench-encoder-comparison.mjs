/**
 * Encoder comparison benchmark: pngjs vs fast-png.
 *
 * Decodes each BLP fixture once with js-blp, then times pngjs and fast-png
 * independently on the same RGBA buffer. Reports per-file results and summary
 * speedup ratios.
 *
 * Usage:
 *   node dev/bench-encoder-comparison.mjs [--runs N]
 *
 * Requires .wow-cache/ to be populated (run dev/extract.sh first).
 * Default: 5 timed runs per file (+ 1 warmup discarded).
 */

import { createRequire } from "module";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { performance } from "perf_hooks";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const REPO_ROOT = path.join(__dirname, "..");
const NM = path.join(REPO_ROOT, "node_modules");

// Imports via require (CJS modules)
const { default: BLPFile } = await import(`${NM}/js-blp/js-blp.js`);
const { PNG } = require(`${NM}/pngjs/lib/png.js`);
const { encode: fastPngEncode } = await import(`${NM}/fast-png/lib/index.js`);

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const runsIdx = args.indexOf("--runs");
const RUNS = runsIdx >= 0 ? parseInt(args[runsIdx + 1], 10) : 5;

// ---------------------------------------------------------------------------
// Fixture discovery
// ---------------------------------------------------------------------------

const WOW_CACHE = path.join(REPO_ROOT, ".wow-cache");

function findBlp(dir) {
  const out = [];
  function walk(d) {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.toLowerCase().endsWith(".blp")) out.push(full);
    }
  }
  walk(dir);
  return out;
}

const blpFiles = findBlp(WOW_CACHE);

if (blpFiles.length === 0) {
  console.error("No BLP files found in .wow-cache/ — run dev/extract.sh first.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Benchmark helpers
// ---------------------------------------------------------------------------

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function fmt(ms) {
  if (ms < 1) return `${ms.toFixed(3)}ms`;
  if (ms < 100) return `${ms.toFixed(1)}ms`;
  return `${Math.round(ms)}ms`;
}

// ---------------------------------------------------------------------------
// Per-file comparison
// ---------------------------------------------------------------------------

/**
 * Decodes the BLP once, then times pngjs and fast-png independently over RUNS runs each.
 * Returns null if BLP decode fails.
 */
function benchFile(absPath) {
  let raw;
  try {
    raw = fs.readFileSync(absPath);
  } catch {
    return null;
  }

  let blp, rgba, width, height;
  try {
    blp = new BLPFile(raw);
    const pixels = blp.getPixels(0);
    rgba = pixels.raw; // Buffer, RGBA interleaved
    ({ width, height } = blp);
  } catch (err) {
    return { file: path.relative(WOW_CACHE, absPath), error: String(err) };
  }

  const sizeBytes = raw.length;
  const pixelBytes = rgba.length;

  // Warmup: one discarded run of each
  {
    const p = new PNG({ width, height });
    p.data = rgba;
    PNG.sync.write(p);
  }
  {
    fastPngEncode({ width, height, data: rgba });
  }

  // Timed runs — pngjs
  const pngjsTimes = [];
  for (let r = 0; r < RUNS; r++) {
    const t0 = performance.now();
    const p = new PNG({ width, height });
    p.data = rgba;
    PNG.sync.write(p);
    pngjsTimes.push(performance.now() - t0);
  }

  // Timed runs — fast-png
  const fastTimes = [];
  for (let r = 0; r < RUNS; r++) {
    const t0 = performance.now();
    fastPngEncode({ width, height, data: rgba });
    fastTimes.push(performance.now() - t0);
  }

  return {
    file: path.relative(WOW_CACHE, absPath),
    sizeBytes,
    pixelBytes,
    width,
    height,
    pngjs: { median: median(pngjsTimes), mean: mean(pngjsTimes), times: pngjsTimes },
    fast: { median: median(fastTimes), mean: mean(fastTimes), times: fastTimes },
    speedup: median(pngjsTimes) / Math.max(median(fastTimes), 0.001),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log("Encoder comparison: pngjs vs fast-png");
console.log("======================================");
console.log(`Host:  ${os.cpus()[0]?.model ?? "unknown"}, ${os.cpus().length} cores`);
console.log(`Node:  ${process.version}   platform: ${process.platform}`);
console.log(`Runs per file: ${RUNS} (+ 1 warmup discarded)`);
console.log(`BLP fixtures: ${blpFiles.length}`);
console.log();

const results = [];
for (const f of blpFiles) {
  const r = benchFile(f);
  if (!r) continue;
  results.push(r);
  if (r.error) {
    console.log(`  SKIP  ${r.file} — ${r.error}`);
    continue;
  }
  const ratio =
    r.speedup >= 1 ? `${r.speedup.toFixed(1)}×` : `${(1 / r.speedup).toFixed(1)}× slower`;
  const note = r.speedup >= 1 ? `fast-png ${ratio} faster` : `fast-png ${ratio}`;
  console.log(
    `  ${r.file.padEnd(55)} ${`${(r.sizeBytes / 1024).toFixed(0)}K`.padStart(6)} BLP  ` +
      `${`${r.width}×${r.height}`.padStart(9)}  ` +
      `pngjs=${fmt(r.pngjs.median).padStart(8)}  fast-png=${fmt(r.fast.median).padStart(8)}  → ${note}`,
  );
}

console.log();

// Summary
const valid = results.filter((r) => !r.error);
if (valid.length === 0) {
  console.log("No valid results.");
  process.exit(0);
}

// Weighted by BLP size (larger files matter more)
const totalWeight = valid.reduce((s, r) => s + r.sizeBytes, 0);
const weightedSpeedup = valid.reduce((s, r) => s + r.speedup * r.sizeBytes, 0) / totalWeight;
const overallMedianSpeedup = median(valid.map((r) => r.speedup));

console.log("Summary");
console.log("-------");
console.log(`Files benchmarked:         ${valid.length}`);
console.log(`Median speedup (unweighted): ${overallMedianSpeedup.toFixed(1)}×`);
console.log(`Weighted speedup (by size):  ${weightedSpeedup.toFixed(1)}×`);
console.log();

// Per-file detail table
const maxPngjs = Math.max(...valid.map((r) => r.pngjs.median));
const maxFast = Math.max(...valid.map((r) => r.fast.median));
console.log("Per-file detail (median ms over " + RUNS + " runs):");
console.log(
  `  ${"File".padEnd(55)} ${"BLP".padStart(6)}  ${"Resolution".padStart(9)}  ${"pngjs".padStart(10)}  ${"fast-png".padStart(10)}  speedup`,
);
for (const r of valid) {
  if (r.error) continue;
  console.log(
    `  ${r.file.padEnd(55)} ${`${(r.sizeBytes / 1024).toFixed(0)}K`.padStart(6)}  ` +
      `${`${r.width}×${r.height}`.padStart(9)}  ` +
      `${fmt(r.pngjs.median).padStart(10)}  ` +
      `${fmt(r.fast.median).padStart(10)}  ` +
      `${r.speedup.toFixed(1)}×`,
  );
}

console.log();
console.log("Largest encode (pngjs): " + fmt(maxPngjs) + "  fast-png: " + fmt(maxFast));
console.log();

// Suggest updating measurements.md
console.log(
  "Copy the per-file table above into docs/measurements.md → Q5 / pngjs vs fast-png section.",
);
