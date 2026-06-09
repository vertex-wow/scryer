import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { blpToPng } from "./blp.js";
import { cacheKey, getCachedPath, writeCached } from "./cache.js";
import { extractBlizzardShared, extractMissing, genAtlas } from "./extractor.js";
import {
  ADDON_NAMES,
  SHARED_ADDON_NAMES,
  blizzardAddonLuaFiles,
  clearRegistryCache,
  discoverBlizzardPaths,
  loadBlizzardRegistry,
  resolveCI,
  type BlizzardRegistry,
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
import { loadAtlasManifest, resolveAtlasNames, type AtlasManifest } from "./atlas-manifest.js";

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
  /** Path to the CASC extraction server binary. Empty = use bundled. */
  assetServerPath: string;
  assetServerIdleTimeout: number;
  /** Path to the grep binary. Empty = auto-detect from PATH. */
  grepPath: string;
  output: vscode.LogOutputChannel;
}

/**
 * Resolves WoW texture paths to local PNG files, converting BLP on first use.
 * All results are cached on disk under cacheDir.
 */
export class AssetService {
  private readonly opts: AssetServiceOptions;
  /** In-flight promises keyed by rawPath to avoid duplicate concurrent decodes. */
  private readonly inflight = new Map<string, Promise<string | null>>();
  /** In-flight or completed promise for the Blizzard file check/extraction pass. */
  private blizzardFilesPromise: Promise<boolean> | null = null;
  /** True once blizzardFilesPromise has settled — tells the panel it can skip pending state. */
  private blizzardFilesSettled = false;
  /** Set once the atlas manifest generation pass has run (or been skipped). Cleared by invalidate(). */
  private atlasManifestEnsured = false;
  /** Paths for which a one-shot extraction has already been attempted this session. */
  private readonly extractionAttempted = new Set<string>();

  constructor(opts: AssetServiceOptions) {
    this.opts = opts;
  }

  get installDir(): string {
    return this.opts.installDir;
  }
  get assetServerPath(): string {
    return this.opts.assetServerPath;
  }
  get cacheRoot(): string {
    return this.opts.cacheRoot;
  }

  /** True if <sourceDir>/Interface/ exists on disk (Blizzard assets have been extracted). */
  async hasExtractedAssets(): Promise<boolean> {
    const resolved = resolveCI(this.opts.sourceDir, "Interface");
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(resolved));
      return true;
    } catch {
      return false;
    }
  }

  /** Call when VSCode config changes; resets resolution memo so new dirs are picked up. */
  invalidate(): void {
    clearResolutionMemo();
    this.inflight.clear();
    this.blizzardFilesPromise = null;
    this.blizzardFilesSettled = false;
    this.atlasManifestEnsured = false;
    clearRegistryCache(this.opts.registryDir);
  }

  /** Returns true once ensureBlizzardFiles() has fully settled (not just initiated).
   * Used by the panel to skip the "pending" UI state when extraction is already complete. */
  hasBlizzardExtractionRun(): boolean {
    return this.blizzardFilesSettled;
  }

  /** Returns true if ensureAtlasManifest() has already run (or been skipped) this session. */
  hasAtlasManifestRun(): boolean {
    return this.atlasManifestEnsured;
  }

  /** Invalidate resolution memo and registry cache after new Blizzard files land on disk.
   * Unlike invalidate(), preserves blizzardFilesPromise so extraction is not re-triggered
   * on the next panel open — the extraction pass is settled for this session. */
  invalidateAfterBlizzardExtraction(): void {
    clearResolutionMemo();
    this.inflight.clear();
    clearRegistryCache(this.opts.registryDir);
  }

  /** Lighter invalidation for post-texture-extraction retries: clears the resolution memo
   * so newly extracted files are picked up, but leaves the Blizzard registry cache and
   * blizzardFilesPromise intact so addon extraction is not re-triggered. */
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
    // Write the stamp immediately so subsequent sessions don't re-clear the cache
    // before extraction has had a chance to run.
    writeBuildStamp(this.opts.cacheRoot, this.opts.flavor, current);
    this.invalidate();
    try {
      this.opts.output.info(
        `WoW build changed (${stamped ?? "none"} → ${current}); cleared ${this.opts.flavor} cache.`,
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
      this.opts.output.info(`detected game flavors: ${summary}`);
      if (!installed.some(({ flavor }) => flavor === this.opts.flavor)) {
        this.opts.output.warn(
          `configured flavor '${this.opts.flavor}' not found in .build.info — check scryer.flavor setting.`,
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
    const log = (msg: string) => {
      try {
        this.opts.output.trace(msg);
      } catch {
        /* disposed */
      }
    };
    const found = resolveTexturePath(rawPath, this.searchDirs, addonDir, log);
    if (!found) return null;

    if (found.kind === "png" || found.kind === "font") {
      return found.absPath;
    }

    if (found.kind === "tga") {
      this.opts.output.warn(
        `TGA not yet supported: ${rawPath} — pre-convert to PNG with an image editor or extraction tool.`,
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
      this.opts.output.warn(`BLP decode failed for ${rawPath}: ${String(err)}`);
      return null;
    }
  }

  /**
   * Ensure the atlas manifest JSON exists in the derived cache directory.
   * If the manifest is absent and the listfile is ready, downloads DB2 CSV data
   * from wago.tools and builds the manifest.
   *
   * Returns true if the manifest was newly generated (caller should re-render).
   * Returns false if the manifest already existed, the listfile was not ready, or
   * generation failed.
   *
   * Subsequent calls within the same AssetService lifetime are no-ops (set early
   * to prevent concurrent calls); call invalidate() to re-arm (e.g. after
   * a config change or cache wipe).
   */
  async ensureAtlasManifest(): Promise<boolean> {
    if (this.atlasManifestEnsured) return false;
    this.atlasManifestEnsured = true;

    // If the manifest already exists there is nothing to do.
    if (fs.existsSync(this.atlasManifestPath)) return false;

    fs.mkdirSync(path.dirname(this.atlasManifestPath), { recursive: true });

    const listfileReady = fs.existsSync(path.join(this.downloadsDir, "listfile.csv"));
    if (listfileReady) {
      try {
        this.opts.output.info("Atlas manifest absent — generating…");
      } catch {
        /* channel disposed */
      }
    }

    await genAtlas({
      manifestPath: this.atlasManifestPath,
      listfileDir: this.downloadsDir,
      output: this.opts.output,
    });

    return fs.existsSync(this.atlasManifestPath);
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
    if (!this.opts.sourceDir) return false;
    if (this.blizzardFilesPromise) return this.blizzardFilesPromise;
    this.blizzardFilesPromise = this._doEnsureBlizzardFiles();
    return this.blizzardFilesPromise;
  }

  private async _doEnsureBlizzardFiles(): Promise<boolean> {
    try {
      const addonsDir = resolveAddonsDir(this.opts.sourceDir);
      const missingAddons = discoverBlizzardPaths(this.opts.sourceDir, addonsDir);
      const fontsDir = resolveCI(this.opts.sourceDir, "Fonts");
      const fontsMissing = !fs.existsSync(fontsDir);

      if (missingAddons.length === 0 && !fontsMissing) {
        return false;
      }

      const missingCount = missingAddons.length + (fontsMissing ? 1 : 0);
      try {
        this.opts.output.info(
          `assets-start-extraction: shared templates (${missingCount} types missing)`,
        );
        for (const p of missingAddons) this.opts.output.debug(`  missing: ${p}`);
        if (fontsMissing) this.opts.output.debug(`  missing: Fonts/`);
      } catch {
        /* channel disposed */
      }
      await extractBlizzardShared({
        flavor: this.opts.flavor,
        outDir: this.opts.sourceDir,
        wowDir: this.opts.installDir,
        assetServerPath: this.opts.assetServerPath,
        assetServerIdleTimeout: this.opts.assetServerIdleTimeout,
        grepPath: this.opts.grepPath,
        listfileDir: this.downloadsDir,
        output: this.opts.output,
      });
      this.writeBuildStampIfConfigured();

      // Re-check: only signal re-render if extraction actually produced new files.
      // If it didn't (no script, failed extraction, etc.) we stop here rather than loop.
      const afterAddons = discoverBlizzardPaths(this.opts.sourceDir, addonsDir);
      const afterFontsMissing = !fs.existsSync(fontsDir);
      return afterAddons.length < missingAddons.length || (fontsMissing && !afterFontsMissing);
    } finally {
      this.blizzardFilesSettled = true;
    }
  }

  /**
   * Path where the atlas manifest JSON is expected to live.
   * Generated by genAtlas() and version-tagged alongside textures.
   */
  get atlasManifestPath(): string {
    return path.join(this.opts.texturesConvDir, "..", "atlas-manifest.json");
  }

  /** <cacheRoot>/downloads — shared downloads not specific to any flavor (listfile, etc.). */
  get downloadsDir(): string {
    return path.join(this.opts.cacheRoot, "downloads");
  }

  /**
   * Load the atlas manifest from the derived cache directory.
   * Returns null when the manifest has not been generated yet (normal for fresh installs).
   */
  loadAtlasManifest(): AtlasManifest | null {
    return loadAtlasManifest(this.atlasManifestPath);
  }

  /**
   * Load the Blizzard virtual template registry from the extracted addons directory.
   * Parses Blizzard_SharedXML and Blizzard_FrameXML via their TOC files, following
   * <Include> chains. Result is disk-cached and invalidated by TOC file mtime.
   * Returns an empty map if extractedAssetsDir is not configured or addons are absent.
   */
  loadBlizzardTemplates(): BlizzardRegistry {
    if (!this.opts.sourceDir) return { frames: new Map(), textures: new Map() };
    const addonsDir = resolveAddonsDir(this.opts.sourceDir);
    const startupContent =
      vscode.workspace.getConfiguration("scryer").get<string>("startupContent") ?? "none";
    const addonNames = startupContent === "shared-templates" ? SHARED_ADDON_NAMES : ADDON_NAMES;
    return loadBlizzardRegistry(addonsDir, this.opts.registryDir, addonNames);
  }

  /**
   * Return all Lua files for a Blizzard addon in TOC-defined order.
   * Only files that exist on disk are included. Returns empty array if the addon
   * is not extracted or its TOC is missing.
   */
  blizzardAddonLuaFiles(addonName: string, onMissing?: (relPath: string) => void): string[] {
    if (!this.opts.sourceDir) return [];
    const addonsDir = resolveAddonsDir(this.opts.sourceDir);
    return blizzardAddonLuaFiles(addonsDir, addonName, onMissing);
  }

  /**
   * Resolve a list of paths relative to the Blizzard addons directory and return only
   * those that exist on disk. Used to locate specific Lua files before running the sandbox.
   */
  resolveBlizzardLuaFiles(relPaths: string[]): string[] {
    if (!this.opts.sourceDir) return [];
    const addonsDir = resolveAddonsDir(this.opts.sourceDir);
    return relPaths
      .map((p) => resolveCI(addonsDir, p))
      .filter((p) => {
        try {
          fs.statSync(p);
          return true;
        } catch {
          return false;
        }
      });
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
    const { frames: frameMap } = loadBlizzardRegistry(addonsDir, this.opts.registryDir, addonNames);
    const frames = Array.from(frameMap.values());
    const atlasManifest = this.loadAtlasManifest();
    if (atlasManifest) resolveAtlasNames(frames, atlasManifest);
    const paths = collectTexturePaths(frames);
    await Promise.all(paths.map((p) => this.resolveToAbsPath(p)));
  }

  /**
   * Extract a specific set of WoW-relative texture paths via the configured extractor.
   * Skips silently when scryer.installDir is not configured.
   * The caller should call invalidate() after this returns so the resolver
   * picks up newly written files.
   */
  /** Returns true if extraction for this path has not yet been attempted this session. Marks it attempted. */
  claimExtraction(rawPath: string): boolean {
    if (this.extractionAttempted.has(rawPath)) return false;
    this.extractionAttempted.add(rawPath);
    return true;
  }

  async extractMissing(paths: string[]): Promise<void> {
    await extractMissing(paths, {
      flavor: this.opts.flavor,
      outDir: this.opts.sourceDir,
      wowDir: this.opts.installDir,
      assetServerPath: this.opts.assetServerPath,
      assetServerIdleTimeout: this.opts.assetServerIdleTimeout,
      grepPath: this.opts.grepPath,
      listfileDir: this.downloadsDir,
      output: this.opts.output,
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
    const assetServerPath = cfg.get<string>("assetServerPath") ?? "";
    const assetServerIdleTimeout = cfg.get<number>("assetServerIdleTimeout") ?? 20;
    const grepPath = cfg.get<string>("grepPath") ?? "";

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
      assetServerPath,
      assetServerIdleTimeout,
      grepPath,
      output,
    });
  }
}
