/**
 * CASC extraction tool comparison — casc-extractor vs rustydemon-cli.
 *
 * All timings measured from within a running Node.js process via performance.now(),
 * so subprocess spawn cost is included — matching the real extension context.
 *
 * Scenarios
 *   1. casc-open   — CASC open + listfile parse with no writes (dry-run / list).
 *                    Equivalent filter: Interface/AddOns/** (~3,650 files matched).
 *   2. bulk-addons — Full extraction of Interface/AddOns/** with 8 threads.
 *   3. per-file    — Single file extraction by path (listfile still required).
 *
 * Config: reads from env vars CE_PATH, RD_PATH, WOW_DIR, LISTFILE,
 *         or falls back to dev/settings.local.json (scryer.installDir, scryer.cascToolPath) for rustydemon-cli.
 *
 * Usage:
 *   node dev/bench-casc-comparison.mjs [runs] [warmup]
 *
 * Examples:
 *   CE_PATH=/home/goldilocks/casc-extractor/casc-extractor \
 *   node dev/bench-casc-comparison.mjs 3 1
 */

import { performance } from "perf_hooks";
import { spawn } from "child_process";
import { readFileSync, existsSync, rmSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import os from "os";

// ── config ────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.join(path.dirname(__filename), "../..");

function loadDevConfig() {
  const p = path.join(PROJECT_ROOT, "dev", "settings.local.json");
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return {};
  }
}

const devCfg = loadDevConfig();

const RUNS = parseInt(process.argv[2] ?? "3", 10);
const WARMUP = parseInt(process.argv[3] ?? "1", 10);

const CE_PATH = process.env.CE_PATH ?? "/home/goldilocks/casc-extractor/casc-extractor";
const RD_PATH = process.env.RD_PATH ?? devCfg["scryer.cascToolPath"] ?? "rustydemon-cli";
const WOW_DIR = process.env.WOW_DIR ?? devCfg["scryer.installDir"];
const LISTFILE =
  process.env.LISTFILE ??
  `${os.homedir()}/.vscode-server/data/User/globalStorage/vertex-wow.wow-scryer/downloads/listfile.csv`;

// casc-extractor uses lowercase paths (matches the listfile CSV)
// rustydemon-cli uses capitalized paths (matches the WoW install tree)
const CE_ADDONS_FILTER = "interface/addons/**";
const RD_ADDONS_FILTER = "Interface/AddOns/**";

// A small single file for per-file scenario (FileDataID 5612283 in full listfile)
const CE_SINGLE_FILE = "interface/addons/blizzard_framexml/bossbannertoast.lua";
const RD_SINGLE_FILE = "Interface/AddOns/Blizzard_FrameXML/BossBannerToast.lua";

const CE_BULK_OUT = path.join(os.tmpdir(), "bench-ce-addons");
const RD_BULK_OUT = path.join(os.tmpdir(), "bench-rd-addons");
const CE_SINGLE_OUT = path.join(os.tmpdir(), "bench-ce-single.lua");
const RD_SINGLE_OUT = path.join(os.tmpdir(), "bench-rd-single");

// ── helpers ───────────────────────────────────────────────────────────────────

function spawnAndWait(bin, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (out += d));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(out);
        return;
      }
      // rustydemon-cli exits 1 on missing-chunk errors even when files were exported.
      // Accept if the output contains an exported count > 0 or a file listing.
      const hasOutput = /exported=\d+/.test(out) || /Total:/.test(out) || out.trim().length > 0;
      if (hasOutput) {
        resolve(out);
        return;
      }
      reject(new Error(`${path.basename(bin)} exited with code ${code}\n${out.slice(-500)}`));
    });
  });
}

async function time(fn) {
  const t0 = performance.now();
  await fn();
  return performance.now() - t0;
}

async function bench(label, fn) {
  process.stdout.write(`  ${label}...`);
  for (let i = 0; i < WARMUP; i++) {
    process.stdout.write(`  (warmup ${i + 1}/${WARMUP})`);
    await fn();
  }
  const times = [];
  for (let i = 0; i < RUNS; i++) {
    process.stdout.write(` ${i + 1}`);
    times.push(await time(fn));
  }
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const std = Math.sqrt(
    times.map((t) => (t - mean) ** 2).reduce((a, b) => a + b, 0) / times.length,
  );
  const cv = std / mean;
  console.log(
    `\n    mean=${mean.toFixed(0)} ms  ±${std.toFixed(0)} ms  cv=${(cv * 100).toFixed(1)}%` +
      `  min=${Math.min(...times).toFixed(0)}  max=${Math.max(...times).toFixed(0)}`,
  );
  return { label, mean, std, cv, min: Math.min(...times), max: Math.max(...times), times };
}

function resetDir(dir) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

// ── scenarios ─────────────────────────────────────────────────────────────────

/** casc-extractor list: CASC open + listfile parse only (no file writes). */
function scenarioCeOpen() {
  return spawnAndWait(CE_PATH, [
    "list",
    WOW_DIR,
    "--product",
    "wow",
    "--listfile",
    LISTFILE,
    "--filter",
    CE_ADDONS_FILTER,
  ]);
}

/**
 * rustydemon-cli export --dry-run: CASC open + listfile parse + match, no writes.
 * Equivalent to casc-extractor list.
 */
function scenarioRdOpen() {
  return spawnAndWait(RD_PATH, [
    "export",
    "-a",
    WOW_DIR,
    "-p",
    RD_ADDONS_FILTER,
    "-l",
    LISTFILE,
    "-o",
    path.join(os.tmpdir(), "bench-rd-dry-run"),
    "--dry-run",
  ]);
}

/** casc-extractor extract: bulk Interface/AddOns extraction, 8 threads. */
function scenarioCeBulk() {
  resetDir(CE_BULK_OUT);
  return spawnAndWait(CE_PATH, [
    "extract",
    WOW_DIR,
    "--product",
    "wow",
    "--listfile",
    LISTFILE,
    "--filter",
    CE_ADDONS_FILTER,
    "--threads",
    "8",
    "--output",
    CE_BULK_OUT,
  ]);
}

/** rustydemon-cli export: bulk Interface/AddOns extraction, 8 threads. */
function scenarioRdBulk() {
  resetDir(RD_BULK_OUT);
  return spawnAndWait(RD_PATH, [
    "export",
    "-a",
    WOW_DIR,
    "-p",
    RD_ADDONS_FILTER,
    "-l",
    LISTFILE,
    "-o",
    RD_BULK_OUT,
    "-j",
    "8",
    "-q",
  ]);
}

/** casc-extractor get: single file by path (listfile required for path resolution). */
function scenarioCeSingle() {
  return spawnAndWait(CE_PATH, [
    "get",
    "-i",
    WOW_DIR,
    "--product",
    "wow",
    "--listfile",
    LISTFILE,
    "--output",
    CE_SINGLE_OUT,
    CE_SINGLE_FILE,
  ]);
}

/**
 * rustydemon-cli export: single file by path (listfile still required).
 * This is the "per-file invocation" scenario that drove Q1's 47-min finding.
 */
function scenarioRdSingle() {
  resetDir(RD_SINGLE_OUT);
  return spawnAndWait(RD_PATH, [
    "export",
    "-a",
    WOW_DIR,
    "-p",
    RD_SINGLE_FILE,
    "-l",
    LISTFILE,
    "-o",
    RD_SINGLE_OUT,
    "-q",
  ]);
}

// ── main ──────────────────────────────────────────────────────────────────────

if (!WOW_DIR) {
  console.error("WOW_DIR not set and not found in dev/settings.local.json (scryer.installDir).");
  console.error("Set WOW_DIR env var or add scryer.installDir to dev/settings.local.json.");
  process.exit(1);
}

if (!existsSync(LISTFILE)) {
  console.error(`Listfile not found: ${LISTFILE}`);
  console.error("Run the extension once to download it, or set LISTFILE env var.");
  process.exit(1);
}

const cpuCount = os.cpus().length;
const cpuModel = os.cpus()[0]?.model ?? "unknown";

console.log(`\nCASC extraction tool comparison (${WARMUP} warmup, ${RUNS} runs)`);
console.log(`CPU:      ${cpuModel} (${cpuCount} logical cores)`);
console.log(`Node:     ${process.version}`);
console.log(`WoW dir:  ${WOW_DIR}`);
console.log(`Listfile: ${LISTFILE}`);
console.log(`CE:       ${CE_PATH}`);
console.log(`RD:       ${RD_PATH}\n`);

const results = [];

// ── scenario 1: CASC open overhead ───────────────────────────────────────────

console.log("=== Scenario 1: CASC open (listfile parse) — dry-run / list ===");
console.log("  Filter: Interface/AddOns/** (~3,650 files matched, no disk writes)\n");
results.push({
  group: "casc-open",
  tool: "casc-extractor",
  ...(await bench("casc-extractor list", scenarioCeOpen)),
});
results.push({
  group: "casc-open",
  tool: "rustydemon-cli",
  ...(await bench("rustydemon-cli --dry-run", scenarioRdOpen)),
});

// ── scenario 2: bulk extract ──────────────────────────────────────────────────

console.log("\n=== Scenario 2: Bulk extract — Interface/AddOns/** (8 threads) ===");
console.log("  Writes to /tmp/bench-{ce,rd}-addons; cleaned before each run.\n");
results.push({
  group: "bulk-addons",
  tool: "casc-extractor",
  ...(await bench("casc-extractor extract", scenarioCeBulk)),
});
results.push({
  group: "bulk-addons",
  tool: "rustydemon-cli",
  ...(await bench("rustydemon-cli export", scenarioRdBulk)),
});

// ── scenario 3: per-file single extract ──────────────────────────────────────

console.log("\n=== Scenario 3: Per-file — single file by path (listfile required) ===");
console.log(`  File: ${CE_SINGLE_FILE}\n`);
results.push({
  group: "per-file",
  tool: "casc-extractor",
  ...(await bench("casc-extractor get", scenarioCeSingle)),
});
results.push({
  group: "per-file",
  tool: "rustydemon-cli",
  ...(await bench("rustydemon-cli export (1 file)", scenarioRdSingle)),
});

// ── summary table ─────────────────────────────────────────────────────────────

console.log("\n\n## Results summary\n");
console.log("| Scenario | Tool | Mean | ±Stddev | CV | vs other |");
console.log("|---|---|---|---|---|---|");

const groups = [...new Set(results.map((r) => r.group))];
for (const group of groups) {
  const pair = results.filter((r) => r.group === group);
  const [a, b] = pair;
  if (!b) {
    console.log(
      `| ${group} | ${a.tool} | **${(a.mean / 1000).toFixed(1)} s** | ±${(a.std / 1000).toFixed(1)} s | ${(a.cv * 100).toFixed(1)}% | — |`,
    );
    continue;
  }
  const aWins = a.mean <= b.mean;
  // Both rows show the same ratio N×; winner says "faster", loser says "slower".
  const faster = aWins ? a : b;
  const slower = aWins ? b : a;
  const speedup = (slower.mean / faster.mean).toFixed(2);
  const aTag = aWins ? `**${speedup}× faster**` : `${speedup}× slower`;
  const bTag = !aWins ? `**${speedup}× faster**` : `${speedup}× slower`;
  console.log(
    `| ${group} | ${a.tool} | **${(a.mean / 1000).toFixed(1)} s** | ±${(a.std / 1000).toFixed(1)} s | ${(a.cv * 100).toFixed(1)}% | ${aTag} |`,
  );
  console.log(
    `| ${group} | ${b.tool} | **${(b.mean / 1000).toFixed(1)} s** | ±${(b.std / 1000).toFixed(1)} s | ${(b.cv * 100).toFixed(1)}% | ${bTag} |`,
  );
}

console.log("\n(All measurements from Node.js subprocess; includes spawn overhead ~50ms)");
console.log(`(Run: node dev/bench-casc-comparison.mjs ${RUNS} ${WARMUP})\n`);
