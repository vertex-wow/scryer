/**
 * WoW asset extraction — self-contained, no vscode dependency.
 *
 * Implements WoW asset extraction as importable TypeScript (dev/extract.ts is a thin CLI shim over this):
 *   - Retail: delegates to rustydemon-cli (CASC extraction binary)
 *   - Classic/Classic Era: copies loose files directly from the WoW install
 *
 * Used by:
 *   - extractor.ts (extension host vscode wrapper)
 *   - dev/extract.ts (CLI shim for manual runs)
 */

import * as cp from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as path from "path";

export type Flavor = "retail" | "classic" | "classic_era";
export type ExtractType = "textures" | "interface" | "all";

export interface ExtractCoreOptions {
  flavor: Flavor;
  /** Root output directory (Interface/ files land directly here). */
  outDir: string;
  /** WoW root directory containing _retail_/, _classic_/, .build.info. */
  wowDir: string;
  /** Explicit path to rustydemon-cli binary. Auto-detected from PATH if absent. */
  cascToolPath?: string;
  /** Directory where listfile.csv is cached (and downloaded if absent). */
  listfileDir: string;
  /** Log callback for progress lines. Defaults to console.log. */
  log?: (line: string) => void;
}

// ---------------------------------------------------------------------------
// Retail path sets
// ---------------------------------------------------------------------------

const TEXTURE_GLOBS = [
  "Interface/Buttons/**",
  "Interface/Common/**",
  "Interface/DialogFrame/**",
  "Interface/FrameGeneral/**",
  "Interface/Icons/**",
  "Interface/Tooltips/**",
];

const INTERFACE_GLOBS = [
  "Interface/AddOns/Blizzard_SharedXML/**",
  "Interface/AddOns/Blizzard_FrameXML/**",
];

// ---------------------------------------------------------------------------
// Classic extension sets
// ---------------------------------------------------------------------------

const LOOSE_TEXTURE_EXTS = new Set([".blp", ".png", ".tga"]);
const LOOSE_INTERFACE_EXTS = new Set([".lua", ".xml", ".toc"]);

// ---------------------------------------------------------------------------
// Listfile download
// ---------------------------------------------------------------------------

const LISTFILE_URL =
  "https://github.com/wowdev/wow-listfile/releases/latest/download/community-listfile.csv";

/** Stream a URL (following redirects) to a local file. */
function streamToFile(url: string, outPath: string, log?: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https://") ? https : http;
    proto
      .get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return streamToFile(res.headers.location!, outPath, log).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          res.resume();
          return;
        }
        const file = fs.createWriteStream(outPath);
        res.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve();
        });
        file.on("error", (err) => {
          fs.unlink(outPath, () => {});
          reject(err);
        });
        res.on("error", (err) => {
          fs.unlink(outPath, () => {});
          reject(err);
        });
      })
      .on("error", reject);
  });
}

/**
 * Ensure the community listfile is present in listfileDir, downloading it if needed.
 * Returns the absolute path to listfile.csv.
 */
export async function ensureListfile(
  listfileDir: string,
  log?: (line: string) => void,
): Promise<string> {
  const listfilePath = path.join(listfileDir, "listfile.csv");
  if (fs.existsSync(listfilePath)) return listfilePath;
  await fs.promises.mkdir(listfileDir, { recursive: true });
  log?.(`Downloading community listfile to ${listfilePath}...`);
  await streamToFile(LISTFILE_URL, listfilePath, log);
  return listfilePath;
}

/** Spawn grep -F to extract interface/ rows from the full listfile into filteredPath. */
function filterListfile(
  fullPath: string,
  filteredPath: string,
  log?: (line: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    log?.(`Filtering listfile to interface/ entries...`);
    const proc = cp.spawn("grep", ["-F", ";interface/", fullPath]);
    const ws = fs.createWriteStream(filteredPath);
    proc.stdout.pipe(ws);
    proc.stderr.resume();
    proc.on("error", reject);
    ws.on("error", reject);
    ws.on("finish", resolve);
    proc.on("close", (code) => {
      if ((code ?? 0) > 1) reject(new Error(`grep exited with code ${code}`));
    });
  });
}

/**
 * Ensure a pre-filtered listfile containing only interface/ entries is present.
 * Regenerated whenever listfile.csv is newer than the filtered copy.
 * Returns the absolute path to listfile-interface.csv.
 */
export async function ensureFilteredListfile(
  listfileDir: string,
  log?: (line: string) => void,
): Promise<string> {
  const fullPath = await ensureListfile(listfileDir, log);
  const filteredPath = path.join(listfileDir, "listfile-interface.csv");

  const filteredStat = fs.existsSync(filteredPath) ? fs.statSync(filteredPath) : null;
  if (filteredStat) {
    const fullStat = fs.statSync(fullPath);
    if (filteredStat.mtimeMs >= fullStat.mtimeMs) return filteredPath;
  }

  await filterListfile(fullPath, filteredPath, log);
  return filteredPath;
}

// ---------------------------------------------------------------------------
// CASC tool detection
// ---------------------------------------------------------------------------

function findCascTool(explicit?: string): string {
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`CASC tool not found: ${explicit}`);
    return explicit;
  }
  const isWin = process.platform === "win32";
  const lookup = cp.spawnSync(isWin ? "where" : "which", ["rustydemon-cli"], {
    stdio: "pipe",
    shell: isWin,
  });
  if (lookup.status === 0 && lookup.stdout) {
    const found = lookup.stdout.toString().trim().split(/\r?\n/)[0].trim();
    if (found) return found;
  }
  throw new Error(
    "No CASC extraction tool found on PATH.\n" +
      "Either install rustydemon-cli:\n" +
      "  cargo install --git https://github.com/HoldMyBeer-gg/rustydemon rustydemon-cli\n" +
      "Or set scryer.cascToolPath to the path of an existing rustydemon-cli binary.",
  );
}

// ---------------------------------------------------------------------------
// rustydemon-cli subprocess
// ---------------------------------------------------------------------------

function spawnRustydemon(
  cascTool: string,
  args: string[],
  log?: (line: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = cp.spawn(cascTool, args, { stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";

    function onData(d: Buffer): void {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) log?.(`    ${line}`);
    }

    function flush(): void {
      if (buf) {
        log?.(`    ${buf}`);
        buf = "";
      }
    }

    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("error", reject);
    proc.on("close", (code) => {
      flush();
      if (code === 0) resolve();
      else reject(new Error(`rustydemon-cli exited with code ${code}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Retail extraction
// ---------------------------------------------------------------------------

async function extractRetailPaths(paths: string[], opts: ExtractCoreOptions): Promise<void> {
  const cascTool = findCascTool(opts.cascToolPath);
  const listfilePath = await ensureFilteredListfile(opts.listfileDir, opts.log);
  await fs.promises.mkdir(opts.outDir, { recursive: true });

  opts.log?.(`Targeted retail extraction via rustydemon-cli...`);
  opts.log?.(`  Source: ${opts.wowDir}`);
  opts.log?.(`  Output: ${opts.outDir}`);

  for (const p of paths) {
    opts.log?.(`  Extracting ${p}...`);
    await spawnRustydemon(
      cascTool,
      ["export", "-a", opts.wowDir, "-p", p, "-l", listfilePath, "-o", opts.outDir],
      opts.log,
    );
  }
}

async function extractRetailBulk(type: ExtractType, opts: ExtractCoreOptions): Promise<void> {
  const cascTool = findCascTool(opts.cascToolPath);
  const listfilePath = await ensureFilteredListfile(opts.listfileDir, opts.log);
  await fs.promises.mkdir(opts.outDir, { recursive: true });

  const globs = [
    ...(type === "textures" || type === "all" ? TEXTURE_GLOBS : []),
    ...(type === "interface" || type === "all" ? INTERFACE_GLOBS : []),
  ];

  opts.log?.(`Extracting retail Interface (${type}) via rustydemon-cli...`);
  opts.log?.(`  Source: ${opts.wowDir}`);
  opts.log?.(`  Output: ${opts.outDir}`);

  for (const glob of globs) {
    opts.log?.(`  Extracting ${glob}...`);
    await spawnRustydemon(
      cascTool,
      ["export", "-a", opts.wowDir, "-p", glob, "-l", listfilePath, "-o", opts.outDir],
      opts.log,
    );
  }
}

// ---------------------------------------------------------------------------
// Classic loose-file extraction
// ---------------------------------------------------------------------------

const FLAVOR_SUBDIR: Record<Flavor, string> = {
  retail: "_retail_",
  classic: "_classic_",
  classic_era: "_classic_era_",
};

function resolveClassicInterfaceDir(wowDir: string, flavor: Flavor): string {
  const subdir = FLAVOR_SUBDIR[flavor];
  const interfaceDir = path.join(wowDir, subdir, "Interface");
  if (!fs.existsSync(interfaceDir)) {
    throw new Error(
      `Interface directory not found: ${interfaceDir}\n` +
        `Check that wowDir points to the WoW root folder (the one containing _classic_/ and _retail_/).`,
    );
  }
  return interfaceDir;
}

/** Case-insensitive recursive file lookup. */
function findCaseInsensitive(dir: string, relParts: string[]): string | null {
  if (relParts.length === 0) {
    try {
      return !fs.statSync(dir).isDirectory() ? dir : null;
    } catch {
      return null;
    }
  }
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const [head, ...rest] = relParts;
  const match = entries.find((e) => e.toLowerCase() === head.toLowerCase());
  if (!match) return null;
  return findCaseInsensitive(path.join(dir, match), rest);
}

async function extractLoosePaths(paths: string[], opts: ExtractCoreOptions): Promise<void> {
  const interfaceDir = resolveClassicInterfaceDir(opts.wowDir, opts.flavor);
  await fs.promises.mkdir(opts.outDir, { recursive: true });

  opts.log?.(`Targeted Classic extraction...`);
  opts.log?.(`  Source: ${interfaceDir}`);
  opts.log?.(`  Output: ${opts.outDir}`);

  let count = 0;
  for (const p of paths) {
    // Strip leading Interface/ prefix — interfaceDir is already the Interface/ dir.
    const rel = p.replace(/^[Ii]nterface[/\\]/i, "");
    const found = findCaseInsensitive(interfaceDir, rel.split(/[/\\]/));
    if (!found) {
      opts.log?.(`  Not found: ${p} (skipping)`);
      continue;
    }
    const dest = path.join(opts.outDir, rel);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.copyFile(found, dest);
    opts.log?.(`  Copied ${p}`);
    count++;
  }
  opts.log?.(`\nCopied ${count} file(s).`);
}

async function copyFilesRecursive(
  srcDir: string,
  destDir: string,
  exts: Set<string>,
): Promise<number> {
  let count = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(srcDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      await fs.promises.mkdir(dest, { recursive: true });
      count += await copyFilesRecursive(src, dest, exts);
    } else if (exts.has(path.extname(entry.name).toLowerCase())) {
      await fs.promises.copyFile(src, dest);
      count++;
    }
  }
  return count;
}

async function extractLooseBulk(type: ExtractType, opts: ExtractCoreOptions): Promise<void> {
  const interfaceDir = resolveClassicInterfaceDir(opts.wowDir, opts.flavor);
  await fs.promises.mkdir(opts.outDir, { recursive: true });

  const exts = new Set<string>();
  if (type === "textures" || type === "all") LOOSE_TEXTURE_EXTS.forEach((e) => exts.add(e));
  if (type === "interface" || type === "all") LOOSE_INTERFACE_EXTS.forEach((e) => exts.add(e));

  opts.log?.(`Copying Classic Interface (${type})...`);
  opts.log?.(`  Source: ${interfaceDir}`);
  opts.log?.(`  Output: ${opts.outDir}`);

  const count = await copyFilesRecursive(interfaceDir, opts.outDir, exts);
  opts.log?.(`\nCopied ${count} file(s).`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract specific WoW-relative paths (e.g. "Interface/Buttons/UI-Minimap-Arrow.blp").
 * Retail uses rustydemon-cli; Classic copies loose files from the install directory.
 */
export async function extractPaths(paths: string[], opts: ExtractCoreOptions): Promise<void> {
  if (paths.length === 0) return;
  if (opts.flavor === "retail") {
    await extractRetailPaths(paths, opts);
  } else {
    await extractLoosePaths(paths, opts);
  }
}

/**
 * Extract a whole category of files (textures, interface addon files, or both).
 * Retail uses rustydemon-cli with glob patterns; Classic recursively copies by extension.
 */
export async function extractBulk(type: ExtractType, opts: ExtractCoreOptions): Promise<void> {
  if (opts.flavor === "retail") {
    await extractRetailBulk(type, opts);
  } else {
    await extractLooseBulk(type, opts);
  }
}
