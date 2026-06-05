/**
 * Atlas manifest generation — self-contained, no vscode dependency.
 *
 * Sources UiTextureAtlas and UiTextureAtlasMember DB2 table exports (CSV format)
 * and joins them with the community listfile to produce a JSON manifest keyed by
 * atlas name: { "atlas-name": { file, x, y, width, height, sheetW, sheetH, tilesH, tilesV } }
 *
 * Used by:
 *   - AssetService.ensureAtlasManifest() (extension host, via extractor.ts wrapper)
 *   - dev/gen-atlas.ts (CLI shim for manual runs)
 */

import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as path from "path";

export interface AtlasGenOptions {
  /** Absolute path where atlas-manifest.json should be written. */
  out: string;
  /** Local UiTextureAtlas CSV file; downloads from wago.tools if absent. */
  atlasCsv?: string;
  /** Local UiTextureAtlasMember CSV file; downloads from wago.tools if absent. */
  membersCsv?: string;
  /** Absolute path to community-listfile.csv. Required. */
  listfile: string;
  /** WoW build ID string for wago.tools URL. Omit for latest retail data. */
  build?: string;
  /** Log callback. Defaults to console.log. */
  log?: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// HTTP helpers
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
// CSV parser
// ---------------------------------------------------------------------------

function parseCsvRow(line: string): string[] {
  const fields: string[] = [];
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

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = parseCsvRow(lines[0]);
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvRow(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) row[headers[j]] = cols[j] ?? "";
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Listfile loader
// ---------------------------------------------------------------------------

function loadListfile(listfilePath: string, log?: (msg: string) => void): Map<number, string> {
  if (!fs.existsSync(listfilePath)) {
    throw new Error(`Listfile not found: ${listfilePath}`);
  }
  log?.(`Loading listfile: ${listfilePath}`);
  const text = fs.readFileSync(listfilePath, "utf-8");
  const map = new Map<number, string>();
  for (const line of text.split(/\r?\n/)) {
    const semi = line.indexOf(";");
    if (semi === -1) continue;
    const id = parseInt(line.slice(0, semi), 10);
    const p = line.slice(semi + 1).trim();
    if (!isNaN(id) && p) map.set(id, p);
  }
  log?.(`  ${map.size.toLocaleString()} entries`);
  return map;
}

// ---------------------------------------------------------------------------
// CSV acquisition
// ---------------------------------------------------------------------------

async function getCsv(
  localPath: string | undefined,
  tableName: string,
  build: string | undefined,
  log?: (msg: string) => void,
): Promise<string> {
  if (localPath) {
    log?.(`Reading ${tableName} from: ${localPath}`);
    return fs.readFileSync(localPath, "utf-8");
  }
  const buildQuery = build ? `?build=${encodeURIComponent(build)}` : "";
  const url = `https://wago.tools/db2/${tableName}/csv${buildQuery}`;
  log?.(`Downloading ${tableName} from wago.tools...`);
  log?.(`  ${url}`);
  return fetchText(url);
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function generateAtlasManifest(opts: AtlasGenOptions): Promise<void> {
  const log = opts.log ?? console.log;

  const listfile = loadListfile(opts.listfile, log);

  const atlasCsv = await getCsv(opts.atlasCsv, "UiTextureAtlas", opts.build, log);
  const membersCsv = await getCsv(opts.membersCsv, "UiTextureAtlasMember", opts.build, log);

  const atlasRows = parseCsv(atlasCsv);
  log(`  UiTextureAtlas: ${atlasRows.length} rows`);

  const atlasById = new Map<number, { fileDataID: number; sheetW: number; sheetH: number }>();
  for (const row of atlasRows) {
    const id = parseInt(row["ID"], 10);
    const fileDataID = parseInt(row["FileDataID"] ?? row["File Data ID"] ?? "0", 10);
    const sheetW = parseInt(row["AtlasWidth"] ?? row["Atlas Width"] ?? "0", 10);
    const sheetH = parseInt(row["AtlasHeight"] ?? row["Atlas Height"] ?? "0", 10);
    if (!isNaN(id)) atlasById.set(id, { fileDataID, sheetW, sheetH });
  }

  const memberRows = parseCsv(membersCsv);
  log(`  UiTextureAtlasMember: ${memberRows.length} rows`);

  const manifest: Record<
    string,
    {
      file: string;
      x: number;
      y: number;
      width: number;
      height: number;
      sheetW: number;
      sheetH: number;
      tilesH: boolean;
      tilesV: boolean;
      // Non-zero when the DB2 row carries an explicit logical-size override (OverrideWidth /
      // OverrideHeight columns). Use these to compute the correct pixel→WoW-unit divisor
      // for -2x atlas entries instead of blindly dividing physical dimensions by 2.
      logicalW: number;
      logicalH: number;
    }
  > = {};
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
    const flags = parseInt(row["Flags"] ?? row["CommittedFlags"] ?? "0", 10);
    const logicalW = parseInt(row["OverrideWidth"] ?? "0", 10);
    const logicalH = parseInt(row["OverrideHeight"] ?? "0", 10);

    const sheet = atlasById.get(atlasID);
    if (!sheet?.fileDataID) {
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
      logicalW,
      logicalH,
    };
    resolved++;
  }

  log(`\nResolved: ${resolved} atlas entries`);
  if (missing > 0) log(`Skipped:  ${missing} (no FileDataID match in listfile)`);

  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  fs.writeFileSync(opts.out, JSON.stringify(manifest, null, 2), "utf-8");
  log(`\nWrote: ${opts.out}`);
}
