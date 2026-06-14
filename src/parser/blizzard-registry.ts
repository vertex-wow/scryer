import * as fs from "fs";
import * as path from "path";
import type { FrameIR, TextureIR } from "./ir.js";
import { parseToc } from "./toc.js";
import { parseXmlFile } from "./xml.js";

export interface BlizzardRegistry {
  frames: Map<string, FrameIR>;
  textures: Map<string, TextureIR>;
}

// Addons to scan, in dependency order (base templates first).
export const ADDON_NAMES = ["Blizzard_SharedXMLBase", "Blizzard_SharedXML", "Blizzard_FrameXML"];
export const SHARED_ADDON_NAMES = ["Blizzard_SharedXMLBase", "Blizzard_SharedXML"];

// TOC filename suffixes to probe, in preference order.
const TOC_SUFFIXES = ["_Mainline.toc", ".toc"];

/**
 * Resolve a relative path against a base directory with case-insensitive component
 * matching. Extraction tools (e.g. rustydemon-cli on Linux) lower-case all output
 * paths even though WoW XML and TOC files reference them in their original mixed case.
 * Each component is matched to an actual directory entry when possible; unmatched
 * components are kept as-is so missing-file detection still works correctly.
 */
export function resolveCI(base: string, relPath: string): string {
  const parts = relPath.replace(/\\/g, "/").split("/").filter(Boolean);
  let current = base;
  for (const part of parts) {
    const exact = path.join(current, part);
    try {
      fs.accessSync(exact);
      current = exact;
      continue;
    } catch {
      /* fall through to case-insensitive scan */
    }
    const lpart = part.toLowerCase();
    let matched = false;
    try {
      for (const entry of fs.readdirSync(current)) {
        if (entry.toLowerCase() === lpart) {
          current = path.join(current, entry);
          matched = true;
          break;
        }
      }
    } catch {
      /* directory unreadable — keep exact path */
    }
    if (!matched) current = exact;
  }
  return current;
}

function findTocPath(addonDir: string, addonName: string): string | null {
  for (const suffix of TOC_SUFFIXES) {
    const p = resolveCI(addonDir, `${addonName}${suffix}`);
    try {
      fs.accessSync(p, fs.constants.R_OK);
      return p;
    } catch {
      // try next suffix
    }
  }
  return null;
}

function readMtime(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

/** Extract only XML file paths from a TOC, resolved to absolute paths. */
function tocXmlFiles(tocPath: string): string[] {
  const addonDir = path.dirname(tocPath);
  let content: string;
  try {
    content = fs.readFileSync(tocPath, "utf-8");
  } catch {
    return [];
  }
  const toc = parseToc(content);
  return toc.files.filter((f) => f.type === "xml").map((f) => resolveCI(addonDir, f.path));
}

/**
 * Return all Lua file paths for a Blizzard addon in TOC-defined order.
 * Only paths that exist on disk are included. Returns empty array if the addon
 * is not extracted or has no TOC.
 */
export function blizzardAddonLuaFiles(
  addonsDir: string,
  addonName: string,
  onMissing?: (relPath: string) => void,
  tocFamily?: string,
): string[] {
  const tocPath = findTocPath(resolveCI(addonsDir, addonName), addonName);
  if (!tocPath) return [];
  const addonDir = path.dirname(tocPath);
  let content: string;
  try {
    content = fs.readFileSync(tocPath, "utf-8");
  } catch {
    return [];
  }
  const toc = parseToc(content);
  const result: string[] = [];
  for (const f of toc.files.filter((f) => f.type === "lua")) {
    const resolved = tocFamily ? f.path.replace(/\[Family\]/gi, tocFamily) : f.path;
    const p = resolveCI(addonDir, resolved);
    try {
      fs.accessSync(p, fs.constants.R_OK);
      result.push(p);
    } catch {
      onMissing?.(f.path);
    }
  }
  return result;
}

/**
 * Parse one XML file into the registry and follow its <Include> chain.
 * Silently skips files that are missing or fail to parse (flavor-specific files
 * absent on this machine, or non-standard XML).
 */
function loadXmlIntoRegistry(
  xmlPath: string,
  registry: Map<string, FrameIR>,
  textureRegistry: Map<string, TextureIR>,
  visited: Set<string>,
  incomplete: { value: boolean },
): void {
  const abs = path.resolve(xmlPath);
  if (visited.has(abs)) return;
  visited.add(abs);

  let content: string;
  try {
    content = fs.readFileSync(abs, "utf-8");
  } catch {
    incomplete.value = true;
    return;
  }

  let doc;
  try {
    doc = parseXmlFile(abs, content);
  } catch {
    return;
  }

  for (const [name, frame] of doc.templates) {
    registry.set(name, frame);
  }
  for (const [name, tex] of doc.textureTemplates) {
    textureRegistry.set(name, tex);
  }

  const baseDir = path.dirname(abs);
  for (const inc of doc.includes) {
    loadXmlIntoRegistry(resolveCI(baseDir, inc), registry, textureRegistry, visited, incomplete);
  }
}

// ---------------------------------------------------------------------------
// Disk cache
// ---------------------------------------------------------------------------

const CACHE_FILE_ALL = "blizzard-registry.json";

/** Stable cache filename for a given addon subset. Full set keeps the original name. */
function cacheFileName(addonNames: string[]): string {
  if (addonNames.length === ADDON_NAMES.length) return CACHE_FILE_ALL;
  const suffix = addonNames.map((n) => n.replace(/^Blizzard_/, "").toLowerCase()).join("-");
  return `blizzard-registry-${suffix}.json`;
}

// Bump when the parser or IR shape changes in a way that makes old caches incorrect.
const SCHEMA_VERSION = 3;

interface RegistryCache {
  /** TOC absolute paths → mtime stamps used to detect stale cache. */
  stamp: Record<string, number>;
  entries: [string, FrameIR][];
  textureEntries: [string, TextureIR][];
  schemaVersion?: number;
}

function readRegistryCache(registryDir: string, file: string): RegistryCache | null {
  try {
    const raw = fs.readFileSync(path.join(registryDir, file), "utf-8");
    return JSON.parse(raw) as RegistryCache;
  } catch {
    return null;
  }
}

function writeRegistryCache(registryDir: string, file: string, data: RegistryCache): void {
  try {
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(path.join(registryDir, file), JSON.stringify(data));
  } catch {
    // Cache write failure is non-fatal; we'll just re-parse next time.
  }
}

export function clearRegistryCache(registryDir: string): void {
  try {
    for (const entry of fs.readdirSync(registryDir)) {
      if (entry.startsWith("blizzard-registry") && entry.endsWith(".json")) {
        try {
          fs.unlinkSync(path.join(registryDir, entry));
        } catch {
          // Individual delete failure is non-fatal.
        }
      }
    }
  } catch {
    // Cache dir missing or unreadable — nothing to clear.
  }
}

// ---------------------------------------------------------------------------
// Dependency discovery
// ---------------------------------------------------------------------------

function fileReadable(absPath: string): boolean {
  try {
    fs.accessSync(absPath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Walk the TOC → XML → <Include> dependency graph starting from the two Blizzard
 * addon roots. Returns WoW-relative paths (e.g. `Interface/AddOns/Blizzard_SharedXML/…`)
 * for every file that is needed but not yet present under `extractedAssetsDir`.
 *
 * Designed to be called repeatedly: each call reads only what is already on disk,
 * so after extracting the returned paths the caller can invoke again to discover
 * any new includes that were only reachable once their parent files arrived.
 *
 * @param extractedAssetsDir  Root of the local extraction (parent of `Interface/`).
 * @param addonsDir           Absolute path to `extractedAssetsDir/Interface/AddOns/`.
 */
export function discoverBlizzardPaths(
  extractedAssetsDir: string,
  addonsDir: string,
  addonNames: string[] = ADDON_NAMES,
): string[] {
  if (!extractedAssetsDir || !addonsDir) return [];

  const missing: string[] = [];
  const visited = new Set<string>(); // abs paths already handled this call

  function toWowPath(abs: string): string {
    return path.relative(extractedAssetsDir, abs).replace(/\\/g, "/");
  }

  function probe(absPath: string): void {
    const abs = path.resolve(absPath);
    if (visited.has(abs)) return;
    visited.add(abs);

    if (!fileReadable(abs)) {
      missing.push(toWowPath(abs));
      return;
    }

    const ext = path.extname(abs).toLowerCase();

    if (ext === ".toc") {
      let content: string;
      try {
        content = fs.readFileSync(abs, "utf-8");
      } catch {
        return;
      }
      const toc = parseToc(content);
      const addonDir = path.dirname(abs);
      for (const f of toc.files) {
        if (f.type === "xml") {
          probe(resolveCI(addonDir, f.path));
        }
      }
    }

    if (ext === ".xml") {
      let content: string;
      try {
        content = fs.readFileSync(abs, "utf-8");
      } catch {
        return;
      }
      let doc;
      try {
        doc = parseXmlFile(abs, content);
      } catch {
        return;
      }
      const xmlDir = path.dirname(abs);
      for (const inc of doc.includes) {
        probe(resolveCI(xmlDir, inc));
      }
    }
  }

  for (const addonName of addonNames) {
    const addonDir = resolveCI(addonsDir, addonName);
    // Use the first suffix that exists on disk; if none exist, request the preferred one.
    const existing = TOC_SUFFIXES.map((s) => resolveCI(addonDir, `${addonName}${s}`)).find(
      fileReadable,
    );
    probe(existing ?? resolveCI(addonDir, `${addonName}${TOC_SUFFIXES[0]}`));
  }

  return missing;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load the Blizzard virtual template registry from an extracted addons directory.
 *
 * Scans Blizzard_SharedXML and Blizzard_FrameXML via their TOC files, following
 * <Include> chains to collect all virtual frame definitions. Result is cached to
 * `registryDir/blizzard-registry.json` and invalidated when TOC file mtimes change.
 *
 * @param addonsDir    Absolute path to the extracted `Interface/AddOns/` directory.
 * @param registryDir  Absolute path to `<cacheRoot>/derived/registry/`.
 */
export function loadBlizzardRegistry(
  addonsDir: string,
  registryDir: string,
  addonNames: string[] = ADDON_NAMES,
): BlizzardRegistry {
  const empty: BlizzardRegistry = { frames: new Map(), textures: new Map() };
  if (!addonsDir) return empty;

  const cacheFile = cacheFileName(addonNames);

  // Locate TOC files and compute the current mtime stamp.
  const tocPaths = new Map<string, string>(); // addonName → absolute TOC path
  const stamp: Record<string, number> = {};

  for (const addonName of addonNames) {
    const addonDir = resolveCI(addonsDir, addonName);
    const tocPath = findTocPath(addonDir, addonName);
    if (tocPath) {
      tocPaths.set(addonName, tocPath);
      stamp[tocPath] = readMtime(tocPath);
    }
  }

  if (tocPaths.size === 0) return empty;

  // Check disk cache — valid if stamp and schema version both match.
  const cached = readRegistryCache(registryDir, cacheFile);
  if (cached && (cached.schemaVersion ?? 1) === SCHEMA_VERSION) {
    const keys = Object.keys(stamp);
    const ckeys = Object.keys(cached.stamp);
    if (keys.length === ckeys.length && keys.every((k) => cached.stamp[k] === stamp[k])) {
      return {
        frames: new Map(cached.entries),
        textures: new Map(cached.textureEntries ?? []),
      };
    }
  }

  // Cache miss (or stale) — parse from disk.
  console.log(`[scryer] Parsing Blizzard template corpus from ${addonsDir}…`);
  const frames = new Map<string, FrameIR>();
  const textures = new Map<string, TextureIR>();
  const visited = new Set<string>();
  const incomplete = { value: false };

  for (const addonName of addonNames) {
    const tocPath = tocPaths.get(addonName);
    if (!tocPath) continue;
    for (const xmlFile of tocXmlFiles(tocPath)) {
      loadXmlIntoRegistry(xmlFile, frames, textures, visited, incomplete);
    }
  }

  console.log(
    `[scryer] Blizzard registry: ${frames.size} frame templates, ${textures.size} texture templates loaded.`,
  );
  // Don't cache partial results — if any XML files were missing, skip the write so
  // the next load re-parses once the extraction has delivered more files.
  if (!incomplete.value) {
    writeRegistryCache(registryDir, cacheFile, {
      stamp,
      entries: Array.from(frames.entries()),
      textureEntries: Array.from(textures.entries()),
      schemaVersion: SCHEMA_VERSION,
    });
  }
  return { frames, textures };
}
