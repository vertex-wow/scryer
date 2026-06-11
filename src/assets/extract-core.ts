/**
 * WoW asset extraction — self-contained, no vscode dependency.
 *
 * Implements WoW asset extraction as importable TypeScript (dev/extract.ts is a thin CLI shim over this):
 *   - Retail: delegates to scryer-asset-server (long-lived CASC extraction server)
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
import { AssetClient, type LogLevel, type Priority } from "./asset-client.js";

export type Flavor = "retail" | "classic" | "classic_era";
export type ExtractType = "textures" | "interface" | "all";

export interface ExtractionResult {
  exported: number;
  /** Files in the CASC index the server could not extract locally: CDN-only stubs or encrypted. NOT "already cached". */
  unavailable: number;
  errors: number;
}

export interface ExtractCoreOptions {
  flavor: Flavor;
  /** Root output directory (Interface/ files land directly here). */
  outDir: string;
  /** WoW root directory containing _retail_/, _classic_/, .build.info. */
  wowDir: string;
  /** Explicit path to scryer-asset-server binary. */
  assetServerPath: string;
  /** Idle timeout for the server in seconds. */
  assetServerIdleTimeout: number;
  /** Explicit path to the grep binary. Auto-detected from PATH if absent. */
  grepPath?: string;
  /** Directory where listfile.csv is cached (and downloaded if absent). */
  listfileDir: string;
  /** Log callback for progress lines. Defaults to console.log. */
  log?: (level: LogLevel, msg: string, serverTime?: string) => void;
  /** Path to write scryer-asset-server logs to. */
  logFile?: string;
  /** When true, tell the server to attempt CDN fallback for CDN-only stubs. */
  cdnEnabled?: boolean;
}

// ---------------------------------------------------------------------------
// Retail path sets
// ---------------------------------------------------------------------------

const TEXTURE_GLOBS = [
  "interface/buttons/**",
  "interface/common/**",
  "interface/dialogframe/**",
  "interface/framegeneral/**",
  "interface/icons/**",
  "interface/tooltips/**",
];

/**
 * Critical addon trees: must be fully extracted before the live panel's first render.
 * Includes Lua prerequisites AND FrameXML (required for NineSlicePanelTemplate and
 * other XML templates that NineSlice Lua expects to find in the registry).
 */
export const BLIZZARD_LUA_CRITICAL_GLOBS = [
  "interface/addons/blizzard_sharedxmlbase/**",
  "interface/addons/blizzard_colors/**",
  "interface/addons/blizzard_sharedxml/**",
  "interface/addons/blizzard_framexml/**",
];

/** Bulk pop-in globs: fonts only. Extracted in the background after critical addons. */
export const BLIZZARD_BULK_GLOBS = ["fonts/**"];

const INTERFACE_GLOBS = [...BLIZZARD_LUA_CRITICAL_GLOBS, ...BLIZZARD_BULK_GLOBS];

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
const LISTFILE_URL_FALLBACK =
  "https://github.com/wowdev/wow-listfile/releases/latest/download/community-listfile-withcapitalization.csv";

/** Stream a URL (following redirects) to a local file. */
function streamToFile(
  url: string,
  outPath: string,
  log?: (level: LogLevel, msg: string) => void,
): Promise<void> {
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
  log?: (level: LogLevel, msg: string) => void,
): Promise<string> {
  const listfilePath = path.join(listfileDir, "listfile.csv");
  if (fs.existsSync(listfilePath)) return listfilePath;
  await fs.promises.mkdir(listfileDir, { recursive: true });
  log?.("info", `Downloading community listfile to ${listfilePath}...`);
  try {
    await streamToFile(LISTFILE_URL, listfilePath, log);
  } catch (err) {
    if ((err as Error).message?.includes("HTTP 404")) {
      log?.("debug", `  (plain listfile not available, falling back to withcapitalization)`);
      await streamToFile(LISTFILE_URL_FALLBACK, listfilePath, log);
    } else {
      throw err;
    }
  }
  return listfilePath;
}

/** Spawn grep to extract Interface/ and Fonts/ rows from the full listfile. */
function filterListfileGrep(
  fullPath: string,
  filteredPath: string,
  grepCmd: string,
  log?: (level: LogLevel, msg: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    log?.("info", `Filtering listfile to Interface/ and Fonts/ entries...`);
    const proc = cp.spawn(grepCmd, ["-F", "-i", "-e", ";Interface/", "-e", ";Fonts/", fullPath]);
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
 * 1BRC-style stream + byte scan fallback for platforms without grep.
 * Uses raw Buffer chunks and Buffer.indexOf() to avoid string allocation overhead.
 */
function filterListfileNode(
  fullPath: string,
  filteredPath: string,
  log?: (level: LogLevel, msg: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    log?.("info", `Filtering listfile to Interface/ and Fonts/ entries (Node fallback)...`);
    const NEWLINE = 0x0a;
    const SEMI = 0x3b;
    const rs = fs.createReadStream(fullPath, { highWaterMark: 256 * 1024 });
    const ws = fs.createWriteStream(filteredPath);
    let carry: Buffer | null = null;

    function matches(buf: Buffer, semiPos: number, end: number): boolean {
      const len = end - semiPos;
      if (len < 7) return false; // ";fonts/" is 7 chars — minimum match
      const sliceLen = Math.min(11, len); // ";interface/" is 11 chars — maximum to check
      const lc = buf
        .subarray(semiPos, semiPos + sliceLen)
        .toString("ascii")
        .toLowerCase();
      return lc.startsWith(";interface/") || lc.startsWith(";fonts/");
    }

    rs.on("data", (chunk: Buffer) => {
      const buf = carry ? Buffer.concat([carry, chunk]) : chunk;
      carry = null;
      let lineStart = 0;
      while (true) {
        const nlPos = buf.indexOf(NEWLINE, lineStart);
        if (nlPos === -1) {
          if (lineStart < buf.length) carry = buf.subarray(lineStart);
          break;
        }
        const semiPos = buf.indexOf(SEMI, lineStart);
        if (semiPos !== -1 && semiPos < nlPos && matches(buf, semiPos, nlPos)) {
          ws.write(buf.subarray(lineStart, nlPos + 1));
        }
        lineStart = nlPos + 1;
      }
    });

    rs.on("end", () => {
      if (carry && carry.length > 0) {
        const semiPos = carry.indexOf(SEMI);
        if (semiPos !== -1 && matches(carry, semiPos, carry.length)) {
          ws.write(carry);
          ws.write(Buffer.from("\n"));
        }
      }
      ws.end();
    });

    rs.on("error", reject);
    ws.on("finish", resolve);
    ws.on("error", reject);
  });
}

/**
 * Filter the listfile to Interface/ and Fonts/ entries.
 * Priority: explicit grepCmd → system grep → Node stream fallback.
 * The Node fallback is used automatically when grep is not on PATH (e.g. Windows without grep installed).
 */
function filterListfile(
  fullPath: string,
  filteredPath: string,
  grepCmd: string | undefined,
  log?: (level: LogLevel, msg: string) => void,
): Promise<void> {
  if (grepCmd) {
    return filterListfileGrep(fullPath, filteredPath, grepCmd, log);
  }
  return filterListfileGrep(fullPath, filteredPath, "grep", log).catch(
    (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        log?.("info", "grep not found on PATH, using Node stream fallback");
        return filterListfileNode(fullPath, filteredPath, log);
      }
      throw err;
    },
  );
}

/**
 * Ensure a pre-filtered listfile containing only Interface/ and Fonts/ entries is present.
 *
 * When buildText is provided: skip filtering if listfile-templates.stamp matches — one filter
 * per WoW patch cycle regardless of how many times listfile.csv is re-downloaded. Writes the
 * stamp after a successful filter run.
 *
 * When buildText is absent (installDir not configured): fall back to mtime comparison so users
 * without a WoW install still get correct behaviour.
 *
 * Returns the absolute path to listfile-templates.csv.
 */
export async function ensureFilteredListfile(
  listfileDir: string,
  log?: (level: LogLevel, msg: string) => void,
  buildText?: string,
  grepPath?: string,
): Promise<string> {
  const fullPath = await ensureListfile(listfileDir, log);
  const filteredPath = path.join(listfileDir, "listfile-templates.csv");
  const stampPath = path.join(listfileDir, "listfile-templates.stamp");

  const filteredExists = fs.existsSync(filteredPath);
  const filteredEmpty = filteredExists && fs.statSync(filteredPath).size === 0;

  if (!filteredEmpty) {
    if (buildText) {
      if (filteredExists) {
        let stamp: string | null = null;
        try {
          stamp = fs.readFileSync(stampPath, "utf8").trim();
        } catch {
          // stamp absent — filter needed
        }
        if (stamp === buildText) return filteredPath;
      }
    } else {
      const filteredStat = filteredExists ? fs.statSync(filteredPath) : null;
      if (filteredStat) {
        const fullStat = fs.statSync(fullPath);
        if (filteredStat.mtimeMs >= fullStat.mtimeMs) return filteredPath;
      }
    }
  }

  await filterListfile(fullPath, filteredPath, grepPath, log);
  if (buildText) fs.writeFileSync(stampPath, buildText, "utf8");
  return filteredPath;
}

// ---------------------------------------------------------------------------
// AssetClient instance management
// ---------------------------------------------------------------------------

let sharedAssetClient: AssetClient | null = null;

function getAssetClient(opts: ExtractCoreOptions): AssetClient {
  if (!sharedAssetClient) {
    sharedAssetClient = new AssetClient({
      binaryPath: opts.assetServerPath,
      wowDir: opts.wowDir,
      outDir: opts.outDir,
      idleTimeout: opts.assetServerIdleTimeout,
      log: opts.log,
      logFile: opts.logFile,
    });
  }
  return sharedAssetClient;
}

/**
 * Increment the shared asset client's keepalive ref-count.
 * Creates the client instance if needed (does NOT start the server process).
 */
export function acquireClientKeepalive(opts: ExtractCoreOptions): void {
  getAssetClient(opts).acquireKeepalive();
}

/**
 * Decrement the shared asset client's keepalive ref-count.
 * Safe to call when no client exists yet (no-op).
 */
export function releaseClientKeepalive(): void {
  sharedAssetClient?.releaseKeepalive();
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Retail extraction
// ---------------------------------------------------------------------------

async function normalizeSubtreeToLowercase(dir: string): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const oldPath = path.join(dir, entry.name);
    let currentPath = oldPath;
    const newName = entry.name.toLowerCase();
    if (entry.name !== newName) {
      const newPath = path.join(dir, newName);
      await fs.promises.rename(oldPath, newPath);
      currentPath = newPath;
    }
    if (entry.isDirectory()) {
      await normalizeSubtreeToLowercase(currentPath);
    }
  }
}

async function extractRetailPaths(
  paths: string[],
  opts: ExtractCoreOptions,
  priority: Priority = "prewarm",
): Promise<ExtractionResult> {
  const client = getAssetClient(opts);
  const res = await client.extractFiles(paths, opts.cdnEnabled ?? false, priority);
  await normalizeSubtreeToLowercase(opts.outDir);
  return { exported: res.extracted, unavailable: res.unavailable, errors: res.errors };
}

async function extractRetailBulk(
  type: ExtractType,
  opts: ExtractCoreOptions,
): Promise<ExtractionResult> {
  const globs = [
    ...(type === "textures" || type === "all" ? TEXTURE_GLOBS : []),
    ...(type === "interface" || type === "all" ? INTERFACE_GLOBS : []),
  ];

  const shortOut = `${path.basename(path.dirname(opts.outDir))}/${path.basename(opts.outDir)}`;
  opts.log?.("info", `assets-extraction: "${opts.flavor}/${type}" → global cache "${shortOut}"`);

  const client = getAssetClient(opts);
  const res = await client.extractFiles(globs, opts.cdnEnabled ?? false);
  await normalizeSubtreeToLowercase(opts.outDir);
  return { exported: res.extracted, unavailable: res.unavailable, errors: res.errors };
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

async function extractLoosePaths(
  paths: string[],
  opts: ExtractCoreOptions,
): Promise<ExtractionResult> {
  const interfaceDir = resolveClassicInterfaceDir(opts.wowDir, opts.flavor);
  await fs.promises.mkdir(opts.outDir, { recursive: true });

  const shortOut = `${path.basename(path.dirname(opts.outDir))}/${path.basename(opts.outDir)}`;
  opts.log?.("info", `assets-extraction: "${opts.flavor}/assets" → global cache "${shortOut}"`);

  let exported = 0;
  let errors = 0;
  for (const p of paths) {
    // Strip leading Interface/ prefix — interfaceDir is already the Interface/ dir.
    const rel = p.replace(/^[Ii]nterface[/\\]/i, "");
    const found = findCaseInsensitive(interfaceDir, rel.split(/[/\\]/));
    if (!found) {
      opts.log?.("debug", `  Not found: ${p} (skipping)`);
      errors++;
      continue;
    }
    const dest = path.join(opts.outDir, rel);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.copyFile(found, dest);
    opts.log?.("debug", `  Copied ${p}`);
    exported++;
  }
  await normalizeSubtreeToLowercase(opts.outDir);
  return { exported, unavailable: 0, errors };
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

async function extractLooseBulk(
  type: ExtractType,
  opts: ExtractCoreOptions,
): Promise<ExtractionResult> {
  const interfaceDir = resolveClassicInterfaceDir(opts.wowDir, opts.flavor);
  await fs.promises.mkdir(opts.outDir, { recursive: true });

  const exts = new Set<string>();
  if (type === "textures" || type === "all") LOOSE_TEXTURE_EXTS.forEach((e) => exts.add(e));
  if (type === "interface" || type === "all") LOOSE_INTERFACE_EXTS.forEach((e) => exts.add(e));

  const shortOut = `${path.basename(path.dirname(opts.outDir))}/${path.basename(opts.outDir)}`;
  opts.log?.("info", `assets-extraction: "${opts.flavor}/${type}" → global cache "${shortOut}"`);

  const exported = await copyFilesRecursive(interfaceDir, opts.outDir, exts);
  await normalizeSubtreeToLowercase(opts.outDir);
  return { exported, unavailable: 0, errors: 0 };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch raw bytes for a single WoW-relative path from the CASC server without writing
 * to disk. Retail-only — returns null for Classic/ClassicEra flavors or when the server
 * is unavailable or the file is not found in CASC.
 */
export async function readAssetBytes(
  path: string,
  opts: ExtractCoreOptions,
): Promise<Buffer | null> {
  if (opts.flavor !== "retail") return null;
  const client = getAssetClient(opts);
  try {
    return await client.readFileBytes(path, opts.cdnEnabled ?? false);
  } catch {
    return null;
  }
}

/**
 * Extract specific WoW-relative paths (e.g. "Interface/Buttons/UI-Minimap-Arrow.blp").
 * Retail uses scryer-asset-server; Classic copies loose files from the install directory.
 */
export async function extractPaths(
  paths: string[],
  opts: ExtractCoreOptions,
  priority: Priority = "prewarm",
): Promise<ExtractionResult> {
  if (paths.length === 0) return { exported: 0, unavailable: 0, errors: 0 };
  if (opts.flavor === "retail") {
    return extractRetailPaths(paths, opts, priority);
  } else {
    return extractLoosePaths(paths, opts);
  }
}

/**
 * Extract a whole category of files (textures, interface addon files, or both).
 * Retail uses scryer-asset-server with glob patterns; Classic recursively copies by extension.
 */
export async function extractBulk(
  type: ExtractType,
  opts: ExtractCoreOptions,
): Promise<ExtractionResult> {
  if (opts.flavor === "retail") {
    return extractRetailBulk(type, opts);
  } else {
    return extractLooseBulk(type, opts);
  }
}
