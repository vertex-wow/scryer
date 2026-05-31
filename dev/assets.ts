/**
 * assets — convert SVG assets to WoW-compatible texture files.
 *
 * Searches docs/**\/*.svg. For SVGs inside an Addons/ directory, outputs a TGA
 * (vertically flipped, as WoW expects) alongside the source SVG. For all other
 * SVGs it outputs a PNG (useful for README screenshots etc).
 *
 * Requires external tools: rsvg-convert, and gm (GraphicsMagick) or convert (ImageMagick).
 *
 * Usage:
 *   pnpm run assets
 *   node dist/assets.js
 */

import * as fs from "fs";
import * as path from "path";
import { isSvgConverterAvailable, svgToPng, pngToTga, resolveFlipTool } from "../src/assets/svg.js";

const PROJECT_ROOT = path.join(__dirname, "..");

// ---------------------------------------------------------------------------
// Tool detection
// ---------------------------------------------------------------------------

if (!isSvgConverterAvailable()) {
  console.error("Error: rsvg-convert not found. Install with:\n  sudo apt install librsvg2-bin");
  process.exit(1);
}

const flipTool = resolveFlipTool();
if (!flipTool) {
  console.error(
    "Error: No image conversion tool found. Install one of:\n" +
      "  sudo apt install graphicsmagick\n" +
      "  sudo apt install imagemagick",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// File walker
// ---------------------------------------------------------------------------

function findSvgs(dir: string): string[] {
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
  const svgs = findSvgs(path.join(PROJECT_ROOT, "docs"));
  let converted = 0;

  for (const svgFile of svgs) {
    const dir = path.dirname(svgFile);
    const base = path.basename(svgFile, ".svg");
    const rel = path.relative(PROJECT_ROOT, svgFile);
    const png = path.join(dir, `${base}.png`);

    console.log(`Converting ${rel}...`);
    await svgToPng(svgFile, png);

    if (svgFile.includes(`${path.sep}Addons${path.sep}`) || svgFile.includes("/Addons/")) {
      const tga = path.join(dir, `${base}.tga`);
      await pngToTga(png, tga, flipTool);
      console.log(`  -> ${base}.png`);
      console.log(`  -> ${base}.tga`);
    } else {
      console.log(`  -> ${base}.png`);
    }

    converted++;
  }

  console.log(`\n${converted} SVG(s) converted`);
})();
