/**
 * gen-atlas — CLI shim for src/assets/atlas-gen.ts.
 *
 * Thin entry point that parses CLI args and delegates to generateAtlasManifest().
 * All manifest-building logic lives in src/assets/atlas-gen.ts; this file only
 * handles argument parsing and process exit codes.
 *
 * Usage (after building dev scripts):
 *   pnpm run gen-atlas [options]
 *   node dist/gen-atlas.js [options]
 *
 * Options:
 *   --out <path>          Output JSON path. Default: atlas-manifest.json in project root.
 *   --atlas-csv <path>    Local UiTextureAtlas CSV (skips download).
 *   --members-csv <path>  Local UiTextureAtlasMember CSV (skips download).
 *   --listfile <path>     Community listfile CSV (required).
 *   --listfile-dir <dir>  Directory containing listfile.csv (alternative to --listfile).
 *   --build <buildID>     WoW build ID for wago.tools URL (e.g. "11.0.7.58187").
 *
 * Config (dev/settings.local.json): no keys used by this script; --listfile is required.
 */

import * as fs from "fs";
import * as path from "path";
import { generateAtlasManifest } from "../src/assets/atlas-gen.js";
import { generateAtlasManifestFromDb2 } from "../src/assets/atlas-gen-db2.js";
import {
  readAssetBytes,
  shutdownAssetClient,
  type ExtractCoreOptions,
} from "../src/assets/extract-core.js";

const PROJECT_ROOT = path.join(__dirname, "..");

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

// Load dev/settings.local.json for defaults
function loadDevConfig(): Record<string, string> {
  const p = path.join(PROJECT_ROOT, "dev", "settings.local.json");
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, string>;
  } catch {
    return {};
  }
}
const devCfg = loadDevConfig();

const args = process.argv.slice(2);
const opts = {
  out: path.join(PROJECT_ROOT, "atlas-manifest.json"),
  atlasCsv: undefined as string | undefined,
  membersCsv: undefined as string | undefined,
  listfile: undefined as string | undefined,
  build: undefined as string | undefined,
  db2: false,
  wowDir: (devCfg["scryer.installDir"] as string) ?? "",
  assetServerPath:
    (devCfg["scryer.assetServerPath"] as string) ??
    path.join(PROJECT_ROOT, "scryer-asset-server", "target", "release", "scryer-asset-server"),
  cacheDir: (devCfg["scryer.cacheDir"] as string) ?? path.join(PROJECT_ROOT, ".wow-cache"),
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
    case "--db2":
      opts.db2 = true;
      break;
    case "--wow-dir":
      opts.wowDir = args[++i];
      break;
    default:
      console.error(`Unknown argument: ${args[i]}`);
      process.exit(1);
  }
}

// Default listfile to casc-meta location if not specified
if (!opts.listfile) {
  const cascMetaListfile = path.join(
    opts.cacheDir,
    "retail",
    "source",
    ".casc-meta",
    "listfile.csv",
  );
  if (fs.existsSync(cascMetaListfile)) {
    opts.listfile = cascMetaListfile;
  }
}

if (!opts.listfile) {
  console.error("Error: --listfile <path> or --listfile-dir <dir> is required.");
  console.error(
    "       (Or run the extension once to populate .wow-cache/retail/source/.casc-meta/listfile.csv)",
  );
  process.exit(1);
}

if (opts.db2 && !opts.wowDir) {
  console.error(
    "Error: --db2 requires scryer.installDir in dev/settings.local.json or --wow-dir <path>.",
  );
  process.exit(1);
}

async function run(): Promise<void> {
  if (opts.db2) {
    const coreOpts: ExtractCoreOptions = {
      flavor: "retail",
      // outDir must point to the CASC source root so the server finds its cached listfile.
      outDir: path.join(opts.cacheDir, "retail", "source"),
      wowDir: opts.wowDir,
      assetServerPath: opts.assetServerPath,
      assetServerIdleTimeout: 60,
      log: () => {},
    };
    try {
      await generateAtlasManifestFromDb2({
        out: opts.out,
        listfile: opts.listfile!,
        readFile: (p) => readAssetBytes(p, coreOpts),
        log: console.log,
      });
    } finally {
      await shutdownAssetClient();
    }
  } else {
    await generateAtlasManifest({
      out: opts.out,
      atlasCsv: opts.atlasCsv,
      membersCsv: opts.membersCsv,
      listfile: opts.listfile!,
      build: opts.build,
      log: console.log,
    });
  }
}

run().catch((err: unknown) => {
  console.error((err as Error).message ?? err);
  process.exit(1);
});
