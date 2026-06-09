/**
 * extract — CLI shim for src/assets/extract-core.ts.
 *
 * Thin entry point that parses CLI args and delegates to extractPaths() or extractBulk().
 * All extraction logic lives in src/assets/extract-core.ts; this file only handles
 * argument parsing, config loading, and process exit codes.
 *
 * Usage (after building dev scripts):
 *   pnpm run extract [flavor] [options]
 *   node dist/extract.js [retail|classic|classic_era] [options]
 *
 * Options:
 *   --out-dir <dir>       Output root (default: .wow-cache/ at project root).
 *   --type textures|interface|all  Category to extract (default: textures). Ignored with --paths-file.
 *   --paths-file <file>   Newline-delimited list of specific paths to extract.
 *   --wow-dir <path>      WoW root directory. Falls back to dev/settings.local.json → wowDir.
 *   --casc-tool <path>    CASC binary path. Falls back to dev/settings.local.json → cascTool.
 *   --listfile-dir <dir>  Directory for listfile.csv cache (default: .wow-cache/).
 *
 * Config: dev/settings.local.json (gitignored) may supply wowDir and cascTool as defaults.
 * Copy dev/settings.json.example to dev/settings.local.json and fill in your local paths.
 */

import * as fs from "fs";
import * as path from "path";
import {
  extractBulk,
  extractPaths,
  type ExtractType,
  type Flavor,
} from "../src/assets/extract-core.js";

const PROJECT_ROOT = path.join(__dirname, "..");

// ---------------------------------------------------------------------------
// Load optional dev/settings.local.json
// ---------------------------------------------------------------------------

interface DevConfig {
  "scryer.installDir"?: string;
  "scryer.assetServerPath"?: string;
  "scryer.assetServerIdleTimeout"?: number;
}

function loadDevConfig(): DevConfig {
  const configPath = path.join(PROJECT_ROOT, "dev", "settings.local.json");
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8")) as DevConfig;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

const FLAVORS = new Set(["retail", "classic", "classic_era"]);
const TYPES = new Set(["textures", "interface", "all"]);

let flavor: Flavor = "retail";
let outDir = path.join(PROJECT_ROOT, ".wow-cache");
let listfileDir = path.join(PROJECT_ROOT, ".wow-cache");
let type: ExtractType = "textures";
let pathsFile: string | undefined;
let wowDirArg: string | undefined;
let cascToolArg: string | undefined;

let i = 0;
if (args[0] && !args[0].startsWith("--")) {
  const f = args[0];
  if (!FLAVORS.has(f)) {
    console.error(`Unknown flavor: ${f}. Must be retail, classic, or classic_era.`);
    process.exit(1);
  }
  flavor = f as Flavor;
  i = 1;
}

for (; i < args.length; i++) {
  switch (args[i]) {
    case "--out-dir":
      outDir = args[++i];
      break;
    case "--type":
      if (!TYPES.has(args[i + 1])) {
        console.error(`--type must be textures, interface, or all`);
        process.exit(1);
      }
      type = args[++i] as ExtractType;
      break;
    case "--paths-file":
      pathsFile = args[++i];
      break;
    case "--wow-dir":
      wowDirArg = args[++i];
      break;
    case "--casc-tool":
      cascToolArg = args[++i];
      break;
    case "--listfile-dir":
      listfileDir = args[++i];
      break;
    default:
      console.error(`Unknown argument: ${args[i]}`);
      process.exit(1);
  }
}

const devConfig = loadDevConfig();
const wowDir = wowDirArg ?? devConfig["scryer.installDir"];
const assetServerPath = cascToolArg || devConfig["scryer.assetServerPath"] || "scryer-asset-server";
const assetServerIdleTimeout = devConfig["scryer.assetServerIdleTimeout"] ?? 20;

if (!wowDir) {
  console.error(
    "Error: --wow-dir is required (or set scryer.installDir in dev/settings.local.json).\n" +
      "  Copy dev/settings.json.example to dev/settings.local.json and fill in scryer.installDir.",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Run extraction
// ---------------------------------------------------------------------------

const coreOpts = {
  flavor,
  outDir,
  wowDir: wowDir!,
  assetServerPath,
  assetServerIdleTimeout,
  listfileDir,
  log: (_level, msg) => console.log(msg),
};

async function run(): Promise<void> {
  if (pathsFile) {
    const raw = fs.readFileSync(pathsFile, "utf-8");
    const paths = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    await extractPaths(paths, coreOpts);
  } else {
    await extractBulk(type, coreOpts);
  }

  console.log("\nDone. Assets written to:");
  console.log(`  ${outDir}`);
  console.log('\nSet scryer.cacheLocation to "custom" and scryer.cacheDir to the parent of this');
  console.log("directory in your VSCode settings (or re-run via the extension).");
}

run().catch((err: unknown) => {
  console.error((err as Error).message ?? err);
  process.exit(1);
});
