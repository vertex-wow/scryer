#!/usr/bin/env node
/**
 * gen-atlas.mjs — Generate atlas-manifest.json from WoW DB2 table CSV exports.
 *
 * Sources UiTextureAtlas and UiTextureAtlasMember table data (CSV format) and
 * joins them with dev/listfile.csv to produce a JSON manifest keyed by atlas name:
 *
 *   { "atlas-name": { file, x, y, width, height, sheetW, sheetH, tilesH, tilesV } }
 *
 * The manifest is consumed by AssetService.loadAtlasManifest() and used by the
 * renderer to crop sprite-sheet textures. Expected location in the cache:
 *   <cacheRoot>/<flavor>/derived/atlas-manifest.json
 *
 * CSV acquisition:
 *   By default, the script downloads the current retail CSV exports from wago.tools.
 *   Pass --atlas-csv and --members-csv to supply local files instead (required for
 *   classic/classic_era, or when offline).
 *
 *   wago.tools CSV download URLs:
 *     https://wago.tools/db2/UiTextureAtlas/csv?build=<buildID>
 *     https://wago.tools/db2/UiTextureAtlasMember/csv?build=<buildID>
 *   (omitting ?build= returns the latest retail data)
 *
 * Usage:
 *   node dev/gen-atlas.mjs [options]
 *
 * Options:
 *   --out <path>          Output JSON path. Default: atlas-manifest.json in project root.
 *   --atlas-csv <path>    Local UiTextureAtlas CSV file (skips download).
 *   --members-csv <path>  Local UiTextureAtlasMember CSV file (skips download).
 *   --listfile <path>     Community listfile CSV (absolute path).
 *   --listfile-dir <dir>  Directory containing listfile.csv. Alternative to --listfile.
 *   --build <buildID>     WoW build ID string for wago.tools URL (e.g. "11.0.7.58187").
 *                         Omit to get the latest retail data.
 */

import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.dirname(__dirname);

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const opts = {
  out: path.join(PROJECT_ROOT, "atlas-manifest.json"),
  atlasCsv: null,
  membersCsv: null,
  listfile: null,
  build: "",
};

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case "--out":
      opts.out = args[++i];
      break;
    case "--atlas-csv":
      opts.atlasCsv = args[++i];
      break;
    case "--members-csv":
      opts.membersCsv = args[++i];
      break;
    case "--listfile":
      opts.listfile = args[++i];
      break;
    case "--listfile-dir":
      opts.listfile = path.join(args[++i], "listfile.csv");
      break;
    case "--build":
      opts.build = args[++i];
      break;
    default:
      console.error(`Unknown argument: ${args[i]}`);
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return fetchUrl(res.headers.location).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          res.resume();
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

/**
 * Parse a simple CSV: first row is header, remaining rows are data.
 * Quoted fields with commas are handled; no escape sequences beyond "".
 */
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];

  const headers = parseCsvRow(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvRow(lines[i]);
    const row = {};
    for (let j = 0; j < headers.length; j++) row[headers[j]] = cols[j] ?? "";
    rows.push(row);
  }
  return rows;
}

function parseCsvRow(line) {
  const fields = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      i++;
      let val = "";
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') {
          val += '"';
          i += 2;
        } else if (line[i] === '"') {
          i++;
          break;
        } else {
          val += line[i++];
        }
      }
      fields.push(val);
      if (line[i] === ",") i++;
    } else {
      const end = line.indexOf(",", i);
      if (end === -1) {
        fields.push(line.slice(i));
        break;
      }
      fields.push(line.slice(i, end));
      i = end + 1;
    }
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Listfile loader (fileDataID → Interface/... path)
// ---------------------------------------------------------------------------

function loadListfile(listfilePath) {
  if (!listfilePath) {
    throw new Error(`No listfile specified. Pass --listfile <path> or --listfile-dir <dir>.`);
  }
  if (!fs.existsSync(listfilePath)) {
    throw new Error(
      `Listfile not found: ${listfilePath}\n  Download it with dev/extract.sh (it runs ensure_listfile automatically).`,
    );
  }
  console.log(`Loading listfile: ${listfilePath}`);
  const text = fs.readFileSync(listfilePath, "utf-8");
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const semi = line.indexOf(";");
    if (semi === -1) continue;
    const id = parseInt(line.slice(0, semi), 10);
    const p = line.slice(semi + 1).trim();
    if (!isNaN(id) && p) map.set(id, p);
  }
  console.log(`  ${map.size.toLocaleString()} entries`);
  return map;
}

// ---------------------------------------------------------------------------
// CSV acquisition
// ---------------------------------------------------------------------------

async function getCsv(localPath, urlSuffix, buildParam) {
  if (localPath) {
    console.log(`Reading ${urlSuffix} from: ${localPath}`);
    return fs.readFileSync(localPath, "utf-8");
  }
  const buildQuery = buildParam ? `?build=${encodeURIComponent(buildParam)}` : "";
  const url = `https://wago.tools/db2/${urlSuffix}/csv${buildQuery}`;
  console.log(`Downloading ${urlSuffix} from wago.tools...`);
  console.log(`  ${url}`);
  return fetchUrl(url);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Load listfile
  const listfile = loadListfile(opts.listfile);

  // Fetch CSV data
  const atlasCsv = await getCsv(opts.atlasCsv, "UiTextureAtlas", opts.build);
  const membersCsv = await getCsv(opts.membersCsv, "UiTextureAtlasMember", opts.build);

  // Parse UiTextureAtlas: ID → { fileDataID, sheetW, sheetH }
  const atlasRows = parseCsv(atlasCsv);
  console.log(`  UiTextureAtlas: ${atlasRows.length} rows`);

  const atlasById = new Map();
  for (const row of atlasRows) {
    const id = parseInt(row["ID"], 10);
    const fileDataID = parseInt(row["FileDataID"] ?? row["File Data ID"] ?? "0", 10);
    const sheetW = parseInt(row["AtlasWidth"] ?? row["Atlas Width"] ?? "0", 10);
    const sheetH = parseInt(row["AtlasHeight"] ?? row["Atlas Height"] ?? "0", 10);
    if (!isNaN(id)) atlasById.set(id, { fileDataID, sheetW, sheetH });
  }

  // Parse UiTextureAtlasMember: CommittedName → entry
  const memberRows = parseCsv(membersCsv);
  console.log(`  UiTextureAtlasMember: ${memberRows.length} rows`);

  const manifest = {};
  let resolved = 0;
  let missing = 0;

  for (const row of memberRows) {
    const name = (row["CommittedName"] ?? row["Committed Name"] ?? "").trim();
    if (!name) continue;

    const atlasID = parseInt(row["UiTextureAtlasID"] ?? row["Ui Texture Atlas ID"] ?? "0", 10);
    const x = parseInt(row["CommittedLeft"] ?? row["Committed Left"] ?? "0", 10);
    const y = parseInt(row["CommittedTop"] ?? row["Committed Top"] ?? "0", 10);
    const width = parseInt(row["Width"] ?? "0", 10);
    const height = parseInt(row["Height"] ?? "0", 10);
    // Flags column presence varies by export; bit 0x1 = tilesHorizontally, bit 0x2 = tilesVertically
    const flags = parseInt(row["Flags"] ?? row["Flags_0x1"] ?? "0", 10);

    const sheet = atlasById.get(atlasID);
    if (!sheet || !sheet.fileDataID) {
      missing++;
      continue;
    }

    const filePath = listfile.get(sheet.fileDataID);
    if (!filePath) {
      missing++;
      continue;
    }

    manifest[name] = {
      file: filePath,
      x,
      y,
      width,
      height,
      sheetW: sheet.sheetW,
      sheetH: sheet.sheetH,
      tilesH: (flags & 0x1) !== 0,
      tilesV: (flags & 0x2) !== 0,
    };
    resolved++;
  }

  console.log(`\nResolved: ${resolved} atlas entries`);
  if (missing > 0) console.log(`Skipped:  ${missing} (no FileDataID match in listfile)`);

  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  fs.writeFileSync(opts.out, JSON.stringify(manifest, null, 2), "utf-8");
  console.log(`\nWrote: ${opts.out}`);
  console.log(
    `\nPlace this file at <cacheRoot>/<flavor>/derived/atlas-manifest.json for Scryer to pick it up.`,
  );
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
