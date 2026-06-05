/**
 * png-to-blp — one-shot PNG → BLP2 converter.
 *
 * Usage:
 *   pnpm run png-to-blp <input.png> [output.blp]
 *   node dist/png-to-blp.js <input.png> [output.blp]
 *
 * If output path is omitted, replaces .png extension with .blp.
 */

import * as fs from "fs";
import * as path from "path";
import { pngToBlp } from "../src/assets/blp.js";

const [, , inputArg, outputArg] = process.argv;

if (!inputArg) {
  console.error("Usage: node dist/png-to-blp.js <input.png> [output.blp]");
  process.exit(1);
}

const inputPath = path.resolve(inputArg);
const blpPath = outputArg ? path.resolve(outputArg) : inputPath.replace(/\.png$/i, ".blp");

fs.mkdirSync(path.dirname(blpPath), { recursive: true });
pngToBlp(inputPath, blpPath);
console.log(`Written: ${blpPath}`);
