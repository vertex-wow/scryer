import * as path from "path";
import * as vscode from "vscode";
import { blpToPng } from "./blp.js";
import { cacheKey, getCachedPath, writeCached } from "./cache.js";
import { clearResolutionMemo, resolveTexturePath } from "./resolver.js";

export interface AssetServiceOptions {
  extractedAssetsDir: string;
  installDir: string;
  cacheDir: string;
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

  constructor(opts: AssetServiceOptions) {
    this.opts = opts;
  }

  /** Call when VSCode config changes; resets resolution memo so new dirs are picked up. */
  invalidate(): void {
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

    return new AssetService({ extractedAssetsDir, installDir, cacheDir, output });
  }
}
