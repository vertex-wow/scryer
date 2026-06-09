import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const PROJECT_ROOT = path.join(__dirname, "..");

interface DevConfig {
  "scryer.cacheLocation"?: "global" | "workspace" | "custom";
  "scryer.cacheDir"?: string;
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

const config = loadDevConfig();
const location = config["scryer.cacheLocation"] ?? "workspace";

console.log(`Clearing cache for location: ${location}`);

if (location === "workspace") {
  const workspaceCache = path.join(PROJECT_ROOT, ".wow-cache");
  if (fs.existsSync(workspaceCache)) {
    fs.rmSync(workspaceCache, { recursive: true, force: true });
    console.log(`Cleared: ${workspaceCache}`);
  } else {
    console.log("Workspace cache not found (already clean).");
  }
} else if (location === "global") {
  const id = "vertex-wow.wow-scryer";
  const dirs = [
    path.join(os.homedir(), ".vscode-server", "data", "User", "globalStorage", id),
    path.join(os.homedir(), ".antigravity-ide-server", "data", "User", "globalStorage", id),
    path.join(os.homedir(), ".config", "Code", "User", "globalStorage", id),
    path.join(os.homedir(), "Library", "Application Support", "Code", "User", "globalStorage", id),
  ];

  const found = dirs.filter((d) => fs.existsSync(d));
  if (found.length) {
    found.forEach((d) => {
      fs.rmSync(d, { recursive: true, force: true });
      console.log(`Cleared: ${d}`);
    });
  } else {
    console.log("Global cache not found (already clean or non-standard path).");
  }
} else if (location === "custom") {
  const customCache = config["scryer.cacheDir"];
  if (customCache) {
    if (fs.existsSync(customCache)) {
      // Safety check to ensure we don't accidentally delete something important
      if (customCache === "/" || customCache === os.homedir()) {
        console.error(`Error: Refusing to delete root or home directory: ${customCache}`);
        process.exit(1);
      }
      fs.rmSync(customCache, { recursive: true, force: true });
      console.log(`Cleared: ${customCache}`);
    } else {
      console.log(`Custom cache not found at: ${customCache} (already clean).`);
    }
  } else {
    console.error(
      "Error: scryer.cacheLocation is 'custom' but scryer.cacheDir is not set in dev/settings.local.json",
    );
    process.exit(1);
  }
} else {
  console.error(`Error: Unknown cacheLocation: ${location}`);
  process.exit(1);
}
