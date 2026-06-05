/**
 * assets — convert SVG assets to all WoW-compatible texture formats.
 *
 * Searches configured directories for .svg files and produces PNG alongside
 * each source. Directories flagged for WoW textures also produce TGA (vertically
 * flipped) and BLP. Outputs are skipped if they already exist — use --force to
 * regenerate.
 *
 * Requires: rsvg-convert. TGA output additionally requires gm or convert.
 *
 * Usage:
 *   pnpm run assets [--force]
 *   node dist/assets.js [--force]
 */

import * as fs from "fs";
import * as path from "path";
import { isSvgConverterAvailable, svgToPng, pngToTga, resolveFlipTool } from "../src/assets/svg.js";
import { pngToBlp } from "../src/assets/blp.js";

const PROJECT_ROOT = path.join(__dirname, "..");
const FORCE = process.argv.includes("--force");

// Directories to scan for SVG assets.
// tga/blp flags enable WoW texture outputs (TGA vertically flipped, BLP raw-BGRA).
const SCAN_DIRS: Array<{ dir: string; tga: boolean; blp: boolean }> = [
  { dir: path.join(PROJECT_ROOT, "docs"), tga: false, blp: false },
  { dir: path.join(PROJECT_ROOT, "test", "fixtures", "assets"), tga: true, blp: true },
];

// ---------------------------------------------------------------------------
// Tool detection
// ---------------------------------------------------------------------------

if (!isSvgConverterAvailable()) {
  console.error("Error: rsvg-convert not found. Install with:\n  sudo apt install librsvg2-bin");
  process.exit(1);
}

const flipTool = resolveFlipTool(); // null when neither gm nor convert is available

// ---------------------------------------------------------------------------
// File walker
// ---------------------------------------------------------------------------

function findSvgs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findSvgs(full));
    else if (entry.name.endsWith(".svg")) results.push(full);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

void (async () => {
  const entries = SCAN_DIRS.flatMap(({ dir, tga, blp }) =>
    findSvgs(dir).map((svg) => ({ svg, tga, blp })),
  );

  if (entries.length === 0) {
    console.log("No SVG files found.");
    return;
  }

  let converted = 0;
  let skipped = 0;

  for (const { svg: svgFile, tga: wantTga, blp: wantBlp } of entries) {
    const dir = path.dirname(svgFile);
    const base = path.basename(svgFile, ".svg");
    const rel = path.relative(PROJECT_ROOT, svgFile);
    const pngPath = path.join(dir, `${base}.png`);
    const tgaPath = path.join(dir, `${base}.tga`);
    const blpPath = path.join(dir, `${base}.blp`);

    const needsPng = FORCE || !fs.existsSync(pngPath);
    const needsTga = wantTga && (FORCE || !fs.existsSync(tgaPath));
    const needsBlp = wantBlp && (FORCE || !fs.existsSync(blpPath));

    if (!needsPng && !needsTga && !needsBlp) {
      console.log(`Skipping ${rel} (all outputs present)`);
      skipped++;
      continue;
    }

    console.log(`Converting ${rel}...`);

    if (needsPng || needsTga) {
      await svgToPng(svgFile, pngPath);
      if (needsPng) console.log(`  -> ${base}.png`);
    }

    if (needsTga) {
      if (!flipTool) {
        console.error(
          "Error: TGA output requires gm or convert. Install one of:\n" +
            "  sudo apt install graphicsmagick\n" +
            "  sudo apt install imagemagick",
        );
        process.exit(1);
      }
      await pngToTga(pngPath, tgaPath, flipTool);
      console.log(`  -> ${base}.tga`);
    }

    if (needsBlp) {
      pngToBlp(pngPath, blpPath);
      console.log(`  -> ${base}.blp`);
    }

    converted++;
  }

  console.log(`\n${converted} SVG(s) converted, ${skipped} skipped.`);
})();
