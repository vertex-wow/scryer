/**
 * Atlas manifest generation benchmark — CSV (current) vs DB2 (new).
 *
 * Measures the two atlas manifest generation paths:
 *   A. CSV parse  — parse pre-downloaded UiTextureAtlas + UiTextureAtlasMember
 *                   CSVs from disk + listfile join. Represents the steady-state
 *                   cost of the current wago.tools approach (no network).
 *   B. DB2 parse  — read two DB2 files from CASC via scryer-asset-server
 *                   + WDC4 binary parse + listfile join.
 *
 * Setup: downloads CSVs from wago.tools once (cached in /tmp/bench-atlas-csvs/).
 * Requires: scryer.installDir configured in dev/settings.local.json.
 *
 * Run (after pnpm build):
 *   node dist/bench-atlas-gen.js [runs] [warmup]
 */

import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as os from "os";
import * as path from "path";
import { performance } from "perf_hooks";

import { generateAtlasManifest } from "../../src/assets/atlas-gen.js";
import { generateAtlasManifestFromDb2 } from "../../src/assets/atlas-gen-db2.js";
import {
  readAssetBytes,
  shutdownAssetClient,
  type ExtractCoreOptions,
} from "../../src/assets/extract-core.js";

const REPO_ROOT = path.join(__dirname, "../..");
const CSV_CACHE = path.join(os.tmpdir(), "scryer-bench-atlas-csvs");
const OUT_DIR = path.join(os.tmpdir(), "scryer-bench-atlas-out");

const RUNS = parseInt(process.argv[2] ?? "3", 10);
const WARMUP = parseInt(process.argv[3] ?? "1", 10);

// ---------------------------------------------------------------------------
// Dev config
// ---------------------------------------------------------------------------

function loadDevConfig(): Record<string, string> {
  const p = path.join(REPO_ROOT, "dev", "settings.local.json");
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, string>;
  } catch {
    return {};
  }
}

const devCfg = loadDevConfig();
const WOW_DIR: string = (devCfg["scryer.installDir"] as string) ?? "";
const ASSET_SERVER_PATH: string =
  (devCfg["scryer.assetServerPath"] as string) ??
  path.join(REPO_ROOT, "scryer-asset-server", "target", "release", "scryer-asset-server");
const CACHE_DIR: string =
  (devCfg["scryer.cacheDir"] as string) ?? path.join(REPO_ROOT, ".wow-cache");
const LISTFILE = path.join(CACHE_DIR, "retail", "source", ".casc-meta", "listfile.csv");

// ---------------------------------------------------------------------------
// HTTP fetch helper
// ---------------------------------------------------------------------------

function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https://") ? https : http;
    proto
      .get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return fetchText(res.headers.location!).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          res.resume();
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// CSV setup (download once)
// ---------------------------------------------------------------------------

async function ensureCsvs(): Promise<{ atlasCsv: string; membersCsv: string }> {
  fs.mkdirSync(CSV_CACHE, { recursive: true });
  const atlasCsv = path.join(CSV_CACHE, "UiTextureAtlas.csv");
  const membersCsv = path.join(CSV_CACHE, "UiTextureAtlasMember.csv");
  if (!fs.existsSync(atlasCsv)) {
    process.stdout.write("Downloading UiTextureAtlas.csv from wago.tools...");
    const text = await fetchText("https://wago.tools/db2/UiTextureAtlas/csv");
    fs.writeFileSync(atlasCsv, text, "utf-8");
    console.log(` ${text.length.toLocaleString()} chars`);
  } else {
    console.log(
      `Using cached UiTextureAtlas.csv (${fs.statSync(atlasCsv).size.toLocaleString()} bytes)`,
    );
  }
  if (!fs.existsSync(membersCsv)) {
    process.stdout.write("Downloading UiTextureAtlasMember.csv from wago.tools...");
    const text = await fetchText("https://wago.tools/db2/UiTextureAtlasMember/csv");
    fs.writeFileSync(membersCsv, text, "utf-8");
    console.log(` ${text.length.toLocaleString()} chars`);
  } else {
    console.log(
      `Using cached UiTextureAtlasMember.csv (${fs.statSync(membersCsv).size.toLocaleString()} bytes)`,
    );
  }
  return { atlasCsv, membersCsv };
}

// ---------------------------------------------------------------------------
// Asset server helper
// ---------------------------------------------------------------------------

function makeCoreOpts(): ExtractCoreOptions {
  return {
    flavor: "retail",
    // outDir must point to the CASC source root so the server finds its
    // cached listfile (.casc-meta/listfile.bin) and lookup tables.
    outDir: path.join(CACHE_DIR, "retail", "source"),
    wowDir: WOW_DIR,
    assetServerPath: ASSET_SERVER_PATH,
    assetServerIdleTimeout: 60,
    log: () => {},
  };
}

// ---------------------------------------------------------------------------
// Timing helpers
// ---------------------------------------------------------------------------

async function time(fn: () => Promise<void>): Promise<number> {
  const t0 = performance.now();
  await fn();
  return performance.now() - t0;
}

interface BenchResult {
  label: string;
  mean: number;
  std: number;
  cv: number;
  min: number;
  max: number;
  times: number[];
  entryCount?: number;
}

async function bench(label: string, fn: () => Promise<number | void>): Promise<BenchResult> {
  process.stdout.write(`  ${label}`);
  let lastEntryCount: number | undefined;
  for (let i = 0; i < WARMUP; i++) {
    process.stdout.write(` (warmup)`);
    const r = await fn();
    if (typeof r === "number") lastEntryCount = r;
  }
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    process.stdout.write(` ${i + 1}`);
    const t0 = performance.now();
    const r = await fn();
    times.push(performance.now() - t0);
    if (typeof r === "number") lastEntryCount = r;
  }
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const std = Math.sqrt(
    times.map((t) => (t - mean) ** 2).reduce((a, b) => a + b, 0) / times.length,
  );
  const cv = std / mean;
  const entryStr = lastEntryCount !== undefined ? `  entries=${lastEntryCount}` : "";
  console.log(
    `\n    mean=${mean.toFixed(0)} ms  ±${std.toFixed(0)} ms  cv=${(cv * 100).toFixed(1)}%` +
      `  min=${Math.min(...times).toFixed(0)}  max=${Math.max(...times).toFixed(0)}${entryStr}`,
  );
  return {
    label,
    mean,
    std,
    cv,
    min: Math.min(...times),
    max: Math.max(...times),
    times,
    entryCount: lastEntryCount,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!WOW_DIR) {
    console.error(
      "scryer.installDir not set in dev/settings.local.json. Required for DB2 scenario.",
    );
    console.error("CSV scenario will still run.");
  }
  if (!fs.existsSync(LISTFILE)) {
    console.error(`Listfile not found at ${LISTFILE}`);
    console.error("Run the extension once (or dev/extract.ts) to download it.");
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log("\nAtlas manifest generation benchmark");
  console.log(`CPU:     ${os.cpus()[0]?.model ?? "unknown"} (${os.cpus().length} logical)`);
  console.log(`Node:    ${process.version}`);
  console.log(`Runs:    ${RUNS} (${WARMUP} warmup)`);
  console.log(`Listfile:${LISTFILE}`);
  console.log(`WoW dir: ${WOW_DIR || "(not configured)"}\n`);

  // ── Setup ──────────────────────────────────────────────────────────────────
  console.log("=== Setup: CSV download (once) ===\n");
  const { atlasCsv, membersCsv } = await ensureCsvs();
  console.log();

  // ── Scenario A: CSV parse ─────────────────────────────────────────────────
  console.log("=== Scenario A: CSV parse + listfile join (current method) ===\n");
  const csvOut = path.join(OUT_DIR, "atlas-csv.json");
  let csvEntryCount = 0;

  const csvResult = await bench("CSV parse + join", async () => {
    await generateAtlasManifest({
      out: csvOut,
      atlasCsv,
      membersCsv,
      listfile: LISTFILE,
      log: () => {},
    });
    const manifest = JSON.parse(fs.readFileSync(csvOut, "utf-8")) as Record<string, unknown>;
    csvEntryCount = Object.keys(manifest).length;
    return csvEntryCount;
  });

  // ── Scenario B: DB2 parse ─────────────────────────────────────────────────
  let db2Result: BenchResult | null = null;

  if (WOW_DIR) {
    console.log("\n=== Scenario B: CASC DB2 read + WDC4 parse + listfile join (new method) ===\n");
    const coreOpts = makeCoreOpts();
    const db2Out = path.join(OUT_DIR, "atlas-db2.json");
    let db2EntryCount = 0;

    // Warm up the server (trigger CASC open — counted separately from parse bench)
    process.stdout.write("  Server warm-up (CASC open)...");
    const serverStartTime = await time(async () => {
      await readAssetBytes("dbfilesclient/uitextureatlas.db2", coreOpts);
    });
    console.log(` ${serverStartTime.toFixed(0)} ms`);

    db2Result = await bench("DB2 read + parse + join (server warm)", async () => {
      await generateAtlasManifestFromDb2({
        out: db2Out,
        listfile: LISTFILE,
        readFile: (p) => readAssetBytes(p, coreOpts),
        log: () => {},
      });
      const manifest = JSON.parse(fs.readFileSync(db2Out, "utf-8")) as Record<string, unknown>;
      db2EntryCount = Object.keys(manifest).length;
      return db2EntryCount;
    });

    // Validate output matches
    if (csvEntryCount > 0 && db2EntryCount > 0) {
      const delta = Math.abs(csvEntryCount - db2EntryCount);
      const pct = ((delta / csvEntryCount) * 100).toFixed(1);
      console.log(
        `\nEntry count comparison: CSV=${csvEntryCount}  DB2=${db2EntryCount}  Δ=${delta} (${pct}%)`,
      );
      if (delta > csvEntryCount * 0.05) {
        console.log("  ⚠  >5% divergence — verify DB2 schema field order");
      } else {
        console.log("  ✓  within 5% — schemas appear correct");
      }
    }

    await shutdownAssetClient();
  } else {
    console.log("\nSkipping Scenario B (no WoW dir configured).");
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n\n## Results summary\n");
  console.log("| Method | Mean | ±Std | CV | vs CSV |");
  console.log("|--------|------|------|-----|--------|");

  console.log(
    `| CSV parse+join | **${csvResult.mean.toFixed(0)} ms** | ±${csvResult.std.toFixed(0)} ms | ${(csvResult.cv * 100).toFixed(1)}% | — |`,
  );

  if (db2Result) {
    const ratio = csvResult.mean / db2Result.mean;
    const tag = ratio > 1 ? `${ratio.toFixed(2)}× faster` : `${(1 / ratio).toFixed(2)}× slower`;
    console.log(
      `| DB2 read+parse+join | **${db2Result.mean.toFixed(0)} ms** | ±${db2Result.std.toFixed(0)} ms | ${(db2Result.cv * 100).toFixed(1)}% | **${tag}** |`,
    );
  }

  console.log(
    "\n(All measurements exclude CASC server startup / open — see server warm-up line above)",
  );
  console.log(`(Run: node dist/bench-atlas-gen.js ${RUNS} ${WARMUP})\n`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
