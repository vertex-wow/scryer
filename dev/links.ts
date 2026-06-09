/**
 * links — set up _live/ and _reference/ symlinks for development.
 *
 * Creates symlinks pointing into the local WoW installation so that _live/Addons
 * tracks the installed addon tree and _live/WTF-Account tracks SavedVariables.
 * Run once after cloning; re-run to repair broken links.
 *
 * Usage (after building dev scripts):
 *   pnpm run links
 *   node dist/links.js
 *
 * Config: reads wowDir and wowAccount from dev/settings.local.json (gitignored).
 * Copy dev/settings.json.example to dev/settings.local.json and fill in your paths.
 */

import * as fs from "fs";
import * as path from "path";

const PROJECT_ROOT = path.join(__dirname, "..");

// ---------------------------------------------------------------------------
// Load dev/settings.local.json
// ---------------------------------------------------------------------------

interface DevConfig {
  "scryer.installDir"?: string;
  wowAccount?: string;
  "scryer.assetServerPath"?: string;
}

function loadDevConfig(): DevConfig {
  const configPath = path.join(PROJECT_ROOT, "dev", "settings.local.json");
  if (!fs.existsSync(configPath)) {
    console.error(
      `Error: dev/settings.local.json not found.\n` +
        `  Copy dev/settings.json.example to dev/settings.local.json and fill in scryer.installDir and wowAccount.`,
    );
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8")) as DevConfig;
  } catch (err) {
    console.error(`Error reading dev/settings.local.json: ${(err as Error).message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Symlink helper
// ---------------------------------------------------------------------------

function createSymlink(linkPath: string, target: string): void {
  if (fs.existsSync(linkPath) || fs.lstatSync(linkPath).isSymbolicLink?.()) {
    fs.unlinkSync(linkPath);
  }
  fs.symlinkSync(target, linkPath);
  console.log(`Linked: ${linkPath} -> ${target}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const config = loadDevConfig();

if (!config["scryer.installDir"]) {
  console.error("Error: scryer.installDir is not set in dev/settings.local.json.");
  process.exit(1);
}
if (!config.wowAccount) {
  console.error("Error: wowAccount is not set in dev/settings.local.json.");
  process.exit(1);
}

const wowDir = config["scryer.installDir"]!.replace(/\/$/, "");
const retailDir = `${wowDir}/_retail_`;
const liveDir = path.join(PROJECT_ROOT, "_live");
const refDir = path.join(PROJECT_ROOT, "_reference");

fs.mkdirSync(liveDir, { recursive: true });
fs.mkdirSync(refDir, { recursive: true });

const links: Record<string, string> = {
  [path.join(liveDir, "Addons")]: `${retailDir}/Interface/AddOns/`,
  [path.join(liveDir, "Logs")]: `${retailDir}/Logs`,
  [path.join(liveDir, "WoWChatLog.txt")]: `${retailDir}/Logs/WoWChatLog.txt`,
  [path.join(liveDir, "WTF-Account")]: `${retailDir}/WTF/Account/${config.wowAccount}/`,
  [path.join(refDir, "wow-ui-source")]: `../../_reference/wow-ui-source/`,
};

for (const [link, target] of Object.entries(links)) {
  try {
    createSymlink(link, target);
  } catch (err) {
    console.error(`  Failed: ${link}: ${(err as Error).message}`);
  }
}
