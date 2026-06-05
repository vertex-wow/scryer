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

import * as path from "path";
import { generateAtlasManifest } from "../src/assets/atlas-gen.js";

const PROJECT_ROOT = path.join(__dirname, "..");

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const opts = {
  out: path.join(PROJECT_ROOT, "atlas-manifest.json"),
  atlasCsv: undefined as string | undefined,
  membersCsv: undefined as string | undefined,
  listfile: undefined as string | undefined,
  build: undefined as string | undefined,
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

if (!opts.listfile) {
  console.error("Error: --listfile <path> or --listfile-dir <dir> is required.");
  process.exit(1);
}

generateAtlasManifest({
  out: opts.out,
  atlasCsv: opts.atlasCsv,
  membersCsv: opts.membersCsv,
  listfile: opts.listfile,
  build: opts.build,
  log: console.log,
}).catch((err: unknown) => {
  console.error((err as Error).message ?? err);
  process.exit(1);
});
