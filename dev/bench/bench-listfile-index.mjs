/**
 * Listfile SQLite index benchmark — Phase 1 (build cost) + Phase 2 (point lookup).
 *
 * Measures the cost of building a SQLite index from listfile-templates.csv
 * (169 K pre-filtered rows) using various libraries, then benchmarks point
 * lookup speed for a simulated atlas-gen workload (~16 K FileDataID queries).
 *
 * Key difference from the Q1b benchmark: all approaches receive the same
 * pre-filtered 169 K row file as input, giving a fair apples-to-apples
 * comparison (Q1b gave grep pre-filtering only to the sqlite3 CLI path).
 *
 * Usage:
 *   node dev/bench-listfile-index.mjs <listfile-templates.csv> [runs] [warmup]
 *
 * Example:
 *   node dev/bench-listfile-index.mjs \
 *     .wow-cache/retail/source/.casc-meta/listfile-templates.csv
 *
 * Requires: node:sqlite (built-in Node 24), better-sqlite3, @libsql/client, sqlite-xsv
 * Optional: sqlite3 CLI on PATH, external/sqlean/vsv.so
 */

import { performance } from "perf_hooks";
import { existsSync, readFileSync, writeFileSync, unlinkSync, createReadStream } from "fs";
import { createInterface } from "readline";
import { spawn } from "child_process";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

const XSV_SO = path.join(
  ROOT,
  "node_modules/.pnpm/sqlite-xsv-linux-x64@0.2.1-alpha.13/node_modules/sqlite-xsv-linux-x64/xsv0.so",
);
const VSV_SO = path.join(ROOT, "external/sqlean/vsv.so");
const QSV_BIN = path.join(ROOT, "external/qsv/qsv");
const XAN_BIN = "xan"; // expected on PATH after cargo install

const INPUT = process.argv[2];
const RUNS = parseInt(process.argv[3] ?? "5", 10);
const WARMUP = parseInt(process.argv[4] ?? "2", 10);
const DB_PATH = "/tmp/listfile-bench.db";
const INPUT_WITH_HEADER = "/tmp/listfile-bench-input.csv";

if (!INPUT || !existsSync(INPUT)) {
  console.error(
    "Usage: node dev/bench-listfile-index.mjs <listfile-templates.csv> [runs] [warmup]",
  );
  console.error("       listfile-templates.csv must be the pre-filtered Interface/-only file");
  process.exit(1);
}

// ── CSV parsing ───────────────────────────────────────────────────────────────

/** Parse listfile CSV line: "id;path" → [id, path] pairs */
function* parseLines(text) {
  for (const line of text.split("\n")) {
    const semi = line.indexOf(";");
    if (semi === -1) continue;
    const id = parseInt(line.slice(0, semi), 10);
    const path = line
      .slice(semi + 1)
      .trim()
      .toLowerCase();
    if (!isNaN(id) && path) yield [id, path];
  }
}

async function* parseLinesStream(filePath) {
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of rl) {
    const semi = line.indexOf(";");
    if (semi === -1) continue;
    const id = parseInt(line.slice(0, semi), 10);
    const path = line
      .slice(semi + 1)
      .trim()
      .toLowerCase();
    if (!isNaN(id) && path) yield [id, path];
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function rmdb() {
  if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
  // WAL sidefiles
  if (existsSync(DB_PATH + "-wal")) unlinkSync(DB_PATH + "-wal");
  if (existsSync(DB_PATH + "-shm")) unlinkSync(DB_PATH + "-shm");
}

/** Spawn a subprocess and wait for it to exit 0. */
function runCmd(bin, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    const errs = [];
    proc.stderr.on("data", (d) => errs.push(d));
    proc.on("close", (code) => {
      if (code !== 0) reject(new Error(`${bin} exited ${code}: ${Buffer.concat(errs)}`));
      else resolve();
    });
    proc.on("error", reject);
  });
}

function hasCmd(cmd) {
  try {
    const r = spawn(cmd, ["--version"]);
    return new Promise((res) => {
      r.on("close", (code) => res(code === 0));
      r.on("error", () => res(false));
    });
  } catch {
    return Promise.resolve(false);
  }
}

// ── Phase 1: build approaches ─────────────────────────────────────────────────

/** node:sqlite — readFileSync + tx INSERT */
function buildNodeSqliteSync() {
  rmdb();
  const text = readFileSync(INPUT, "utf8");
  const db = new DatabaseSync(DB_PATH);
  db.exec(`CREATE TABLE listfile (id INTEGER PRIMARY KEY, path TEXT NOT NULL)`);
  db.exec("BEGIN");
  const stmt = db.prepare("INSERT INTO listfile VALUES (?, ?)");
  for (const [id, path] of parseLines(text)) stmt.run(id, path);
  db.exec("COMMIT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_id ON listfile(id)");
  db.close();
}

/** node:sqlite — readline stream + tx INSERT */
async function buildNodeSqliteStream() {
  rmdb();
  const db = new DatabaseSync(DB_PATH);
  db.exec(`CREATE TABLE listfile (id INTEGER PRIMARY KEY, path TEXT NOT NULL)`);
  db.exec("BEGIN");
  const stmt = db.prepare("INSERT INTO listfile VALUES (?, ?)");
  for await (const [id, path] of parseLinesStream(INPUT)) stmt.run(id, path);
  db.exec("COMMIT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_id ON listfile(id)");
  db.close();
}

/** better-sqlite3 — readFileSync + tx INSERT */
function buildBetterSqliteSync() {
  rmdb();
  const Database = require("better-sqlite3");
  const text = readFileSync(INPUT, "utf8");
  const db = new Database(DB_PATH);
  db.exec(`CREATE TABLE listfile (id INTEGER PRIMARY KEY, path TEXT NOT NULL)`);
  const insert = db.prepare("INSERT INTO listfile VALUES (?, ?)");
  const insertMany = db.transaction((rows) => {
    for (const r of rows) insert.run(r);
  });
  const rows = [...parseLines(text)];
  insertMany(rows);
  db.exec("CREATE INDEX IF NOT EXISTS idx_id ON listfile(id)");
  db.close();
}

/** better-sqlite3 — readline stream + tx INSERT */
async function buildBetterSqliteStream() {
  rmdb();
  const Database = require("better-sqlite3");
  const db = new Database(DB_PATH);
  db.exec(`CREATE TABLE listfile (id INTEGER PRIMARY KEY, path TEXT NOT NULL)`);
  const insert = db.prepare("INSERT INTO listfile VALUES (?, ?)");
  db.exec("BEGIN");
  for await (const [id, path] of parseLinesStream(INPUT)) insert.run(id, path);
  db.exec("COMMIT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_id ON listfile(id)");
  db.close();
}

/** @libsql/client — readFileSync + batch INSERT */
async function buildLibsql() {
  rmdb();
  const { createClient } = require("@libsql/client");
  const client = createClient({ url: `file:${DB_PATH}` });
  await client.execute(`CREATE TABLE listfile (id INTEGER PRIMARY KEY, path TEXT NOT NULL)`);
  const text = readFileSync(INPUT, "utf8");
  const rows = [...parseLines(text)];
  // Batch in chunks — libsql batch limit is large but not unlimited
  const CHUNK = 1000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await client.batch(
      chunk.map(([id, path]) => ({
        sql: "INSERT INTO listfile VALUES (?, ?)",
        args: [id, path],
      })),
      "write",
    );
  }
  await client.execute("CREATE INDEX IF NOT EXISTS idx_id ON listfile(id)");
  client.close();
}

/** node:sqlite + sqlite-xsv virtual table — INSERT SELECT, no JS row loop */
function buildNodeSqliteXsv() {
  rmdb();
  const db = new DatabaseSync(DB_PATH, { allowExtension: true });
  db.loadExtension(XSV_SO);
  db.exec(`CREATE TABLE listfile (id INTEGER PRIMARY KEY, path TEXT NOT NULL)`);
  db.exec(`CREATE VIRTUAL TABLE _raw USING xsv(filename='${INPUT}', delimiter=';', header=no)`);
  db.exec(`INSERT INTO listfile SELECT CAST(c1 AS INTEGER), lower(c2) FROM _raw`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_id ON listfile(id)`);
  db.close();
}

/** node:sqlite + sqlean vsv virtual table — INSERT SELECT, no JS row loop */
function buildNodeSqliteVsv() {
  rmdb();
  const db = new DatabaseSync(DB_PATH, { allowExtension: true });
  db.loadExtension(VSV_SO);
  db.exec(`CREATE TABLE listfile (id INTEGER PRIMARY KEY, path TEXT NOT NULL)`);
  db.exec(`CREATE VIRTUAL TABLE _raw USING vsv(filename='${INPUT}', fsep=';', header=no)`);
  db.exec(`INSERT INTO listfile SELECT CAST(c0 AS INTEGER), lower(c1) FROM _raw`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_id ON listfile(id)`);
  db.close();
}

/** better-sqlite3 + sqlite-xsv virtual table — INSERT SELECT, no JS row loop */
function buildBetterSqliteXsv() {
  rmdb();
  const Database = require("better-sqlite3");
  const db = new Database(DB_PATH);
  db.loadExtension(XSV_SO);
  db.exec(`CREATE TABLE listfile (id INTEGER PRIMARY KEY, path TEXT NOT NULL)`);
  db.exec(`CREATE VIRTUAL TABLE _raw USING xsv(filename='${INPUT}', delimiter=';', header=no)`);
  db.exec(`INSERT INTO listfile SELECT CAST(c1 AS INTEGER), lower(c2) FROM _raw`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_id ON listfile(id)`);
  db.close();
}

/** better-sqlite3 + sqlean vsv virtual table — INSERT SELECT, no JS row loop */
function buildBetterSqliteVsv() {
  rmdb();
  const Database = require("better-sqlite3");
  const db = new Database(DB_PATH);
  db.loadExtension(VSV_SO);
  db.exec(`CREATE TABLE listfile (id INTEGER PRIMARY KEY, path TEXT NOT NULL)`);
  db.exec(`CREATE VIRTUAL TABLE _raw USING vsv(filename='${INPUT}', fsep=';', header=no)`);
  db.exec(`INSERT INTO listfile SELECT CAST(c0 AS INTEGER), lower(c1) FROM _raw`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_id ON listfile(id)`);
  db.close();
}

/**
 * qsv to sqlite — native Rust CSV parser writing directly to SQLite.
 * Requires INPUT_WITH_HEADER (header-prepended copy) created at startup.
 * qsv auto-detects the semicolon delimiter from file content.
 */
async function buildQsv() {
  rmdb();
  await runCmd(QSV_BIN, ["to", "sqlite", "--drop", DB_PATH, INPUT_WITH_HEADER]);
  // qsv names the table after the filename; rename to 'listfile' and add index
  const db = new DatabaseSync(DB_PATH);
  db.exec(`ALTER TABLE [listfile-bench-input] RENAME TO listfile`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_id ON listfile(id)`);
  db.close();
}

/** sqlite3 CLI — .import direct (no pre-filtering needed, file is already filtered) */
function buildSqliteCli() {
  return new Promise((resolve, reject) => {
    rmdb();
    const proc = spawn("sqlite3", [DB_PATH], { stdio: ["pipe", "ignore", "pipe"] });
    proc.stdin.write(`.separator ";" "\\n"\n`);
    proc.stdin.write(`CREATE TABLE listfile (id INTEGER, path TEXT);\n`);
    proc.stdin.write(`.import ${INPUT} listfile\n`);
    proc.stdin.write(`CREATE INDEX IF NOT EXISTS idx_id ON listfile(id);\n`);
    proc.stdin.end();
    const errs = [];
    proc.stderr.on("data", (d) => errs.push(d));
    proc.on("close", (code) => {
      if (code !== 0) reject(new Error(`sqlite3 exited ${code}: ${Buffer.concat(errs)}`));
      else resolve();
    });
    proc.on("error", reject);
  });
}

// ── Phase 2: lookup approaches ────────────────────────────────────────────────

/** Sample N FileDataIDs from the input file for lookup benchmarks */
function sampleIds(n) {
  const text = readFileSync(INPUT, "utf8");
  const ids = [];
  for (const [id] of parseLines(text)) {
    ids.push(id);
    if (ids.length >= n * 10) break; // oversample then pick evenly
  }
  // Pick n evenly-spaced IDs from the sample
  const step = Math.max(1, Math.floor(ids.length / n));
  return ids.filter((_, i) => i % step === 0).slice(0, n);
}

function lookupNodeSqlite(ids) {
  const db = new DatabaseSync(DB_PATH);
  const stmt = db.prepare("SELECT path FROM listfile WHERE id = ?");
  let hits = 0;
  for (const id of ids) {
    if (stmt.get(id)) hits++;
  }
  db.close();
  return hits;
}

function lookupBetterSqlite(ids) {
  const Database = require("better-sqlite3");
  const db = new Database(DB_PATH, { readonly: true });
  const stmt = db.prepare("SELECT path FROM listfile WHERE id = ?");
  let hits = 0;
  for (const id of ids) {
    if (stmt.get(id)) hits++;
  }
  db.close();
  return hits;
}

async function lookupLibsql(ids) {
  const { createClient } = require("@libsql/client");
  const client = createClient({ url: `file:${DB_PATH}` });
  let hits = 0;
  // Batch all lookups in one round-trip
  const results = await client.batch(
    ids.map((id) => ({ sql: "SELECT path FROM listfile WHERE id = ?", args: [id] })),
    "read",
  );
  for (const r of results) {
    if (r.rows.length > 0) hits++;
  }
  client.close();
  return hits;
}

// ── benchmark runner ──────────────────────────────────────────────────────────

async function time(fn) {
  const t0 = performance.now();
  await fn();
  return performance.now() - t0;
}

async function bench(label, fn) {
  process.stdout.write(`  ${label}...`);
  for (let i = 0; i < WARMUP; i++) await fn();
  const times = [];
  for (let i = 0; i < RUNS; i++) times.push(await time(fn));
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const std = Math.sqrt(
    times.map((t) => (t - mean) ** 2).reduce((a, b) => a + b, 0) / times.length,
  );
  const result = { label, mean, std, min: Math.min(...times), max: Math.max(...times) };
  console.log(
    ` ${mean.toFixed(0)} ms ± ${std.toFixed(0)} ms  (min ${result.min.toFixed(0)}, max ${result.max.toFixed(0)})`,
  );
  return result;
}

function printTable(results) {
  const fastest = Math.min(...results.map((r) => r.mean));
  console.log("\n| Approach | Mean | ±Stddev | vs fastest |");
  console.log("|---|---|---|---|");
  for (const r of [...results].sort((a, b) => a.mean - b.mean)) {
    console.log(
      `| ${r.label} | ${r.mean.toFixed(0)} ms | ±${r.std.toFixed(0)} ms | ${(r.mean / fastest).toFixed(2)}× |`,
    );
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

const [hasSqlite3, hasQsv] = await Promise.all([
  hasCmd("sqlite3"),
  Promise.resolve(existsSync(QSV_BIN)),
]);
const hasXsv = existsSync(XSV_SO);
const hasVsv = existsSync(VSV_SO);

// qsv and xan need a header row; create a header-prepended copy once.
// xan has no native SQLite output (xan to: html/json/xlsx only), so xan is excluded.
if (hasQsv) {
  writeFileSync(INPUT_WITH_HEADER, "id;path\n" + readFileSync(INPUT, "utf8"));
}

console.log(`\nListfile SQLite index benchmark (${WARMUP} warmup, ${RUNS} runs)`);
console.log(`Input:  ${INPUT}`);
console.log(`DB:     ${DB_PATH}`);
if (!hasSqlite3) console.log(`  (sqlite3 CLI not found — skipping CLI approach)`);
if (!hasQsv) console.log(`  (qsv not found at external/qsv/qsv — skipping qsv approach)`);
if (!hasXsv) console.log(`  (sqlite-xsv not found — skipping xsv extension approaches)`);
if (!hasVsv)
  console.log(`  (external/sqlean/vsv.so not found — skipping vsv extension approaches)`);

// ── Phase 1: build cost ───────────────────────────────────────────────────────

console.log("\n## Phase 1 — build cost (write-once, 169 K rows)\n");

const buildScenarios = [
  [
    "node:sqlite  readFileSync+tx",
    () => {
      buildNodeSqliteSync();
      return Promise.resolve();
    },
  ],
  ["node:sqlite  stream+tx", buildNodeSqliteStream],
  [
    "better-sqlite3  readFileSync+tx",
    () => {
      buildBetterSqliteSync();
      return Promise.resolve();
    },
  ],
  ["better-sqlite3  stream+tx", buildBetterSqliteStream],
  ["@libsql/client  batch", buildLibsql],
];

if (hasXsv) {
  buildScenarios.push([
    "node:sqlite + xsv  INSERT SELECT",
    () => {
      buildNodeSqliteXsv();
      return Promise.resolve();
    },
  ]);
  buildScenarios.push([
    "better-sqlite3 + xsv  INSERT SELECT",
    () => {
      buildBetterSqliteXsv();
      return Promise.resolve();
    },
  ]);
}
if (hasVsv) {
  buildScenarios.push([
    "node:sqlite + vsv  INSERT SELECT",
    () => {
      buildNodeSqliteVsv();
      return Promise.resolve();
    },
  ]);
  buildScenarios.push([
    "better-sqlite3 + vsv  INSERT SELECT",
    () => {
      buildBetterSqliteVsv();
      return Promise.resolve();
    },
  ]);
}
if (hasQsv) {
  buildScenarios.push(["qsv to sqlite", buildQsv]);
}
if (hasSqlite3) {
  buildScenarios.push(["sqlite3 CLI  .import", buildSqliteCli]);
}

const buildResults = [];
for (const [label, fn] of buildScenarios) {
  buildResults.push(await bench(label, fn));
}
printTable(buildResults);

// ── Phase 2: point lookup speed ───────────────────────────────────────────────

console.log("\n## Phase 2 — point lookup speed (16 K FileDataID queries, warm DB)\n");

// Build a fresh DB with the fastest Node approach for lookups
buildNodeSqliteSync();
const LOOKUP_N = 16_000;
const ids = sampleIds(LOOKUP_N);
console.log(`  Sampled ${ids.length} IDs from input for lookup test\n`);

const lookupScenarios = [
  [
    "node:sqlite  prepared ×16K",
    () => {
      lookupNodeSqlite(ids);
      return Promise.resolve();
    },
  ],
  [
    "better-sqlite3  prepared ×16K",
    () => {
      lookupBetterSqlite(ids);
      return Promise.resolve();
    },
  ],
  ["@libsql/client  batch ×16K", () => lookupLibsql(ids)],
];

const lookupResults = [];
for (const [label, fn] of lookupScenarios) {
  lookupResults.push(await bench(label, fn));
}
printTable(lookupResults);

const lookupFastest = Math.min(...lookupResults.map((r) => r.mean));
console.log(`\n  Per-lookup median: ${(lookupFastest / ids.length).toFixed(3)} ms`);

rmdb();
if (existsSync(INPUT_WITH_HEADER)) unlinkSync(INPUT_WITH_HEADER);
console.log("\nDone.\n");
