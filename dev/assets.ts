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

import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";

const PROJECT_ROOT = path.join(__dirname, "..");

// ---------------------------------------------------------------------------
// Tool detection
// ---------------------------------------------------------------------------

function which(bin: string): boolean {
  const result = cp.spawnSync(process.platform === "win32" ? "where" : "which", [bin], {
    stdio: "pipe",
    shell: process.platform === "win32",
  });
  return result.status === 0;
}

function requireTool(bin: string, installHint: string): void {
  if (!which(bin)) {
    console.error(`Error: Required tool '${bin}' not found. Install with:\n  ${installHint}`);
    process.exit(1);
  }
}

requireTool("rsvg-convert", "sudo apt install librsvg2-bin");

const convertCmd = which("gm") ? ["gm", "convert"] : which("convert") ? ["convert"] : null;
if (!convertCmd) {
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
// Subprocess helper
// ---------------------------------------------------------------------------

function run(cmd: string, args: string[]): void {
  const result = cp.spawnSync(cmd, args, { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`Command failed: ${cmd} ${args.join(" ")}`);
    process.exit(result.status ?? 1);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const svgs = findSvgs(path.join(PROJECT_ROOT, "docs"));
let converted = 0;

for (const svgFile of svgs) {
  const dir = path.dirname(svgFile);
  const base = path.basename(svgFile, ".svg");
  const rel = path.relative(PROJECT_ROOT, svgFile);
  const png = path.join(dir, `${base}.png`);

  console.log(`Converting ${rel}...`);
  run("rsvg-convert", [svgFile, "-o", png]);

  if (svgFile.includes(`${path.sep}Addons${path.sep}`) || svgFile.includes("/Addons/")) {
    const tga = path.join(dir, `${base}.tga`);
    run(convertCmd[0], [...convertCmd.slice(1), png, "-flip", tga]);
    console.log(`  -> ${base}.png`);
    console.log(`  -> ${base}.tga`);
  } else {
    console.log(`  -> ${base}.png`);
  }

  converted++;
}

console.log(`\n${converted} SVG(s) converted`);
