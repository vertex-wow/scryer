/**
 * Scryer benchmark baseline comparison.
 *
 * Usage:
 *   node dev/bench/bench-diff.mjs dev/bench/bench-baseline.json dev/bench/bench-results.json
 *
 * Compares two bench-results.json files produced by pnpm bench.
 *
 * Guards:
 *   - Refuses to compare if corpusHash differs (different fixture sets = invalid comparison).
 *   - Refuses to compare if Node major version differs (JIT behavior changes across majors).
 *   - Warns (but does not refuse) if CPU model differs.
 *
 * Regression threshold:
 *   A result is a REGRESSION when median delta% > max(PCTG_MIN, 2 × baseline_cv × 100).
 *   This means "beyond 10% OR beyond twice the measured noise, whichever is larger."
 *   This avoids flagging noisy fast scenarios as regressions when noise is the dominant signal.
 *
 * Exit code:
 *   0 — no regressions (ok or improved)
 *   1 — at least one REGRESSION detected
 */

import * as fs from "node:fs";
import * as path from "node:path";

const PCTG_MIN = 10; // minimum regression threshold in percent (noise floor)
const IMPROVED_THRESHOLD = -10; // improved when delta < -10%

function usage() {
  console.error("Usage: node dev/bench-diff.mjs <baseline.json> <current.json>");
  process.exit(2);
}

function load(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`Failed to read ${file}: ${e.message}`);
    process.exit(2);
  }
}

function nodeMajor(version) {
  return parseInt(version.replace(/^v/, "").split(".")[0], 10);
}

// ---------------------------------------------------------------------------
// Guard checks
// ---------------------------------------------------------------------------

function checkCompatibility(base, curr) {
  let refuse = false;

  if (base.meta.corpusHash !== curr.meta.corpusHash) {
    console.error(
      `ERROR: Corpus hash mismatch.\n` +
        `  baseline: ${base.meta.corpusHash}  (${base.meta.blpFixtures} BLP, ${base.meta.addonFixtures} addon)\n` +
        `  current:  ${curr.meta.corpusHash}  (${curr.meta.blpFixtures} BLP, ${curr.meta.addonFixtures} addon)\n` +
        `  Re-run the baseline with the same corpus (dev/extract.sh must produce identical files).`,
    );
    refuse = true;
  }

  if (nodeMajor(base.meta.node) !== nodeMajor(curr.meta.node)) {
    console.error(
      `ERROR: Node major version mismatch.\n` +
        `  baseline: ${base.meta.node}   current: ${curr.meta.node}\n` +
        `  JIT behaviour differs across majors. Re-capture the baseline on the same Node version.`,
    );
    refuse = true;
  }

  if (refuse) process.exit(2);

  if (base.meta.cpu !== curr.meta.cpu) {
    console.warn(
      `WARNING: CPU model differs.\n` +
        `  baseline: ${base.meta.cpu}\n` +
        `  current:  ${curr.meta.cpu}\n` +
        `  Comparison is potentially invalid — results are only comparable on the same hardware.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Diff logic
// ---------------------------------------------------------------------------

function verdict(delta, baselineCV) {
  const threshold = Math.max(PCTG_MIN, baselineCV * 100 * 2);
  if (delta > threshold) return "REGRESSION";
  if (delta < IMPROVED_THRESHOLD) return "improved";
  return "ok";
}

function diffScenario(name, baseRows, currRows) {
  if (!Array.isArray(baseRows) || !Array.isArray(currRows)) return [];
  const rows = [];
  for (const base of baseRows) {
    const curr = currRows.find((r) => r.n === base.n && r.actual === base.actual);
    if (!curr) continue;
    const delta = base.median > 0 ? ((curr.median - base.median) / base.median) * 100 : 0;
    const v = verdict(delta, base.cv ?? 0);
    rows.push({
      scenario: name,
      n: base.n,
      actual: base.actual,
      base_ms: base.median,
      curr_ms: curr.median,
      delta_pct: delta,
      cv_base: base.cv ?? 0,
      verdict: v,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printTable(rows) {
  if (rows.length === 0) return;

  const VERDICTS = {
    REGRESSION: "\x1b[31mREGRESSION\x1b[0m",
    improved: "\x1b[32mimproved\x1b[0m",
    ok: "ok",
  };

  const header = [
    "scenario".padEnd(16),
    "N".padStart(5),
    "base_ms".padStart(9),
    "curr_ms".padStart(9),
    "delta%".padStart(8),
    "CV_base".padStart(8),
    "verdict".padEnd(10),
  ].join("  ");

  console.log(header);
  console.log("-".repeat(header.replace(/\x1b\[[0-9;]*m/g, "").length));

  for (const r of rows) {
    const sign = r.delta_pct > 0 ? "+" : "";
    console.log(
      [
        r.scenario.padEnd(16),
        String(r.n).padStart(5),
        r.base_ms.toFixed(1).padStart(9),
        r.curr_ms.toFixed(1).padStart(9),
        `${sign}${r.delta_pct.toFixed(1)}%`.padStart(8),
        r.cv_base.toFixed(3).padStart(8),
        VERDICTS[r.verdict] ?? r.verdict,
      ].join("  "),
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const [, , baseFile, currFile] = process.argv;
if (!baseFile || !currFile) usage();

const base = load(baseFile);
const curr = load(currFile);

console.log(`Scryer Benchmark Diff`);
console.log(
  `  baseline: ${path.basename(baseFile)}  (${base.meta.date}  git: ${base.meta.gitSha?.slice(0, 8) ?? "?"})`,
);
console.log(
  `  current:  ${path.basename(currFile)}  (${curr.meta.date}  git: ${curr.meta.gitSha?.slice(0, 8) ?? "?"})`,
);
console.log(
  `  corpus:   ${base.meta.corpusHash}  (${base.meta.blpFixtures} BLP, ${base.meta.addonFixtures} addon)`,
);
console.log(`  CPU:      ${base.meta.cpu}`);
console.log();

checkCompatibility(base, curr);

const SCENARIOS = ["texture", "addon", "combined", "cache-hit"];
const allRows = [];

for (const name of SCENARIOS) {
  const rows = diffScenario(name, base.results?.[name], curr.results?.[name]);
  allRows.push(...rows);
}

// Also diff resolution cold/warm sub-scenarios
for (const sub of ["cold", "warm"]) {
  const rows = diffScenario(
    `resolution.${sub}`,
    base.results?.resolution?.[sub],
    curr.results?.resolution?.[sub],
  );
  allRows.push(...rows);
}

if (allRows.length === 0) {
  console.log(
    "No comparable scenarios found. Make sure both files were produced by the same version of bench.ts.",
  );
  process.exit(2);
}

printTable(allRows);

const regressions = allRows.filter((r) => r.verdict === "REGRESSION");
const improved = allRows.filter((r) => r.verdict === "improved");

console.log();
if (regressions.length === 0 && improved.length === 0) {
  console.log("All scenarios within noise. No regressions.");
} else {
  if (improved.length > 0) console.log(`${improved.length} scenario(s) improved.`);
  if (regressions.length > 0) {
    console.log(`${regressions.length} REGRESSION(S) detected.`);
    console.log("Investigate with: node --cpu-prof dist/bench.js");
    console.log("Then open the .cpuprofile in Chrome DevTools or VS Code for a flame graph.");
  }
}

process.exit(regressions.length > 0 ? 1 : 0);
