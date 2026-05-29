/**
 * Listfile filter benchmark — measures the cost of filtering listfile.csv
 * to Interface-only entries using various Node.js approaches.
 *
 * This is a standalone .mjs script (no build step needed).
 * All approaches are measured from within the running Node.js process so
 * subprocess spawn cost is included, matching the real extension context.
 *
 * Usage:
 *   node dev/bench-listfile-filter.mjs <path-to-listfile.csv> [runs] [warmup]
 *
 * Example:
 *   node dev/bench-listfile-filter.mjs \
 *     ~/.vscode-server/data/User/globalStorage/vertex-wow.wow-scryer/downloads/listfile.csv
 *
 * Results are printed as a markdown table. Output is written to /tmp/listfile-filter-out.csv.
 *
 * For SQLite/LibSQL approaches see the bench-sqlite.mjs one-off script kept alongside
 * this file in conversation history (not committed — requires pnpm installing better-sqlite3
 * and @libsql/client into a temp dir). Key results are recorded in docs/measurements.md Q1b.
 */

import { performance } from "perf_hooks";
import { spawn } from "child_process";
import { createReadStream, createWriteStream, readFileSync, writeFileSync } from "fs";
import { createInterface } from "readline";
import { cpus } from "os";
import { fileURLToPath } from "url";
import path from "path";

const INPUT = process.argv[2];
const RUNS = parseInt(process.argv[3] ?? "5", 10);
const WARMUP = parseInt(process.argv[4] ?? "2", 10);
const OUT = "/tmp/listfile-filter-out.csv";
const CPU_COUNT = cpus().length;
const __filename = fileURLToPath(import.meta.url);

if (!INPUT) {
  console.error("Usage: node dev/bench-listfile-filter.mjs <input.csv> [runs] [warmup]");
  process.exit(1);
}

// ── constants ────────────────────────────────────────────────────────────────

const NEWLINE = 0x0a;
const SEMI = 0x3b;
/** ASCII bytes for ";interface/" — the fixed prefix every matching path has. */
const NEEDLE = Buffer.from(";interface/");

// ── approaches ───────────────────────────────────────────────────────────────

/** Spawn grep as a subprocess, pipe stdout directly to output file. */
function spawnGrep(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("grep", args);
    const ws = createWriteStream(OUT);
    proc.stdout.pipe(ws);
    proc.stderr.resume();
    proc.on("error", reject);
    ws.on("finish", resolve);
    ws.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) reject(new Error(`grep exited ${code}`));
    });
  });
}

/** readline line-by-line stream — baseline Node approach. */
async function nodeReadline() {
  const rl = createInterface({ input: createReadStream(INPUT), crlfDelay: Infinity });
  const ws = createWriteStream(OUT);
  for await (const line of rl) {
    const semi = line.indexOf(";");
    if (semi !== -1 && line.slice(semi + 1, semi + 11).toLowerCase() === "interface/") {
      ws.write(line + "\n");
    }
  }
  await new Promise((res, rej) => {
    ws.end();
    ws.on("finish", res);
    ws.on("error", rej);
  });
}

/** readFileSync + split — simple synchronous approach. */
function nodeReadfile() {
  const text = readFileSync(INPUT, "utf8");
  const lines = text.split("\n");
  const out = [];
  for (const line of lines) {
    const semi = line.indexOf(";");
    if (semi !== -1 && line.slice(semi + 1, semi + 11).toLowerCase() === "interface/") {
      out.push(line);
    }
  }
  writeFileSync(OUT, out.join("\n") + "\n");
}

/**
 * 1BRC-style stream + byte scan.
 *
 * Key techniques from the 1-billion-row challenge:
 * - Read via createReadStream (raw Buffer chunks, no string conversion)
 * - Use Buffer.indexOf() for delimiter search — lets V8's C++ implementation
 *   do the hot scan rather than a JS byte loop
 * - Carry incomplete lines across chunk boundaries in a small carry buffer
 * - Write matching lines as Buffer slices (zero-copy from the read chunk)
 *
 * This avoids String.split(), readline's line assembly overhead, and the
 * 140 MB allocation that readFileSync+split requires.
 */
function nodeStreamBytes() {
  return new Promise((resolve, reject) => {
    const rs = createReadStream(INPUT, { highWaterMark: 256 * 1024 });
    const ws = createWriteStream(OUT);
    let carry = null;

    rs.on("data", (chunk) => {
      const buf = carry ? Buffer.concat([carry, chunk]) : chunk;
      carry = null;
      let lineStart = 0;

      while (true) {
        const nlPos = buf.indexOf(NEWLINE, lineStart);
        if (nlPos === -1) {
          if (lineStart < buf.length) carry = buf.subarray(lineStart);
          break;
        }
        const semiPos = buf.indexOf(SEMI, lineStart);
        if (semiPos !== -1 && semiPos < nlPos) {
          const pathLen = nlPos - semiPos;
          if (
            pathLen >= NEEDLE.length &&
            buf.subarray(semiPos, semiPos + NEEDLE.length).equals(NEEDLE)
          ) {
            ws.write(buf.subarray(lineStart, nlPos + 1));
          }
        }
        lineStart = nlPos + 1;
      }
    });

    rs.on("end", () => {
      // flush any final line without a trailing newline
      if (carry && carry.length > 0) {
        const semiPos = carry.indexOf(SEMI);
        if (
          semiPos !== -1 &&
          carry.length - semiPos >= NEEDLE.length &&
          carry.subarray(semiPos, semiPos + NEEDLE.length).equals(NEEDLE)
        ) {
          ws.write(carry);
          ws.write(Buffer.from("\n"));
        }
      }
      ws.end();
    });

    rs.on("error", reject);
    ws.on("finish", resolve);
    ws.on("error", reject);
  });
}

// ── benchmark runner ──────────────────────────────────────────────────────────

async function time(fn) {
  const t0 = performance.now();
  await fn();
  return performance.now() - t0;
}

async function bench(label, fn) {
  for (let i = 0; i < WARMUP; i++) await fn();
  const times = [];
  for (let i = 0; i < RUNS; i++) times.push(await time(fn));
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const std = Math.sqrt(
    times.map((t) => (t - mean) ** 2).reduce((a, b) => a + b, 0) / times.length,
  );
  return { label, mean, std, min: Math.min(...times), max: Math.max(...times) };
}

// ── main ──────────────────────────────────────────────────────────────────────

const scenarios = [
  ["grep -F (subprocess)", () => spawnGrep(["-F", ";interface/", INPUT])],
  ["grep (subprocess)", () => spawnGrep([";interface/", INPUT])],
  ["node stream+bytes (1BRC-style)", nodeStreamBytes],
  [
    "node readFileSync+split",
    () => {
      nodeReadfile();
      return Promise.resolve();
    },
  ],
  ["node readline", nodeReadline],
];

console.log(`\nListfile filter benchmark (${WARMUP} warmup, ${RUNS} runs, ${CPU_COUNT} cores)\n`);
console.log(`Input:  ${INPUT}`);
console.log(`Output: ${OUT}\n`);

const results = [];
for (const [label, fn] of scenarios) {
  process.stdout.write(`  ${label}...`);
  const r = await bench(label, fn);
  results.push(r);
  console.log(
    ` ${r.mean.toFixed(0)} ms ± ${r.std.toFixed(0)} ms  (min ${r.min.toFixed(0)}, max ${r.max.toFixed(0)})`,
  );
}

const fastest = Math.min(...results.map((r) => r.mean));
console.log("\n| Approach | Mean | ±Stddev | vs fastest |");
console.log("|---|---|---|---|");
for (const r of [...results].sort((a, b) => a.mean - b.mean)) {
  console.log(
    `| ${r.label} | ${r.mean.toFixed(0)} ms | ±${r.std.toFixed(0)} ms | ${(r.mean / fastest).toFixed(2)}× |`,
  );
}
