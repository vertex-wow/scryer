/**
 * Time BLP→PNG conversion on the extracted Interface/ texture tree.
 * Samples SAMPLE_SIZE random BLPs, reports per-file timing, extrapolates to full corpus.
 *
 * Run: pnpm exec node dist/conv-time.js [blp-root]
 * Default blp-root: .wow-cache/interface
 */

import * as fs from "fs";
import * as path from "path";
import { PNG } from "pngjs";
import { blpToRgba } from "../../src/assets/blp-decode.js";

const SAMPLE_SIZE = 200;
const arg = process.argv[2] ?? path.join(__dirname, "../..", ".wow-cache", "interface");

function walk(dir: string): string[] {
  let results: string[] = [];
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, f.name);
    if (f.isDirectory()) results = results.concat(walk(full));
    else if (f.name.toLowerCase().endsWith(".blp")) results.push(full);
  }
  return results;
}

// If arg is a file (not a directory), treat it as a newline-separated list of BLP paths
let blps: string[];
if (fs.existsSync(arg) && fs.statSync(arg).isFile()) {
  blps = fs
    .readFileSync(arg, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  process.stderr.write(`Loaded ${blps.length} BLP paths from ${arg}\n`);
} else {
  blps = walk(arg);
  process.stderr.write(`Found ${blps.length} BLP files in ${arg}\n`);
}
process.stderr.write(`Found ${blps.length} BLP files in ${arg}\n`);

const sampleSize = Math.min(SAMPLE_SIZE, blps.length);
const sample = [...blps].sort(() => Math.random() - 0.5).slice(0, sampleSize);

let decodeMs = 0,
  encodeMs = 0,
  ok = 0,
  fail = 0;
let totalRawBytes = 0,
  totalPngBytes = 0;

for (const f of sample) {
  try {
    const raw = fs.readFileSync(f);
    totalRawBytes += raw.length;

    const t0 = performance.now();
    const { rgba, width, height } = blpToRgba(raw);
    const t1 = performance.now();

    const png = new PNG({ width, height, filterType: -1 });
    png.data = rgba;
    const pngBuf = PNG.sync.write(png);
    const t2 = performance.now();

    decodeMs += t1 - t0;
    encodeMs += t2 - t1;
    totalPngBytes += pngBuf.length;
    ok++;
  } catch (e: unknown) {
    if (fail === 0) process.stderr.write(`First failure: ${f}: ${(e as Error).message}\n`);
    fail++;
  }
}

const avgDecodeMs = decodeMs / ok;
const avgEncodeMs = encodeMs / ok;
const avgTotalMs = (decodeMs + encodeMs) / ok;

process.stderr.write(`\nSample: ${sampleSize} files  ok=${ok}  fail=${fail}\n`);
process.stderr.write(
  `Decode   total=${decodeMs.toFixed(0)}ms  avg=${avgDecodeMs.toFixed(1)}ms/file\n`,
);
process.stderr.write(
  `Encode   total=${encodeMs.toFixed(0)}ms  avg=${avgEncodeMs.toFixed(1)}ms/file\n`,
);
process.stderr.write(`Decode:Encode ratio: ${(decodeMs / encodeMs).toFixed(1)}×\n`);
process.stderr.write(
  `Raw ${(totalRawBytes / 1024 / 1024).toFixed(1)}MB → PNG ${(totalPngBytes / 1024 / 1024).toFixed(1)}MB  (${(totalPngBytes / totalRawBytes).toFixed(2)}× expansion)\n`,
);
process.stderr.write(`\nExtrapolated for all ${blps.length} files:\n`);
process.stderr.write(`  Single-threaded: ${((avgTotalMs * blps.length) / 1000).toFixed(0)}s\n`);
process.stderr.write(
  `  Estimated ×8 workers: ${((avgTotalMs * blps.length) / 1000 / 8).toFixed(0)}s\n`,
);
process.stderr.write(
  `  PNG cache size: ~${(((totalPngBytes / ok) * blps.length) / 1024 / 1024 / 1024).toFixed(2)}GB\n`,
);
