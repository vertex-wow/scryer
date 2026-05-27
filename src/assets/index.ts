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
  /** <cacheRoot>/source — parent of Interface/; raw WoW assets, expensive to regenerate. */
  sourceDir: string;
  /** <cacheRoot>/derived/textures — BLP→PNG conversions, always safe to delete. */
  texturesConvDir: string;
  /** <cacheRoot>/derived/registry — parsed Blizzard template registry JSON, always safe to delete. */
  registryDir: string;
  /** WoW installation directory — Classic loose-file fallback; independent of cacheRoot. */
  installDir: string;
  /** Root of the unified cache tree; used as the single webview resource root. */
  cacheRoot: string;
  flavor: string;
  extractScriptPath: string;
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
    return [this.opts.sourceDir, this.opts.installDir].filter(Boolean);
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
      output: this.opts.output,
      logLevel: this.opts.logLevel,
    });

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
  extractMissing(paths: string[]): Promise<void> {
    return shellExtractMissing(paths, {
      flavor: this.opts.flavor,
      outDir: this.opts.sourceDir,
      extractScriptPath: this.opts.extractScriptPath,
      output: this.opts.output,
      logLevel: this.opts.logLevel,
    });
  }

  /**
   * Build the set of URI roots that the webview must be allowed to load from.
   * cacheRoot covers both source/ (raw PNG/TGA served directly) and derived/textures/
   * (BLP→PNG conversions) in one root. installDir is independent (Classic loose files).
   */
  webviewResourceRoots(): vscode.Uri[] {
    const roots: vscode.Uri[] = [vscode.Uri.file(this.opts.cacheRoot)];
    if (this.opts.installDir) {
      roots.push(vscode.Uri.file(this.opts.installDir));
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
    const logLevel = parseLogLevel(cfg.get<string>("logLevel") ?? "warning");

    return new AssetService({
      sourceDir: path.join(cacheRoot, "source"),
      texturesConvDir: path.join(cacheRoot, "derived", "textures"),
      registryDir: path.join(cacheRoot, "derived", "registry"),
      installDir,
      cacheRoot,
      flavor,
      extractScriptPath,
      output,
      logLevel,
    });
  }
}
