/**
 * Three-way BLP decode benchmark:
 *
 *  JS         — blpToRgba() in-process (src/assets/blp-decode.ts)
 *  Data-IPC   — client.decodeBlpRgba(): send BLP bytes → Rust decodes → RGBA response
 *  CASC-IPC   — client.readCascBlpRgba(): send path → server reads CASC + decodes → RGBA response
 *
 * Usage:
 *   pnpm tsx dev/bench-rust-blp-decoder.ts [--runs N] [--corpus-only] [--synthetic-only]
 *
 * CASC-IPC requires scryer.installDir in dev/settings.local.json.
 * Data-IPC and JS work with synthetic fixtures and any extracted BLP cache.
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { resolve, join, extname } from "path";
import os from "os";
import { AssetClient } from "../src/assets/asset-client";
import { blpToRgba } from "../src/assets/blp-decode";

const ROOT = resolve(__dirname, "..");
const BINARY = join(ROOT, "scryer-asset-server/target/release/scryer-asset-server");

const RUNS = (() => {
  const i = process.argv.indexOf("--runs");
  return i !== -1 ? parseInt(process.argv[i + 1], 10) : 7;
})();
const CORPUS_ONLY = process.argv.includes("--corpus-only");
const SYNTHETIC_ONLY = process.argv.includes("--synthetic-only");

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

interface Settings {
  "scryer.installDir"?: string;
  "scryer.cacheDir"?: string;
}

function loadSettings(): Settings {
  try {
    return JSON.parse(readFileSync(join(ROOT, "dev/settings.local.json"), "utf8"));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Synthetic BLP2 fixture generator
// ---------------------------------------------------------------------------

const BLP2_MAGIC = 0x32504c42;
const HEADER_SIZE = 148;

interface FixtureSpec {
  label: string;
  encoding: number;
  alphaDepth: number;
  alphaEncoding: number;
  width: number;
  height: number;
}

function makeSyntheticBlp(spec: FixtureSpec): Buffer {
  const { encoding, alphaDepth, alphaEncoding, width, height } = spec;
  let pixelData: Buffer;

  if (encoding === 3) {
    pixelData = Buffer.alloc(width * height * 4);
    for (let i = 0; i < pixelData.length; i += 4) {
      pixelData[i] = 0x40;
      pixelData[i + 1] = 0x80;
      pixelData[i + 2] = 0xc0;
      pixelData[i + 3] = 0xff;
    }
  } else {
    const isDxt1 = alphaDepth <= 1;
    const blockBytes = isDxt1 ? 8 : 16;
    const bw = Math.ceil(width / 4);
    const bh = Math.ceil(height / 4);
    pixelData = Buffer.alloc(bw * bh * blockBytes, 0);
    for (let i = 0; i < bw * bh; i++) {
      const off = i * blockBytes;
      if (!isDxt1) {
        if (alphaEncoding === 7) {
          pixelData[off] = 255;
          pixelData[off + 1] = 0;
        } else {
          pixelData.fill(0xff, off, off + 8);
        }
      }
      const co = isDxt1 ? off : off + 8;
      pixelData.writeUInt16LE(0xf800, co);
      pixelData.writeUInt16LE(0x001f, co + 2);
    }
  }

  const header = Buffer.alloc(HEADER_SIZE, 0);
  header.writeUInt32LE(BLP2_MAGIC, 0);
  header.writeUInt32LE(1, 4);
  header.writeUInt8(encoding, 8);
  header.writeUInt8(alphaDepth, 9);
  header.writeUInt8(alphaEncoding, 10);
  header.writeUInt32LE(width, 12);
  header.writeUInt32LE(height, 16);
  header.writeUInt32LE(HEADER_SIZE, 20);
  header.writeUInt32LE(pixelData.length, 84);
  return Buffer.concat([header, pixelData]);
}

const SYNTHETIC_SPECS: FixtureSpec[] = [];
for (const [w, h] of [
  [64, 64],
  [256, 256],
  [512, 512],
  [1024, 1024],
] as [number, number][]) {
  SYNTHETIC_SPECS.push(
    { label: `DXT1 ${w}×${h}`, encoding: 2, alphaDepth: 0, alphaEncoding: 0, width: w, height: h },
    { label: `DXT3 ${w}×${h}`, encoding: 2, alphaDepth: 4, alphaEncoding: 0, width: w, height: h },
    { label: `DXT5 ${w}×${h}`, encoding: 2, alphaDepth: 8, alphaEncoding: 7, width: w, height: h },
    {
      label: `rawBGRA ${w}×${h}`,
      encoding: 3,
      alphaDepth: 8,
      alphaEncoding: 0,
      width: w,
      height: h,
    },
  );
}

// ---------------------------------------------------------------------------
// Real corpus: scan extracted source BLP files
// ---------------------------------------------------------------------------

function parseBlpMeta(buf: Buffer): { enc: string; w: number; h: number; rgbaKb: number } | null {
  if (buf.length < 148) return null;
  const encoding = buf[8];
  const alphaDepth = buf[9];
  const alphaEncoding = buf[10];
  const w = buf.readUInt32LE(12);
  const h = buf.readUInt32LE(16);
  const enc =
    encoding === 3 ? "bgra" : alphaDepth <= 1 ? "dxt1" : alphaEncoding === 7 ? "dxt5" : "dxt3";
  return { enc, w, h, rgbaKb: Math.round((w * h * 4) / 1024) };
}

interface CorpusEntry {
  label: string;
  cascPath: string; // relative CASC path for CASC-IPC
  diskPath: string; // absolute disk path for JS + Data-IPC
  buf: Buffer;
  enc: string;
  w: number;
  h: number;
  rgbaKb: number;
}

function loadCorpus(settings: Settings): CorpusEntry[] {
  const cacheDir = settings["scryer.cacheDir"];
  if (!cacheDir) return [];
  const sourceDir = join(cacheDir, "retail/source");
  try {
    statSync(sourceDir);
  } catch {
    return [];
  }

  const entries: CorpusEntry[] = [];
  function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (extname(name).toLowerCase() === ".blp") {
        const buf = readFileSync(full) as Buffer;
        const meta = parseBlpMeta(buf);
        if (!meta) continue;
        const cascPath = full.replace(sourceDir + "/", "");
        entries.push({
          label: cascPath,
          cascPath,
          diskPath: full,
          buf,
          ...meta,
        });
      }
    }
  }
  walk(sourceDir);
  // Sort by RGBA size descending so large textures appear first
  return entries.sort((a, b) => b.rgbaKb - a.rgbaKb);
}

// ---------------------------------------------------------------------------
// Benchmark helpers
// ---------------------------------------------------------------------------

type Ms = number | null;

async function timeJs(buf: Buffer): Promise<Ms> {
  let best: Ms = Infinity;
  for (let r = 0; r < RUNS; r++) {
    const t0 = performance.now();
    try {
      blpToRgba(buf);
    } catch {
      return null;
    }
    const e = performance.now() - t0;
    if (e < best!) best = e;
  }
  return best;
}

async function timeDataIpc(client: AssetClient, buf: Buffer): Promise<Ms> {
  let best: Ms = Infinity;
  for (let r = 0; r < RUNS; r++) {
    const t0 = performance.now();
    try {
      const result = await client.decodeBlpRgba(buf);
      if (!result) return null;
    } catch {
      return null;
    }
    const e = performance.now() - t0;
    if (e < best!) best = e;
  }
  return best;
}

async function timeCascIpc(client: AssetClient, cascPath: string): Promise<Ms> {
  let best: Ms = Infinity;
  for (let r = 0; r < RUNS; r++) {
    const t0 = performance.now();
    try {
      const result = await client.readCascBlpRgba(cascPath);
      if (!result) return null;
    } catch {
      return null;
    }
    const e = performance.now() - t0;
    if (e < best!) best = e;
  }
  return best;
}

function fmt(ms: Ms): string {
  if (ms == null) return " (skip)";
  return ms.toFixed(1);
}

function bestCol(js: Ms, data: Ms, casc: Ms): string {
  const valid: [string, number][] = [];
  if (js != null) valid.push(["JS", js]);
  if (data != null) valid.push(["Data-IPC", data]);
  if (casc != null) valid.push(["CASC-IPC", casc]);
  if (valid.length < 2) return "—";
  valid.sort((a, b) => a[1] - b[1]);
  const [winner, wMs] = valid[0];
  const [, secondMs] = valid[1];
  return `${winner} ${(secondMs / wMs).toFixed(1)}×`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const settings = loadSettings();
  const installDir = settings["scryer.installDir"] ?? os.tmpdir();
  const hasCasc = installDir !== os.tmpdir();

  const client = new AssetClient({
    binaryPath: BINARY,
    wowDir: installDir,
    outDir: os.tmpdir(),
    idleTimeout: 120,
  });

  // Warm up server — pays process startup + CASC init cost (not counted in results)
  console.log("Starting server" + (hasCasc ? " + initializing CASC (one-time cost)…" : "…"));
  if (hasCasc) {
    // Trigger CASC init by sending a readAndDecodeBlp that we don't time
    await client.readCascBlpRgba("interface/framegeneral/ui-background-rock.blp").catch(() => {});
  } else {
    await client.status();
  }
  console.log("Server ready.\n");

  const C = { label: 40, kb: 9, enc: 6, js: 10, data: 14, casc: 14, winner: 16 };
  const SEP = "-".repeat(C.label + C.kb + C.enc + C.js + C.data + C.casc + C.winner + 6);

  function printHeader() {
    console.log(
      `${"Fixture".padEnd(C.label)} ${"KB".padStart(C.kb)} ${"enc".padStart(C.enc)} ${"JS".padStart(C.js)} ${"Data-IPC".padStart(C.data)} ${"CASC-IPC".padStart(C.casc)} ${"best".padStart(C.winner)}`,
    );
    console.log(SEP);
  }

  function printRow(label: string, fileKb: number, enc: string, js: Ms, data: Ms, casc: Ms) {
    const lbl = label.slice(0, C.label);
    console.log(
      `${lbl.padEnd(C.label)} ${(fileKb + " KB").padStart(C.kb)} ${enc.padStart(C.enc)} ${fmt(js).padStart(C.js)} ${fmt(data).padStart(C.data)} ${fmt(casc).padStart(C.casc)} ${bestCol(js, data, casc).padStart(C.winner)}`,
    );
  }

  // ---- Synthetic fixtures (JS + Data-IPC only; no CASC path for synthetic data) ----
  if (!CORPUS_ONLY) {
    console.log(`=== Synthetic fixtures (best of ${RUNS} runs) ===\n`);
    printHeader();
    for (const spec of SYNTHETIC_SPECS) {
      const buf = makeSyntheticBlp(spec);
      const fileKb = Math.round(buf.length / 1024);
      const enc =
        spec.encoding === 3
          ? "bgra"
          : spec.alphaDepth <= 1
            ? "dxt1"
            : spec.alphaEncoding === 7
              ? "dxt5"
              : "dxt3";
      const [js, data] = await Promise.all([timeJs(buf), timeDataIpc(client, buf)]);
      printRow(spec.label, fileKb, enc, js, data, null);
    }
    console.log();
  }

  // ---- Real corpus (all three paths) ----
  if (!SYNTHETIC_ONLY) {
    const corpus = loadCorpus(settings);
    if (corpus.length === 0) {
      console.log("No corpus BLP files found (set scryer.cacheDir in dev/settings.local.json).");
    } else {
      console.log(`=== Real corpus: ${corpus.length} BLPs (best of ${RUNS} runs) ===\n`);
      printHeader();
      for (const entry of corpus) {
        const fileKb = Math.round(entry.buf.length / 1024);
        const js = await timeJs(entry.buf);
        const data = await timeDataIpc(client, entry.buf);
        const casc = hasCasc ? await timeCascIpc(client, entry.cascPath) : null;
        printRow(entry.label, fileKb, entry.enc, js, data, casc);
      }
    }
  }

  await client.shutdown().catch(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
