/**
 * Benchmark: fast typed-array BLP decoder vs js-blp
 *
 * Usage:
 *   pnpm tsx dev/bench-blp-decoder.ts [--runs N]
 *
 * Compares blpToRgba (src/assets/blp-decode.ts) against js-blp's
 * BLPFile.getPixels() for each BLP file found under test/.
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { resolve, join, extname } from "path";
import BLPFile from "js-blp";
import { blpToRgba } from "../src/assets/blp-decode";

const ROOT = resolve(import.meta.dirname, "..");

const RUNS = (() => {
  const i = process.argv.indexOf("--runs");
  return i !== -1 ? parseInt(process.argv[i + 1], 10) : 3;
})();

function collectBlps(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) collectBlps(full, out);
    else if (extname(name).toLowerCase() === ".blp") out.push(full);
  }
  return out;
}

const fixtureDir = join(ROOT, "test");
const blpFiles = collectBlps(fixtureDir);

if (blpFiles.length === 0) {
  console.error("No BLP files found under test/");
  process.exit(1);
}

console.log(`Benchmarking ${blpFiles.length} BLP files × ${RUNS} run(s) each\n`);
console.log(
  `${"File".padEnd(60)} ${"js-blp (ms)".padStart(12)} ${"fast (ms)".padStart(10)} ${"speedup".padStart(8)}`,
);
console.log("-".repeat(95));

let totalOld = 0;
let totalNew = 0;

for (const fp of blpFiles) {
  const buf = readFileSync(fp) as Buffer;
  const label = fp.replace(ROOT + "/", "").slice(0, 58);

  // js-blp (best of N)
  let msOld = Infinity;
  for (let r = 0; r < RUNS; r++) {
    const t0 = performance.now();
    const blp = new BLPFile(buf);
    blp.getPixels(0);
    const elapsed = performance.now() - t0;
    if (elapsed < msOld) msOld = elapsed;
  }

  // fast decoder (best of N)
  let msNew = Infinity;
  let skipped = false;
  for (let r = 0; r < RUNS; r++) {
    const t0 = performance.now();
    try {
      blpToRgba(buf);
    } catch {
      skipped = true;
      break;
    }
    const elapsed = performance.now() - t0;
    if (elapsed < msNew) msNew = elapsed;
  }

  if (skipped) {
    console.log(
      `${label.padEnd(60)} ${msOld.toFixed(1).padStart(12)} ${"(skip)".padStart(10)} ${"—".padStart(8)}`,
    );
    totalOld += msOld;
    continue;
  }

  const speedup = msOld / msNew;
  totalOld += msOld;
  totalNew += msNew;

  const marker = speedup >= 10 ? " ◀◀◀" : speedup >= 3 ? " ◀◀" : speedup >= 1.5 ? " ◀" : "";
  console.log(
    `${label.padEnd(60)} ${msOld.toFixed(1).padStart(12)} ${msNew.toFixed(1).padStart(10)} ${(speedup.toFixed(1) + "×").padStart(8)}${marker}`,
  );
}

console.log("-".repeat(95));
console.log(
  `${"TOTAL (best of N runs)".padEnd(60)} ${totalOld.toFixed(1).padStart(12)} ${totalNew.toFixed(1).padStart(10)} ${((totalOld / totalNew).toFixed(1) + "×").padStart(8)}`,
);
