/**
 * gen-globalstrings — extract enUS GlobalStrings into src/lua/globalstrings.json
 *
 * Reads the enUS GlobalStrings from the vscode-wow-api reference corpus and
 * writes a compact JSON file that the sandbox bootstrap uses to populate _G
 * before any addon code runs.
 *
 * Usage: pnpm run gen-globalstrings
 */

import * as fs from "fs";
import * as path from "path";
import { data } from "../_reference/vscode-wow-api/src/data/globalstring/enUS.js";

const PROJECT_ROOT = path.join(__dirname, "..");
const OUT = path.join(PROJECT_ROOT, "src/lua/globalstrings.json");

fs.writeFileSync(OUT, JSON.stringify(data), "utf-8");
console.log(`Wrote ${Object.keys(data).length} entries → ${path.relative(PROJECT_ROOT, OUT)}`);
