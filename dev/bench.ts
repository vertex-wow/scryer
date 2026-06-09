/**
 * Scryer extraction pipeline benchmark.
 *
 * Run:  pnpm bench
 * Requires .wow-cache/ to be populated (run dev/extract.sh first).
 *
 * Scenarios:
 *   texture       — BLP read + decode + PNG encode + cache write (end-to-end)
 *   texture-split — same but reports t_read / t_decode / t_encode / t_write per file
 *   addon         — XML/Lua/TOC file read (text I/O, confirms no bottleneck here)
 *   combined      — mix of texture + addon in parallel
 *   cache-hit     — serve pre-decoded PNGs from .wow-cache (steady-state hot path)
 *   resolution    — resolveTexturePath cold (memo cleared) vs warm (memoized)
 *
 * N is clamped to available fixtures (no cycling). Run dev/extract.sh retail --type all
 * for a larger corpus that lets high-N values run uncapped.
 *
 * Results: printed table to stdout + dev/bench-results.json (gitignored).
 * Compare two runs: node dev/bench-diff.mjs dev/bench-baseline.json dev/bench-results.json
 */

import * as cp from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Pure-Node asset modules — no vscode dependency
import BLPFile from "js-blp";
import { PNG } from "pngjs";
import { cacheKey, getCachedPath, writeCached } from "../src/assets/cache.js";
import { blpToPng } from "../src/assets/blp.js";
import { clearResolutionMemo, resolveTexturePath } from "../src/assets/resolver.js";

const REPO_ROOT = path.join(__dirname, "..");
const WOW_ASSETS = path.join(REPO_ROOT, ".wow-cache");
const BENCH_CACHE = path.join(os.tmpdir(), "scryer-bench-cache");
const RESULTS_FILE = path.join(REPO_ROOT, "dev", "bench-results.json");

const NS = [1, 2, 5, 10, 50, 100];
const RUNS = 5; // outer reruns per N value
const RUNS_CHEAP = 10; // more reruns for sub-millisecond scenarios

// ---------------------------------------------------------------------------
// Fixture discovery
// ---------------------------------------------------------------------------

function findByExt(dir: string, ...exts: string[]): string[] {
  const extSet = new Set(exts);
  const out: string[] = [];
  function walk(d: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (extSet.has(path.extname(e.name).toLowerCase())) out.push(full);
    }
  }
  walk(dir);
  return out;
}

const blpFiles = findByExt(WOW_ASSETS, ".blp");
const addonFiles = findByExt(path.join(WOW_ASSETS, "interface", "addons"), ".xml", ".lua", ".toc");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Take up to n items — never cycles. Returns fewer items when corpus is small. */
function take<T>(arr: T[], n: number): T[] {
  return arr.slice(0, Math.min(n, arr.length));
}

/** Convert an absolute asset path to the WoW-relative form our resolver expects. */
function toWoWRelative(absPath: string): string {
  return path.relative(WOW_ASSETS, absPath).replace(/\.[^/.]+$/, "");
}

function gitSha(): string {
  try {
    return cp.execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function corpusHash(files: string[]): string {
  const sorted = [...files].sort();
  const content = sorted
    .map((f) => {
      try {
        return `${f}:${fs.statSync(f).size}`;
      } catch {
        return f;
      }
    })
    .join("\n");
  return crypto.createHash("sha1").update(content).digest("hex").slice(0, 8);
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(Math.ceil((p / 100) * sorted.length), sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

export interface Stats {
  n: number;
  actual: number; // files actually processed (may be < n when corpus is small)
  mean: number;
  min: number;
  median: number;
  p95: number;
  max: number;
  cv: number; // coefficient of variation = stddev / mean; < 0.05 is good
}

function computeStats(times: number[], n: number, actual: number): Stats {
  const s = [...times].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const variance =
    s.length > 1 ? s.reduce((acc, t) => acc + (t - mean) ** 2, 0) / (s.length - 1) : 0;
  const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;
  return {
    n,
    actual,
    mean: +mean.toFixed(2),
    min: +s[0].toFixed(2),
    median: +percentile(s, 50).toFixed(2),
    p95: +percentile(s, 95).toFixed(2),
    max: +s[s.length - 1].toFixed(2),
    cv: +cv.toFixed(3),
  };
}

// ---------------------------------------------------------------------------
// Texture scenario (end-to-end: read + decode + encode + write)
// ---------------------------------------------------------------------------

async function measureTexture(n: number): Promise<{ elapsed: number; actual: number }> {
  clearResolutionMemo();
  fs.rmSync(BENCH_CACHE, { recursive: true, force: true });
  fs.mkdirSync(BENCH_CACHE, { recursive: true });

  const paths = take(blpFiles, n);
  const t0 = performance.now();
  await Promise.all(
    paths.map(async (absPath) => {
      const key = cacheKey(absPath);
      const png = blpToPng(absPath);
      writeCached(BENCH_CACHE, key, png);
    }),
  );
  return { elapsed: performance.now() - t0, actual: paths.length };
}

// ---------------------------------------------------------------------------
// Texture-split scenario (per-file sub-timers)
// ---------------------------------------------------------------------------

export interface PerFileResult {
  file: string;
  sizeBytes: number;
  width: number;
  height: number;
  t_read_ms: number;
  t_decode_ms: number;
  t_encode_ms: number;
  t_write_ms: number;
  total_ms: number;
}

function measureFileSplit(absPath: string): PerFileResult {
  const sizeBytes = fs.statSync(absPath).size;

  let t0 = performance.now();
  const raw = fs.readFileSync(absPath);
  const t_read_ms = +(performance.now() - t0).toFixed(3);

  t0 = performance.now();
  const blp = new BLPFile(raw);
  const pixels = blp.getPixels(0);
  const rgba: Buffer = pixels.raw;
  const t_decode_ms = +(performance.now() - t0).toFixed(3);

  const { width, height } = blp;

  t0 = performance.now();
  const png = new PNG({ width, height });
  png.data = rgba;
  const pngBytes = PNG.sync.write(png);
  const t_encode_ms = +(performance.now() - t0).toFixed(3);

  const key = cacheKey(absPath);
  const cachePath = path.join(BENCH_CACHE, `${key}.png`);

  t0 = performance.now();
  fs.writeFileSync(cachePath, pngBytes);
  const t_write_ms = +(performance.now() - t0).toFixed(3);

  return {
    file: path.relative(WOW_ASSETS, absPath),
    sizeBytes,
    width,
    height,
    t_read_ms,
    t_decode_ms,
    t_encode_ms,
    t_write_ms,
    total_ms: +(t_read_ms + t_decode_ms + t_encode_ms + t_write_ms).toFixed(3),
  };
}

async function runTextureSplit(): Promise<PerFileResult[]> {
  if (blpFiles.length === 0) return [];

  fs.rmSync(BENCH_CACHE, { recursive: true, force: true });
  fs.mkdirSync(BENCH_CACHE, { recursive: true });

  // Warm-up: one discarded pass
  for (const f of blpFiles) measureFileSplit(f);

  // Timed pass (sequential so timers don't overlap)
  fs.rmSync(BENCH_CACHE, { recursive: true, force: true });
  fs.mkdirSync(BENCH_CACHE, { recursive: true });
  return blpFiles.map(measureFileSplit);
}

// ---------------------------------------------------------------------------
// Addon scenario (plain text I/O)
// ---------------------------------------------------------------------------

async function measureAddon(n: number): Promise<{ elapsed: number; actual: number }> {
  const paths = take(addonFiles, n);
  const t0 = performance.now();
  await Promise.all(paths.map((p) => fs.promises.readFile(p)));
  return { elapsed: performance.now() - t0, actual: paths.length };
}

// ---------------------------------------------------------------------------
// Combined scenario (texture + addon in parallel)
// ---------------------------------------------------------------------------

async function measureCombined(n: number): Promise<{ elapsed: number; actual: number }> {
  clearResolutionMemo();
  fs.rmSync(BENCH_CACHE, { recursive: true, force: true });
  fs.mkdirSync(BENCH_CACHE, { recursive: true });

  const nTex = Math.ceil(n / 2);
  const nAddon = n - nTex;
  const texPaths = take(blpFiles, nTex);
  const addPaths = take(addonFiles, nAddon);
  const actual = texPaths.length + addPaths.length;

  const t0 = performance.now();
  await Promise.all([
    ...texPaths.map(async (absPath) => {
      const key = cacheKey(absPath);
      const png = blpToPng(absPath);
      writeCached(BENCH_CACHE, key, png);
    }),
    ...addPaths.map((p) => fs.promises.readFile(p)),
  ]);
  return { elapsed: performance.now() - t0, actual };
}

// ---------------------------------------------------------------------------
// Cache-hit scenario (steady-state: serve already-decoded PNGs)
// ---------------------------------------------------------------------------

function warmupBenchCache(): void {
  fs.rmSync(BENCH_CACHE, { recursive: true, force: true });
  fs.mkdirSync(BENCH_CACHE, { recursive: true });
  for (const absPath of blpFiles) {
    const key = cacheKey(absPath);
    if (!getCachedPath(BENCH_CACHE, key)) {
      writeCached(BENCH_CACHE, key, blpToPng(absPath));
    }
  }
}

async function measureCacheHit(n: number): Promise<{ elapsed: number; actual: number }> {
  const paths = take(blpFiles, n);
  const t0 = performance.now();
  await Promise.all(
    paths.map(async (absPath) => {
      const key = cacheKey(absPath);
      const cached = getCachedPath(BENCH_CACHE, key);
      if (cached) await fs.promises.readFile(cached);
    }),
  );
  return { elapsed: performance.now() - t0, actual: paths.length };
}

// ---------------------------------------------------------------------------
// Resolution scenario (path resolution cold vs warm)
// ---------------------------------------------------------------------------

interface ResolutionResult {
  cold: Stats;
  warm: Stats;
}

async function runResolution(): Promise<ResolutionResult | null> {
  if (blpFiles.length === 0) return null;

  const rawPaths = blpFiles.map(toWoWRelative);
  const searchDirs = [WOW_ASSETS];
  const available = rawPaths.length;

  const coldStats: Stats[] = [];
  const warmStats: Stats[] = [];

  for (const n of NS) {
    const subset = take(rawPaths, n);
    const coldTimes: number[] = [];
    const warmTimes: number[] = [];

    for (let r = 0; r < RUNS_CHEAP; r++) {
      // Cold: clear memo before each run
      clearResolutionMemo();
      const t0 = performance.now();
      for (const rp of subset) resolveTexturePath(rp, searchDirs);
      coldTimes.push(performance.now() - t0);

      // Warm: memo already populated from the cold run
      const t1 = performance.now();
      for (const rp of subset) resolveTexturePath(rp, searchDirs);
      warmTimes.push(performance.now() - t1);
    }

    const actual = Math.min(n, available);
    coldStats.push(computeStats(coldTimes, n, actual));
    warmStats.push(computeStats(warmTimes, n, actual));

    const capped = actual < n ? ` (capped at ${actual})` : "";
    const fmtC = (ms: number): string => ms.toFixed(2).padStart(7);
    const fmtW = (ms: number): string => ms.toFixed(2).padStart(7);
    console.log(
      `  N=${String(n).padStart(3)}${capped}:  cold median=${fmtC(coldStats.at(-1)!.median)}ms  warm median=${fmtW(warmStats.at(-1)!.median)}ms  CV_cold=${coldStats.at(-1)!.cv.toFixed(3)}`,
    );
  }

  clearResolutionMemo();
  return { cold: coldStats[0], warm: warmStats[0] }; // full arrays in JSON
}

// ---------------------------------------------------------------------------
// Generic scenario runner (for N-sweep scenarios)
// ---------------------------------------------------------------------------

async function runScenario(
  label: string,
  measure: (n: number) => Promise<{ elapsed: number; actual: number }>,
  available: number,
  runs = RUNS,
): Promise<Stats[]> {
  if (available === 0) {
    console.log(`  (skipped — no ${label} fixtures in .wow-cache/)`);
    return [];
  }

  const results: Stats[] = [];

  for (const n of NS) {
    const times: number[] = [];
    let actual = 0;

    // Warm-up iteration (discarded)
    await measure(n);

    for (let r = 0; r < runs; r++) {
      const { elapsed, actual: a } = await measure(n);
      times.push(elapsed);
      actual = a;
    }

    const st = computeStats(times, n, actual);
    results.push(st);

    const capped = actual < n ? ` (capped at ${actual} available)` : "";
    const fmt = (ms: number): string => String(Math.round(ms)).padStart(5);
    console.log(
      `  N=${String(n).padStart(3)}${capped}:  median=${fmt(st.median)}ms  p95=${fmt(st.p95)}ms  min=${fmt(st.min)}ms  max=${fmt(st.max)}ms  CV=${st.cv.toFixed(3)}`,
    );
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (blpFiles.length === 0 && addonFiles.length === 0) {
    console.error(
      "No fixtures found in .wow-cache/ — run dev/extract.sh first.\n" +
        "Example: ./dev/extract.sh retail --type all",
    );
    process.exit(1);
  }

  const allBlp = [...blpFiles, ...addonFiles];
  const hash = corpusHash(allBlp);

  console.log("Scryer Extraction Pipeline Benchmark");
  console.log("=====================================");
  console.log(
    `Host:           ${os.cpus()[0]?.model ?? "unknown"}, ${os.cpus().length} logical cores`,
  );
  console.log(`RAM:            ${Math.round(os.totalmem() / 1024 ** 3)} GB`);
  console.log(`Node:           ${process.version}   platform: ${process.platform}`);
  console.log(`Git SHA:        ${gitSha()}`);
  console.log(`Corpus hash:    ${hash}  (BLP: ${blpFiles.length}, addon: ${addonFiles.length})`);
  console.log(`Runs per N: ${RUNS} (cheap scenarios: ${RUNS_CHEAP})   N values: ${NS.join(", ")}`);
  if (blpFiles.length < NS[NS.length - 1]) {
    console.log(
      `Note: BLP corpus is small (${blpFiles.length} files). High-N values will be capped.`,
    );
    console.log(`      Run dev/extract.sh retail --type all for a full uncapped corpus.`);
  }
  console.log();

  const allResults: Record<string, Stats[] | PerFileResult[] | unknown> = {};

  // 1. Texture end-to-end
  console.log("=== Texture (BLP read + decode + PNG encode + cache write) ===");
  allResults.texture = await runScenario("texture", measureTexture, blpFiles.length);

  // 2. Texture split timers (per-file, all available files, single pass)
  console.log(
    "\n=== Texture-split (per-file sub-timers: t_read / t_decode / t_encode / t_write) ===",
  );
  if (blpFiles.length > 0) {
    const splitResults = await runTextureSplit();
    allResults["texture-split"] = splitResults;

    // Print table
    const header = `  ${"file".padEnd(50)} ${"size".padStart(7)}  ${"read".padStart(6)}  ${"decode".padStart(6)}  ${"encode".padStart(6)}  ${"write".padStart(5)}  ${"total".padStart(6)}`;
    console.log(header);
    for (const r of splitResults) {
      const name = r.file.padEnd(50);
      const size = `${(r.sizeBytes / 1024).toFixed(0)}K`.padStart(7);
      const tr = `${r.t_read_ms.toFixed(1)}ms`.padStart(6);
      const td = `${r.t_decode_ms.toFixed(1)}ms`.padStart(6);
      const te = `${r.t_encode_ms.toFixed(1)}ms`.padStart(6);
      const tw = `${r.t_write_ms.toFixed(1)}ms`.padStart(5);
      const tt = `${r.total_ms.toFixed(0)}ms`.padStart(6);
      console.log(`  ${name} ${size}  ${tr}  ${td}  ${te}  ${tw}  ${tt}`);
    }
  } else {
    console.log("  (skipped — no BLP fixtures)");
  }

  // 3. Addon file reads
  console.log("\n=== Addon (XML/Lua/TOC file read) ===");
  allResults.addon = await runScenario("addon", measureAddon, addonFiles.length);

  // 4. Combined
  console.log("\n=== Combined (texture + addon in parallel) ===");
  const combinedAvail = Math.min(blpFiles.length, 1) + Math.min(addonFiles.length, 1);
  allResults.combined = await runScenario("combined", measureCombined, combinedAvail);

  // 5. Cache-hit (steady-state)
  console.log("\n=== Cache-hit (serve pre-decoded PNGs from .scryer-bench-cache) ===");
  if (blpFiles.length > 0) {
    warmupBenchCache();
    allResults["cache-hit"] = await runScenario(
      "cache-hit",
      measureCacheHit,
      blpFiles.length,
      RUNS_CHEAP,
    );
  } else {
    console.log("  (skipped — no BLP fixtures)");
  }

  // 6. Resolution (cold vs warm)
  console.log("\n=== Resolution (resolveTexturePath cold vs warm memo) ===");
  const resolutionData: Record<string, Stats[]> = { cold: [], warm: [] };
  if (blpFiles.length > 0) {
    const rawPaths = blpFiles.map(toWoWRelative);
    const searchDirs = [WOW_ASSETS];

    for (const n of NS) {
      const subset = take(rawPaths, n);
      const coldTimes: number[] = [];
      const warmTimes: number[] = [];

      // Warm-up iteration (discarded)
      clearResolutionMemo();
      for (const rp of subset) resolveTexturePath(rp, searchDirs);
      for (const rp of subset) resolveTexturePath(rp, searchDirs);

      for (let r = 0; r < RUNS_CHEAP; r++) {
        clearResolutionMemo();
        const t0 = performance.now();
        for (const rp of subset) resolveTexturePath(rp, searchDirs);
        coldTimes.push(performance.now() - t0);

        const t1 = performance.now();
        for (const rp of subset) resolveTexturePath(rp, searchDirs);
        warmTimes.push(performance.now() - t1);
      }

      const actual = Math.min(n, rawPaths.length);
      const coldSt = computeStats(coldTimes, n, actual);
      const warmSt = computeStats(warmTimes, n, actual);
      resolutionData.cold.push(coldSt);
      resolutionData.warm.push(warmSt);

      const capped = actual < n ? ` (capped at ${actual})` : "";
      console.log(
        `  N=${String(n).padStart(3)}${capped}:  cold=${coldSt.median.toFixed(2).padStart(7)}ms  warm=${warmSt.median.toFixed(2).padStart(7)}ms  speedup=${coldSt.median > 0 ? (coldSt.median / Math.max(warmSt.median, 0.001)).toFixed(1) : "n/a"}x`,
      );
    }
    clearResolutionMemo();
  } else {
    console.log("  (skipped — no BLP fixtures)");
  }
  allResults.resolution = resolutionData;

  // Cleanup
  fs.rmSync(BENCH_CACHE, { recursive: true, force: true });

  // Write results
  const output = {
    meta: {
      date: new Date().toISOString(),
      node: process.version,
      platform: process.platform,
      cpu: os.cpus()[0]?.model ?? "unknown",
      cores: os.cpus().length,
      ramGB: Math.round(os.totalmem() / 1024 ** 3),
      gitSha: gitSha(),
      corpusHash: hash,
      blpFixtures: blpFiles.length,
      addonFixtures: addonFiles.length,
      runsPerN: RUNS,
      runsPerNCheap: RUNS_CHEAP,
    },
    results: allResults,
  };

  fs.writeFileSync(RESULTS_FILE, JSON.stringify(output, null, 2) + "\n");
  console.log(`\nResults saved to ${path.relative(REPO_ROOT, RESULTS_FILE)}`);
  console.log("To capture as baseline: cp dev/bench-results.json dev/bench-baseline.json");
  console.log(
    "To compare against baseline: node dev/bench-diff.mjs dev/bench-baseline.json dev/bench-results.json",
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
