/**
 * TGA decoder benchmark — emulates the call path used in src/assets/index.ts.
 *
 * Measures the per-file cost of the new TGA decode pipeline and compares
 * it against the stub (file never read → return null) so measurements.md
 * can record the overhead added by TGA support.
 *
 * Run (after pnpm build):
 *   node dist/bench-tga.js [--runs N]
 *
 * Fixtures:
 *   - test/fixtures/assets/vertex-icon.tga  (real, 512×512 24bpp uncompressed)
 *   - Synthetic 64×64, 256×256 uncompressed (generated in-memory)
 *   - Synthetic 256×512 32bpp RLE (generated in-memory)
 */

import * as fs from "fs";
import * as path from "path";
import { performance } from "perf_hooks";
import { PNG } from "pngjs";
import { tgaToRgba } from "../../src/assets/tga-decode.js";

const REPO_ROOT = path.join(__dirname, "../..");
const FIXTURE_DIR = path.join(REPO_ROOT, "test", "fixtures", "assets");

const RUNS_DEFAULT = 7;
const WARMUP = 1;

// ---------------------------------------------------------------------------
// Synthetic TGA helpers
// ---------------------------------------------------------------------------

interface SyntheticSpec {
  label: string;
  width: number;
  height: number;
  bpp: 24 | 32;
  rle: boolean;
}

function makeUncompressedTga(width: number, height: number, bpp: 24 | 32): Buffer {
  const bytesPerPixel = bpp >> 3;
  const header = Buffer.alloc(18, 0);
  header[2] = 2; // uncompressed true-color
  header.writeUInt16LE(width, 12);
  header.writeUInt16LE(height, 14);
  header[16] = bpp;
  header[17] = 0x20; // top-to-bottom, no flip needed (saves time in bench)

  const pixels = Buffer.alloc(width * height * bytesPerPixel, 0x55); // fill with grey-ish BGR
  return Buffer.concat([header, pixels]);
}

function makeRleTga(width: number, height: number, bpp: 24 | 32): Buffer {
  const bppBytes = bpp >> 3;
  const header = Buffer.alloc(18, 0);
  header[2] = 10; // RLE true-color
  header.writeUInt16LE(width, 12);
  header.writeUInt16LE(height, 14);
  header[16] = bpp;
  header[17] = 0x20; // top-to-bottom

  // Worst-case RLE: alternate between two pixel values (forces raw packets).
  // Each raw packet covers 128 pixels, so packet overhead is ~1/128.
  const pixelCount = width * height;
  const pixelA = Buffer.alloc(bppBytes, 0x44);
  const pixelB = Buffer.alloc(bppBytes, 0x88);

  const chunks: Buffer[] = [];
  let i = 0;
  while (i < pixelCount) {
    const rawCount = Math.min(128, pixelCount - i);
    const pkHeader = Buffer.alloc(1);
    pkHeader[0] = rawCount - 1; // raw packet, 0-based count
    chunks.push(pkHeader);
    for (let j = 0; j < rawCount; j++) {
      chunks.push(j % 2 === 0 ? pixelA : pixelB);
    }
    i += rawCount;
  }

  return Buffer.concat([header, ...chunks]);
}

// ---------------------------------------------------------------------------
// Timing helpers
// ---------------------------------------------------------------------------

function bestOf(fn: () => void, runs: number): number {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    const elapsed = performance.now() - t0;
    if (elapsed < best) best = elapsed;
  }
  return +best.toFixed(3);
}

// ---------------------------------------------------------------------------
// Per-file split measurement
// ---------------------------------------------------------------------------

interface SplitResult {
  label: string;
  fileSizeKB: number;
  width: number;
  height: number;
  bpp: number;
  imageType: number;
  t_read_ms: number;
  t_decode_ms: number;
  t_encode_ms: number;
  total_ms: number;
}

function measureFile(
  label: string,
  getBuffer: () => Buffer,
  absPath: string | null,
  runs: number,
): SplitResult {
  // Warm up
  for (let i = 0; i < WARMUP; i++) {
    const buf = getBuffer();
    const { rgba, width, height } = tgaToRgba(buf);
    const png = new PNG({ width, height });
    png.data = rgba;
    PNG.sync.write(png);
  }

  // Measure t_read (only meaningful for file-based fixtures)
  const t_read_ms = absPath ? bestOf(() => fs.readFileSync(absPath), runs) : 0;

  // Get a buffer for decode/encode timing
  const buf = getBuffer();
  const fileSizeKB = +(buf.length / 1024).toFixed(1);

  // Parse header for metadata
  const width = buf.readUInt16LE(12);
  const height = buf.readUInt16LE(14);
  const bpp = buf[16];
  const imageType = buf[2];

  // Measure t_decode
  let savedRgba!: Buffer;
  let savedW = 0;
  let savedH = 0;
  const t_decode_ms = bestOf(() => {
    const r = tgaToRgba(buf);
    savedRgba = r.rgba;
    savedW = r.width;
    savedH = r.height;
  }, runs);

  // Measure t_encode
  const t_encode_ms = bestOf(() => {
    const png = new PNG({ width: savedW, height: savedH });
    png.data = savedRgba;
    PNG.sync.write(png);
  }, runs);

  const total_ms = +(t_read_ms + t_decode_ms + t_encode_ms).toFixed(3);

  return {
    label,
    fileSizeKB,
    width,
    height,
    bpp,
    imageType,
    t_read_ms,
    t_decode_ms,
    t_encode_ms,
    total_ms,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const runsArg = process.argv.indexOf("--runs");
const RUNS = runsArg >= 0 ? parseInt(process.argv[runsArg + 1] ?? "7", 10) : RUNS_DEFAULT;

console.log(`\nTGA decoder benchmark — ${RUNS} timed runs (best-of), ${WARMUP} warmup\n`);

const fixtures: { label: string; getBuffer: () => Buffer; absPath: string | null }[] = [
  {
    label: "synthetic 64×64 24bpp uncompressed",
    getBuffer: () => makeUncompressedTga(64, 64, 24),
    absPath: null,
  },
  {
    label: "synthetic 256×256 24bpp uncompressed",
    getBuffer: () => makeUncompressedTga(256, 256, 24),
    absPath: null,
  },
  {
    label: "synthetic 256×512 32bpp RLE (worst-case)",
    getBuffer: () => makeRleTga(256, 512, 32),
    absPath: null,
  },
  {
    label: "vertex-icon (512×512 24bpp uncompressed)",
    getBuffer: () => fs.readFileSync(path.join(FIXTURE_DIR, "vertex-icon.tga")),
    absPath: path.join(FIXTURE_DIR, "vertex-icon.tga"),
  },
];

const results: SplitResult[] = [];
for (const f of fixtures) {
  process.stdout.write(`  measuring ${f.label}...`);
  const r = measureFile(f.label, f.getBuffer, f.absPath, RUNS);
  results.push(r);
  process.stdout.write(` done (total ${r.total_ms} ms)\n`);
}

// ---------------------------------------------------------------------------
// Table output
// ---------------------------------------------------------------------------

console.log("\n--- TGA decode split timers (best-of-" + RUNS + ", ms) ---\n");

const header = [
  "Fixture".padEnd(42),
  "KB".padStart(7),
  "WxH".padStart(10),
  "bpp".padStart(4),
  "type".padStart(5),
  "t_read".padStart(8),
  "t_decode".padStart(9),
  "t_encode".padStart(9),
  "total".padStart(8),
].join("  ");

console.log(header);
console.log("-".repeat(header.length));

for (const r of results) {
  const typeStr = r.imageType === 2 ? "unc" : "rle";
  const line = [
    r.label.padEnd(42),
    r.fileSizeKB.toFixed(1).padStart(7),
    `${r.width}×${r.height}`.padStart(10),
    String(r.bpp).padStart(4),
    typeStr.padStart(5),
    r.t_read_ms.toFixed(3).padStart(8),
    r.t_decode_ms.toFixed(3).padStart(9),
    r.t_encode_ms.toFixed(3).padStart(9),
    r.total_ms.toFixed(3).padStart(8),
  ].join("  ");
  console.log(line);
}

console.log();
console.log(
  "Pre-impl baseline: current code returns null without reading the file (~0 ms decode).",
);
console.log("Post-impl: the total_ms column shows the per-texture overhead added.");
