import * as path from "path";
import * as vscode from "vscode";
import { blpToPng } from "./blp.js";
import { cacheKey, getCachedPath, writeCached } from "./cache.js";
import { shellExtractInterface, shellExtractMissing } from "./extractor.js";
import {
  clearRegistryCache,
  discoverBlizzardPaths,
  loadBlizzardRegistry,
} from "../parser/blizzard-registry.js";
import { clearResolutionMemo, resolveTexturePath } from "./resolver.js";
import type { FrameIR } from "../parser/ir.js";

export interface AssetServiceOptions {
  extractedAssetsDir: string;
  installDir: string;
  cacheDir: string;
  flavor: string;
  extractScriptPath: string;
  output: vscode.OutputChannel;
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
    clearRegistryCache(this.opts.cacheDir);
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
    return [this.opts.extractedAssetsDir, this.opts.installDir].filter(Boolean);
  }

  private async _resolve(rawPath: string, addonDir?: string): Promise<string | null> {
    const found = resolveTexturePath(rawPath, this.searchDirs, addonDir);
    if (!found) return null;

    if (found.kind === "png") {
      return found.absPath;
    }

    if (found.kind === "tga") {
      this.opts.output.appendLine(
        `[Scryer] TGA not yet supported: ${rawPath} — pre-convert to PNG with an image editor or extraction tool.`,
      );
      return null;
    }

    // BLP — decode and cache
    const key = cacheKey(found.absPath);
    const cached = getCachedPath(this.opts.cacheDir, key);
    if (cached) return cached;

    try {
      const pngBytes = blpToPng(found.absPath);
      return writeCached(this.opts.cacheDir, key, pngBytes);
    } catch (err) {
      this.opts.output.appendLine(`[Scryer] BLP decode failed for ${rawPath}: ${String(err)}`);
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
    if (this.blizzardFilesEnsured || !this.opts.extractedAssetsDir) return false;
    this.blizzardFilesEnsured = true; // set early to prevent concurrent calls

    const addonsDir = path.join(this.opts.extractedAssetsDir, "Interface", "AddOns");
    const before = discoverBlizzardPaths(this.opts.extractedAssetsDir, addonsDir);
    if (before.length === 0) return false;

    this.opts.output.appendLine(
      `[Scryer] Blizzard addon files: ${before.length} missing — extracting all addon interface files…`,
    );
    await shellExtractInterface({
      flavor: this.opts.flavor,
      extractScriptPath: this.opts.extractScriptPath,
      output: this.opts.output,
    });

    // Re-check: only signal re-render if extraction actually produced new files.
    // If it didn't (no script, failed extraction, etc.) we stop here rather than loop.
    const after = discoverBlizzardPaths(this.opts.extractedAssetsDir, addonsDir);
    return after.length < before.length;
  }

  /**
   * Load the Blizzard virtual template registry from the extracted addons directory.
   * Parses Blizzard_SharedXML and Blizzard_FrameXML via their TOC files, following
   * <Include> chains. Result is disk-cached and invalidated by TOC file mtime.
   * Returns an empty map if extractedAssetsDir is not configured or addons are absent.
   */
  loadBlizzardTemplates(): Map<string, FrameIR> {
    if (!this.opts.extractedAssetsDir) return new Map();
    const addonsDir = path.join(this.opts.extractedAssetsDir, "Interface", "AddOns");
    return loadBlizzardRegistry(addonsDir, this.opts.cacheDir);
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
      extractScriptPath: this.opts.extractScriptPath,
      output: this.opts.output,
    });
  }

  /**
   * Build the set of URI roots that the webview must be allowed to load from.
   * The cache dir always needs to be included; extractedAssetsDir is included so
   * PNG files there can be served directly without copying.
   */
  webviewResourceRoots(): vscode.Uri[] {
    const roots: vscode.Uri[] = [vscode.Uri.file(this.opts.cacheDir)];
    if (this.opts.extractedAssetsDir) {
      roots.push(vscode.Uri.file(this.opts.extractedAssetsDir));
    }
    if (this.opts.installDir) {
      roots.push(vscode.Uri.file(this.opts.installDir));
    }
    return roots;
  }

  static fromConfig(context: vscode.ExtensionContext, output: vscode.OutputChannel): AssetService {
    const cfg = vscode.workspace.getConfiguration("scryer");
    const wsFolder =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? context.extensionUri.fsPath;

    const extractedAssetsDir = cfg.get<string>("extractedAssetsDir") ?? "";
    const installDir = cfg.get<string>("installDir") ?? "";
    const cacheDir = cfg.get<string>("assetCacheDir") || path.join(wsFolder, ".scryer-cache");
    const flavor = cfg.get<string>("flavor") || "retail";
    const extractScriptPath = cfg.get<string>("extractScriptPath") ?? "";

    return new AssetService({
      extractedAssetsDir,
      installDir,
      cacheDir,
      flavor,
      extractScriptPath,
      output,
    });
  }
}
