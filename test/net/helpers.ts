import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const SETTINGS_PATH = path.join(__dirname, "../../dev/settings.local.json");

// Release binary produced by `pnpm build`.
const BINARY_PATH = path.join(
  __dirname,
  "../../scryer-asset-server/target/release/scryer-asset-server",
);

interface DevSettings {
  "scryer.installDir"?: string;
  [key: string]: unknown;
}

export interface NetTestEnv {
  wowDir: string;
  binaryPath: string;
  outDir: string;
}

/**
 * Returns the environment needed for net tests, or null when prerequisites
 * are not met (settings missing, WoW install absent, binary not built).
 *
 * Tests must call this and skip when it returns null.
 */
export function getNetTestEnv(): NetTestEnv | null {
  let settings: DevSettings;
  try {
    settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")) as DevSettings;
  } catch {
    return null;
  }

  const wowDir = settings["scryer.installDir"];
  if (!wowDir) return null;
  if (!fs.existsSync(path.join(wowDir, ".build.info"))) return null;
  if (!fs.existsSync(BINARY_PATH)) return null;

  return {
    wowDir,
    binaryPath: BINARY_PATH,
    outDir: path.join(os.tmpdir(), "scryer-net-test"),
  };
}
