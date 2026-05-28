import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { blpToPng } from "./blp.js";
import { cacheKey, getCachedPath, writeCached } from "./cache.js";
import { shellExtractInterface, shellExtractMissing } from "./extractor.js";
import {
  ADDON_NAMES,
  SHARED_ADDON_NAMES,
  clearRegistryCache,
  discoverBlizzardPaths,
  loadBlizzardRegistry,
} from "../parser/blizzard-registry.js";
import {
  clearFlavorCache,
  flavorSubdir,
  InstalledFlavor,
  listInstalledFlavors,
  readBuildStamp,
  readBuildText,
  writeBuildStamp,
} from "./build-info.js";
import { clearResolutionMemo, resolveTexturePath } from "./resolver.js";
import { collectTexturePaths } from "../parser/collect-textures.js";
import type { FrameIR } from "../parser/ir.js";

function parseLogLevel(s: string): vscode.LogLevel {
  const map: Record<string, vscode.LogLevel> = {
    off: vscode.LogLevel.Off,
    trace: vscode.LogLevel.Trace,
    debug: vscode.LogLevel.Debug,
    info: vscode.LogLevel.Info,
    warning: vscode.LogLevel.Warning,
    error: vscode.LogLevel.Error,
  };
  return map[s] ?? vscode.LogLevel.Warning;
}

/** Resolve the Interface/AddOns path case-insensitively (extraction tools may lowercase it). */
function resolveAddonsDir(sourceDir: string): string {
  const candidates = [
    path.join(sourceDir, "Interface", "AddOns"),
    path.join(sourceDir, "interface", "addons"),
  ];
  return (
    candidates.find((d) => {
      try {
        fs.statSync(d);
        return true;
      } catch {
        return false;
      }
    }) ?? candidates[0]
  );
}

export interface AssetServiceOptions {
  /** <cacheRoot>/<flavor>/source — parent of Interface/; raw WoW assets, expensive to regenerate. */
  sourceDir: string;
  /** <cacheRoot>/<flavor>/derived/textures — BLP→PNG conversions, always safe to delete. */
  texturesConvDir: string;
  /** <cacheRoot>/<flavor>/derived/registry — parsed Blizzard template registry JSON, always safe to delete. */
  registryDir: string;
  /** WoW root directory (contains _retail_/, _classic_/, .build.info). Used for build-version detection. */
  installDir: string;
  /** <installDir>/<flavorSubdir> — loose-file texture fallback search root for the active flavor. */
  installFlavorDir: string;
  /** Root of the unified cache tree; parent of all flavor subdirectories. */
  cacheRoot: string;
  flavor: string;
  extractScriptPath: string;
  /** Path to the CASC extraction tool binary (e.g. rustydemon-cli). Empty = auto-detect from PATH. */
  cascToolPath: string;
  output: vscode.LogOutputChannel;
  logLevel: vscode.LogLevel;
}

/**
 * Resolves WoW texture paths to local PNG files, converting BLP on first use.
 * All results are cached on disk under cacheDir.
 */
export class AssetService {
  private readonly opts: AssetServiceOptions;
  /** In-flight promises keyed by rawPath to avoid duplicate concurrent decodes. */
  private readonly inflight = new Map<string, Promise<string | null>>();
  /** Set once the Blizzard addon file discovery+extraction pass has run. Cleared by invalidate(). */
  private blizzardFilesEnsured = false;

  constructor(opts: AssetServiceOptions) {
    this.opts = opts;
  }

  /** Call when VSCode config changes; resets resolution memo so new dirs are picked up. */
  invalidate(): void {
    clearResolutionMemo();
    this.inflight.clear();
    this.blizzardFilesEnsured = false;
    clearRegistryCache(this.opts.registryDir);
  }

  /** Returns true if ensureBlizzardFiles() has already been initiated this session.
   * Used by the panel to skip the "pending" UI state on re-opens when extraction is settled. */
  hasBlizzardExtractionRun(): boolean {
    return this.blizzardFilesEnsured;
  }

  /** Invalidate resolution memo and registry cache after new Blizzard files land on disk.
   * Unlike invalidate(), preserves blizzardFilesEnsured so extraction is not re-triggered
   * on the next panel open — the extraction pass is settled for this session. */
  invalidateAfterBlizzardExtraction(): void {
    clearResolutionMemo();
    this.inflight.clear();
    clearRegistryCache(this.opts.registryDir);
  }

  /** Lighter invalidation for post-texture-extraction retries: clears the resolution memo
   * so newly extracted files are picked up, but leaves the Blizzard registry cache and
   * blizzardFilesEnsured intact so addon extraction is not re-triggered. */
  invalidateTextures(): void {
    clearResolutionMemo();
    this.inflight.clear();
  }

  /**
   * Compare the WoW install's current BuildText against the on-disk stamp for the active
   * flavor. If they differ (or the stamp is absent), delete the flavor's entire cache
   * subtree so the next extraction starts clean. Silent no-op when installDir is unset or
   * .build.info is unreadable (avoids destroying a valid cache on uncertainty).
   */
  checkBuildVersion(): void {
    if (!this.opts.installDir) return;
    const current = readBuildText(this.opts.installDir, this.opts.flavor);
    if (!current) return;
    const stamped = readBuildStamp(this.opts.cacheRoot, this.opts.flavor);
    if (stamped === current) return;
    clearFlavorCache(this.opts.cacheRoot, this.opts.flavor);
    this.invalidate();
    try {
      this.opts.output.info(
        `[Scryer] WoW build changed (${stamped ?? "none"} → ${current}); cleared ${this.opts.flavor} cache.`,
      );
    } catch {
      /* channel disposed */
    }
  }

  /**
   * Return the flavors recognized in the WoW install's .build.info.
   * Empty when installDir is unset or the file is absent/unreadable.
   */
  getInstalledFlavors(): InstalledFlavor[] {
    if (!this.opts.installDir) return [];
    return listInstalledFlavors(this.opts.installDir);
  }

  /**
   * Log the flavors detected in .build.info to the output channel.
   * Emits a warning if the configured flavor is not present among them.
   */
  detectAndLogFlavors(): void {
    if (!this.opts.installDir) return;
    const installed = listInstalledFlavors(this.opts.installDir);
    if (installed.length === 0) return;
    const summary = installed.map(({ flavor, version }) => `${flavor} (${version})`).join(", ");
    try {
      this.opts.output.info(`[Scryer] detected flavors: ${summary}`);
      if (!installed.some(({ flavor }) => flavor === this.opts.flavor)) {
        this.opts.output.warn(
          `[Scryer] configured flavor '${this.opts.flavor}' not found in .build.info — check scryer.flavor setting.`,
        );
      }
    } catch {
      /* channel disposed */
    }
  }

  /** Write the current .build.info BuildText as the flavor stamp after a successful extraction. */
  private writeBuildStampIfConfigured(): void {
    if (!this.opts.installDir) return;
    const current = readBuildText(this.opts.installDir, this.opts.flavor);
    if (current) writeBuildStamp(this.opts.cacheRoot, this.opts.flavor, current);
  }

  /**
   * Resolve rawPath to an absolute PNG path on disk.
   * Returns null if the asset cannot be found or decoded.
   * addonDir is the directory of the XML file being previewed (for addon-local textures).
   */
  async resolveToAbsPath(rawPath: string, addonDir?: string): Promise<string | null> {
    const key = rawPath + "\0" + (addonDir ?? "");
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const promise = this._resolve(rawPath, addonDir);
    this.inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(key);
    }
  }

  private get searchDirs(): string[] {
    return [this.opts.sourceDir, this.opts.installFlavorDir].filter(Boolean);
  }

  private async _resolve(rawPath: string, addonDir?: string): Promise<string | null> {
    const found = resolveTexturePath(rawPath, this.searchDirs, addonDir);
    if (!found) return null;

    if (found.kind === "png") {
      return found.absPath;
    }

    if (found.kind === "tga") {
      this.opts.output.warn(
        `[Scryer] TGA not yet supported: ${rawPath} — pre-convert to PNG with an image editor or extraction tool.`,
      );
      return null;
    }

    // BLP — decode and cache
    const key = cacheKey(found.absPath);
    const cached = getCachedPath(this.opts.texturesConvDir, key);
    if (cached) return cached;

    try {
      const pngBytes = blpToPng(found.absPath);
      return writeCached(this.opts.texturesConvDir, key, pngBytes);
    } catch (err) {
      this.opts.output.warn(`[Scryer] BLP decode failed for ${rawPath}: ${String(err)}`);
      return null;
    }
  }

  /**
   * Ensure the Blizzard addon XML/TOC files needed for template resolution are present
   * under extractedAssetsDir. Uses the same extraction pipeline as textures.
   *
   * Runs a discover → extract → discover loop (max 5 rounds) so that <Include>
   * dependencies that were only reachable once their parent files arrived are also
   * pulled in. Skips silently when extractedAssetsDir is unset or no extract script
   * is found. Subsequent calls within the same AssetService lifetime are no-ops;
   * call invalidate() to force a re-check (e.g. after a config change).
   */
  /**
   * Returns true if files were newly extracted (caller should invalidate and re-render).
   * Returns false if nothing was missing, nothing could be extracted, or extraction
   * produced no new files — so the caller does not loop.
   */
  async ensureBlizzardFiles(): Promise<boolean> {
    if (this.blizzardFilesEnsured || !this.opts.sourceDir) return false;
    this.blizzardFilesEnsured = true; // set early to prevent concurrent calls

    // Only check the addons that are actually needed for the configured startupContent,
    // matching the same filter used in loadBlizzardTemplates(). This prevents FrameXML
    // from being flagged as missing when the user only needs shared templates.
    const startupContent =
      vscode.workspace.getConfiguration("scryer").get<string>("startupContent") ?? "none";
    const addonNames = startupContent === "shared-templates" ? SHARED_ADDON_NAMES : ADDON_NAMES;

    const addonsDir = resolveAddonsDir(this.opts.sourceDir);
    const before = discoverBlizzardPaths(this.opts.sourceDir, addonsDir, addonNames);
    if (before.length === 0) return false;

    try {
      this.opts.output.info(
        `[Scryer] Blizzard addon files: ${before.length} missing — extracting all addon interface files…`,
      );
    } catch {
      /* channel disposed */
    }
    await shellExtractInterface({
      flavor: this.opts.flavor,
      outDir: this.opts.sourceDir,
      extractScriptPath: this.opts.extractScriptPath,
      wowDir: this.opts.installDir,
      cascToolPath: this.opts.cascToolPath,
      output: this.opts.output,
      logLevel: this.opts.logLevel,
    });
    this.writeBuildStampIfConfigured();

    // Re-check: only signal re-render if extraction actually produced new files.
    // If it didn't (no script, failed extraction, etc.) we stop here rather than loop.
    const after = discoverBlizzardPaths(this.opts.sourceDir, addonsDir, addonNames);
    return after.length < before.length;
  }

  /**
   * Load the Blizzard virtual template registry from the extracted addons directory.
   * Parses Blizzard_SharedXML and Blizzard_FrameXML via their TOC files, following
   * <Include> chains. Result is disk-cached and invalidated by TOC file mtime.
   * Returns an empty map if extractedAssetsDir is not configured or addons are absent.
   */
  loadBlizzardTemplates(): Map<string, FrameIR> {
    if (!this.opts.sourceDir) return new Map();
    const addonsDir = resolveAddonsDir(this.opts.sourceDir);
    const startupContent =
      vscode.workspace.getConfiguration("scryer").get<string>("startupContent") ?? "none";
    const addonNames = startupContent === "shared-templates" ? SHARED_ADDON_NAMES : ADDON_NAMES;
    return loadBlizzardRegistry(addonsDir, this.opts.registryDir, addonNames);
  }

  /**
   * Resolve and cache every texture referenced in the Blizzard templates for the given
   * addon subset. Converts BLP files to PNG on first use so subsequent panel opens
   * serve textures from the disk cache without any decode delay.
   * Skips silently when extractedAssetsDir is not configured.
   */
  async prewarmBlizzardTextures(addonNames: string[]): Promise<void> {
    if (!this.opts.sourceDir) return;
    const addonsDir = resolveAddonsDir(this.opts.sourceDir);
    const registry = loadBlizzardRegistry(addonsDir, this.opts.registryDir, addonNames);
    const paths = collectTexturePaths(Array.from(registry.values()));
    await Promise.all(paths.map((p) => this.resolveToAbsPath(p)));
  }

  /**
   * Extract a specific set of WoW-relative texture paths via the configured extractor.
   * Skips silently if no extraction script is found.
   * The caller should call invalidate() after this returns so the resolver
   * picks up newly written files.
   *
   * Implementation lives in extractor.ts and will be replaced by the in-JS CASC
   * reader (see backlog: "In-process JavaScript CASC reader").
   */
  async extractMissing(paths: string[]): Promise<void> {
    await shellExtractMissing(paths, {
      flavor: this.opts.flavor,
      outDir: this.opts.sourceDir,
      extractScriptPath: this.opts.extractScriptPath,
      wowDir: this.opts.installDir,
      cascToolPath: this.opts.cascToolPath,
      output: this.opts.output,
      logLevel: this.opts.logLevel,
    });
    this.writeBuildStampIfConfigured();
  }

  /**
   * Build the set of URI roots that the webview must be allowed to load from.
   * cacheRoot covers all flavor subtrees (source/ and derived/textures/).
   * installFlavorDir is the loose-file root for Classic installations.
   */
  webviewResourceRoots(): vscode.Uri[] {
    const roots: vscode.Uri[] = [vscode.Uri.file(this.opts.cacheRoot)];
    if (this.opts.installFlavorDir) {
      roots.push(vscode.Uri.file(this.opts.installFlavorDir));
    }
    return roots;
  }

  static fromConfig(
    context: vscode.ExtensionContext,
    output: vscode.LogOutputChannel,
  ): AssetService {
    const cfg = vscode.workspace.getConfiguration("scryer");
    const wsFolder =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? context.extensionUri.fsPath;

    const cacheLocation = cfg.get<string>("cacheLocation") ?? "global";
    const cacheRoot =
      cacheLocation === "workspace"
        ? path.join(wsFolder, ".scryer-cache")
        : cacheLocation === "custom"
          ? cfg.get<string>("cacheDir") || path.join(wsFolder, ".scryer-cache")
          : context.globalStorageUri.fsPath;

    const installDir = cfg.get<string>("installDir") ?? "";
    const flavor = cfg.get<string>("flavor") || "retail";
    const extractScriptPath = cfg.get<string>("extractScriptPath") ?? "";
    const cascToolPath = cfg.get<string>("cascToolPath") ?? "";
    const logLevel = parseLogLevel(cfg.get<string>("logLevel") ?? "warning");

    const flavorRoot = path.join(cacheRoot, flavor);
    const installFlavorDir = installDir ? path.join(installDir, flavorSubdir(flavor)) : "";

    return new AssetService({
      sourceDir: path.join(flavorRoot, "source"),
      texturesConvDir: path.join(flavorRoot, "derived", "textures"),
      registryDir: path.join(flavorRoot, "derived", "registry"),
      installDir,
      installFlavorDir,
      cacheRoot,
      flavor,
      extractScriptPath,
      cascToolPath,
      output,
      logLevel,
    });
  }
}
