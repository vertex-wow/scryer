/**
 * Atlas manifest generation from CASC DB2 files (replaces wago.tools CSV path).
 *
 * Reads UiTextureAtlas.db2 and UiTextureAtlasMember.db2 directly from the
 * user's WoW installation via the CASC asset server. Produces the same
 * manifest format as atlas-gen.ts but with no outbound HTTP and no risk of
 * stale data from a remote CSV export.
 *
 * Used by:
 *   - AssetService.genAtlasFromDb2() (extension host, when installDir is set)
 *   - dev/gen-atlas.ts --db2 flag (CLI)
 */

import * as fs from "fs";
import * as path from "path";
import {
  parseWDC,
  UITEXTUREATLAS_SCHEMA,
  UITEXTUREATLASMEMBER_SCHEMA,
  type WDCRow,
} from "./db2-parser.js";

// ---------------------------------------------------------------------------
// Listfile loader (shared with atlas-gen.ts)
// ---------------------------------------------------------------------------

function loadListfile(listfilePath: string, log?: (msg: string) => void): Map<number, string> {
  if (!fs.existsSync(listfilePath)) throw new Error(`Listfile not found: ${listfilePath}`);
  log?.(`Loading listfile: ${listfilePath}`);
  const text = fs.readFileSync(listfilePath, "utf-8");
  const map = new Map<number, string>();
  for (const line of text.split(/\r?\n/)) {
    const semi = line.indexOf(";");
    if (semi === -1) continue;
    const id = parseInt(line.slice(0, semi), 10);
    const p = line
      .slice(semi + 1)
      .trim()
      .toLowerCase();
    if (!isNaN(id) && p) map.set(id, p);
  }
  log?.(`  ${map.size.toLocaleString()} entries`);
  return map;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface AtlasGenDb2Options {
  /** Absolute path where atlas-manifest.json should be written. */
  out: string;
  /** Absolute path to community-listfile.csv. Required. */
  listfile: string;
  /** Callback to read raw CASC file bytes by WoW-relative path. Returns null if unavailable. */
  readFile: (wowPath: string) => Promise<Buffer | null>;
  /** Log callback. */
  log?: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function generateAtlasManifestFromDb2(opts: AtlasGenDb2Options): Promise<void> {
  const log = opts.log ?? console.log;

  const listfile = loadListfile(opts.listfile, log);

  log("Reading UiTextureAtlas.db2 from CASC...");
  const atlasBuf = await opts.readFile("dbfilesclient/uitextureatlas.db2");
  if (!atlasBuf) throw new Error("UiTextureAtlas.db2 not found in CASC (retail only).");
  log(`  ${atlasBuf.length.toLocaleString()} bytes`);

  log("Reading UiTextureAtlasMember.db2 from CASC...");
  const memberBuf = await opts.readFile("dbfilesclient/uitextureatlasmember.db2");
  if (!memberBuf) throw new Error("UiTextureAtlasMember.db2 not found in CASC (retail only).");
  log(`  ${memberBuf.length.toLocaleString()} bytes`);

  log("Parsing UiTextureAtlas...");
  const atlasRows = parseWDC(atlasBuf, UITEXTUREATLAS_SCHEMA);
  log(`  ${atlasRows.length.toLocaleString()} rows`);

  log("Parsing UiTextureAtlasMember...");
  const memberRows = parseWDC(memberBuf, UITEXTUREATLASMEMBER_SCHEMA);
  log(`  ${memberRows.length.toLocaleString()} rows`);

  // UiCanvas 1 = 1024-wide, 2 = 2048-wide (HiDPI)
  const canvasWidthById = new Map<number, number>([
    [1, 1024],
    [2, 2048],
  ]);

  // Build atlas ID → { fileDataID, sheetW, sheetH, canvasWidth }
  const atlasById = new Map<
    number,
    { fileDataID: number; sheetW: number; sheetH: number; canvasWidth: number }
  >();
  for (const row of atlasRows) {
    const id = row["ID"] as number;
    const fileDataID = row["FileDataID"] as number;
    const sheetW = row["AtlasWidth"] as number;
    const sheetH = row["AtlasHeight"] as number;
    const canvasId = row["UiCanvasID"] as number;
    const canvasWidth = canvasWidthById.get(canvasId) ?? 1024;
    if (!isNaN(id)) atlasById.set(id, { fileDataID, sheetW, sheetH, canvasWidth });
  }

  type ManifestEntry = {
    file: string;
    x: number;
    y: number;
    width: number;
    height: number;
    sheetW: number;
    sheetH: number;
    tilesH: boolean;
    tilesV: boolean;
    logicalW: number;
    logicalH: number;
  };

  const manifest: Record<string, ManifestEntry> = {};
  let resolved = 0;
  let missing = 0;

  for (const row of memberRows) {
    const name = ((row["CommittedName"] as string) ?? "").trim();
    if (!name) continue;

    const atlasID = row["UiTextureAtlasID"] as number;
    const x = row["CommittedLeft"] as number;
    const y = row["CommittedTop"] as number;
    const width = row["Width"] as number;
    const height = row["Height"] as number;
    const flags = row["Flags"] as number;
    const overrideW = row["OverrideWidth"] as number;
    const overrideH = row["OverrideHeight"] as number;
    const memberCanvasId = row["UiCanvasID"] as number;

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

    const canvasWidth =
      (memberCanvasId ? canvasWidthById.get(memberCanvasId) : undefined) ?? sheet.canvasWidth;

    const logicalW = overrideW > 0 ? Math.round((overrideW * 1024) / canvasWidth) : 0;
    const logicalH = overrideH > 0 ? Math.round((overrideH * 1024) / canvasWidth) : 0;

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
