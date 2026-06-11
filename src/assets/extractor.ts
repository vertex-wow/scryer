/**
 * VSCode-aware wrappers around the extraction and atlas-gen core libraries.
 *
 * This file is the only place in src/ that imports vscode. The underlying logic
 * lives in extract-core.ts and atlas-gen.ts (no vscode dependency) so those
 * modules can be called directly from dev CLI scripts and unit tests.
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  extractPaths,
  extractBulk,
  BLIZZARD_LUA_CRITICAL_GLOBS,
  BLIZZARD_BULK_GLOBS,
  type ExtractCoreOptions,
  type ExtractionResult,
  type Flavor,
} from "./extract-core.js";
import { generateAtlasManifest } from "./atlas-gen.js";

/**
 * Merges all extraction popup notifications into one persistent notification that
 * updates its message based on what is currently running. User-priority jobs take
 * precedence in the displayed message over prewarm jobs.
 */
class ExtractionProgressNotifier {
  private progressReporter: vscode.Progress<{ message?: string }> | null = null;
  private resolveNotification: (() => void) | null = null;
  private userJobs = 0;
  private prewarmJobs = 0;

  async run<T>(phase: "user" | "prewarm", fn: () => Promise<T>): Promise<T> {
    const wasIdle = this.userJobs + this.prewarmJobs === 0;
    if (phase === "user") {
      this.userJobs++;
    } else {
      this.prewarmJobs++;
    }

    if (wasIdle) {
      void vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Scryer", cancellable: false },
        (progress) => {
          this.progressReporter = progress;
          this.updateMessage();
          return new Promise<void>((resolve) => {
            this.resolveNotification = resolve;
          });
        },
      );
    } else {
      this.updateMessage();
    }

    try {
      return await fn();
    } finally {
      if (phase === "user") {
        this.userJobs--;
      } else {
        this.prewarmJobs--;
      }
      if (this.userJobs + this.prewarmJobs === 0) {
        this.resolveNotification?.();
        this.resolveNotification = null;
        this.progressReporter = null;
      } else {
        this.updateMessage();
      }
    }
  }

  isExtracting(): boolean {
    return this.userJobs + this.prewarmJobs > 0;
  }

  private updateMessage(): void {
    const msg =
      this.userJobs > 0 ? "Extracting game assets…" : "Pre-warming cache with game assets…";
    this.progressReporter?.report({ message: msg });
  }
}

const progressNotifier = new ExtractionProgressNotifier();

/** Returns true if any extraction (user-priority or prewarm) is currently running. */
export function isExtracting(): boolean {
  return progressNotifier.isExtracting();
}

export interface ExtractorOptions {
  flavor: string;
  outDir: string;
  /** WoW root directory. Empty string means extraction is unavailable. */
  wowDir?: string;
  assetServerPath?: string;
  assetServerIdleTimeout?: number;
  grepPath?: string;
  listfileDir?: string;
  logFile?: string;
  /** When true, tell the asset server to attempt CDN fallback for CDN-only stubs. */
  cdnEnabled?: boolean;
  output: vscode.LogOutputChannel;
}

export interface AtlasGenWrapperOptions {
  /** Absolute path where atlas-manifest.json should be written. */
  manifestPath: string;
  /** Directory containing listfile.csv (e.g. <cacheRoot>/downloads). */
  listfileDir?: string;
  output: vscode.LogOutputChannel;
}

/**
 * Normalize a WoW-relative path for extraction:
 * - backslashes → forward slashes
 * - no extension → append .blp (WoW XML texture references conventionally omit
 *   the extension; BLP is the default and community listfile uses explicit .blp entries)
 * - any existing extension → kept as-is
 */
function normalizeForExtraction(rawPath: string): string {
  const slashed = rawPath.replace(/\\/g, "/");
  return (/\.\w+$/i.test(slashed) ? slashed : slashed + ".blp").toLowerCase();
}

/** Lines with 4+ leading spaces are trace-level tool internals; shallower lines are debug. */
function classifyLine(line: string): "trace" | "debug" {
  const indent = line.length - line.trimStart().length;
  return indent >= 4 ? "trace" : "debug";
}

/** Calls output[method](msg) and silently swallows errors from a disposed channel. */
function safeLog(
  output: vscode.LogOutputChannel,
  method: "trace" | "debug" | "info" | "warn" | "error",
  msg: string,
): void {
  try {
    output[method](msg);
  } catch {
    // channel was disposed (panel closed) before the async operation completed
  }
}

function _writeLogLine(output: vscode.LogOutputChannel, line: string): void {
  const level = classifyLine(line);
  safeLog(output, level, line);
}

function makeCoreOpts(opts: ExtractorOptions): ExtractCoreOptions {
  return {
    flavor: opts.flavor as Flavor,
    outDir: opts.outDir,
    wowDir: opts.wowDir || "",
    assetServerPath: opts.assetServerPath || "",
    assetServerIdleTimeout: opts.assetServerIdleTimeout ?? 20,
    grepPath: opts.grepPath,
    listfileDir: opts.listfileDir || "",
    logFile: opts.logFile,
    cdnEnabled: opts.cdnEnabled,
    log: (level, msg, serverTime) => {
      if (serverTime) {
        const ch = opts.output as { logServer?: (l: string, m: string, t: string) => void };
        if (ch.logServer) {
          ch.logServer(level, msg, serverTime);
          return;
        }
      }
      safeLog(opts.output, level, msg);
    },
  };
}

/**
 * Extract a specific set of WoW-relative texture paths via the configured extractor.
 * Errors when wowDir is not configured — it is required for extraction to work.
 */
export async function extractMissing(paths: string[], opts: ExtractorOptions): Promise<void> {
  if (paths.length === 0) return;
  if (!opts.wowDir) {
    safeLog(
      opts.output,
      "error",
      "scryer.installDir is not set. Set it to your WoW root directory (the folder containing _retail_/, _classic_/, .build.info) to enable extraction.",
    );
    return;
  }
  const normalized = paths.map(normalizeForExtraction);
  try {
    await progressNotifier.run("user", () => extractPaths(normalized, makeCoreOpts(opts), "user"));
  } catch (err) {
    safeLog(opts.output, "warn", `Extraction failed: ${String(err)}`);
  }
}

/**
 * Extract all Blizzard addon interface files for the prewarm path.
 * Enqueues two jobs at prewarm priority: (A) the Lua-critical addon trees
 * (SharedXMLBase, Colors, SharedXML, FrameXML) first, then (B) fonts.
 * Splitting lets a user-priority critical job slip between A and B when a
 * panel opens mid-prewarm. Returns the combined ExtractionResult so the
 * caller can detect unavailable files and show the CDN consent dialog.
 */
export async function extractBlizzardShared(
  opts: ExtractorOptions,
): Promise<ExtractionResult | undefined> {
  if (!opts.wowDir) {
    safeLog(
      opts.output,
      "error",
      "scryer.installDir is not set. Set it to your WoW root directory (the folder containing _retail_/, _classic_/, .build.info) to enable extraction.",
    );
    return undefined;
  }
  let result: ExtractionResult | undefined;
  try {
    const coreOpts = makeCoreOpts(opts);
    result = await progressNotifier.run("prewarm", async () => {
      if (opts.flavor === "retail") {
        // Two prewarm jobs so a user-priority panel open can slip between them.
        // Job A: critical addons (SharedXMLBase, Colors, SharedXML, FrameXML).
        const criticalRes = await extractPaths(BLIZZARD_LUA_CRITICAL_GLOBS, coreOpts, "prewarm");
        // Job B: fonts (pop-in candidate — text rendering delays are less jarring).
        const bulkRes = await extractPaths(BLIZZARD_BULK_GLOBS, coreOpts, "prewarm");
        return {
          exported: criticalRes.exported + bulkRes.exported,
          unavailable: criticalRes.unavailable + bulkRes.unavailable,
          errors: criticalRes.errors + bulkRes.errors,
        };
      }
      // Classic: single loose-file extraction (no priority queue, globs unsupported).
      return extractBulk("interface", coreOpts);
    });
  } catch (err) {
    safeLog(
      opts.output,
      "error",
      `assets-extraction failed: "${opts.flavor}/shared" → ${String(err)}`,
    );
    return undefined;
  }
  safeLog(
    opts.output,
    "info",
    `assets-extraction: Blizzard shared extracted (${result.exported} exported, ${result.unavailable} unavailable, ${result.errors} errors)`,
  );
  return result;
}

/**
 * Extract critical Blizzard addon trees at user priority (retail only).
 * Covers SharedXMLBase, Colors, SharedXML (Lua prerequisites) and FrameXML
 * (XML template registry — required for NineSlice and other inherited templates).
 * Called from live/static panels when a user opens a preview while the prewarm is
 * still running — jumps ahead of pending prewarm jobs in the queue.
 * Classic/ClassicEra: falls back to a full extractBulk("interface") pass (no queue).
 */
export async function extractCriticalBlizzardFiles(
  opts: ExtractorOptions,
): Promise<ExtractionResult | undefined> {
  if (!opts.wowDir) return undefined;
  try {
    const coreOpts = makeCoreOpts(opts);
    return await progressNotifier.run("user", () =>
      opts.flavor === "retail"
        ? extractPaths(BLIZZARD_LUA_CRITICAL_GLOBS, coreOpts, "user")
        : extractBulk("interface", coreOpts),
    );
  } catch (err) {
    safeLog(opts.output, "warn", `Critical Blizzard file extraction failed: ${String(err)}`);
    return undefined;
  }
}

/**
 * Generate the atlas manifest JSON by downloading WoW DB2 table CSV exports from wago.tools
 * and joining them with the community listfile.
 *
 * Silently skips when the listfile has not been downloaded yet (extraction not run).
 */
export async function genAtlas(opts: AtlasGenWrapperOptions): Promise<void> {
  const listfilePath = opts.listfileDir ? path.join(opts.listfileDir, "listfile.csv") : null;
  if (!listfilePath || !fs.existsSync(listfilePath)) {
    safeLog(opts.output, "debug", "Atlas manifest: listfile.csv not available yet — skipping.");
    return;
  }

  safeLog(opts.output, "trace", `notif: Scryer: Generating atlas manifest…`);
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Scryer: Generating atlas manifest…",
        cancellable: false,
      },
      () =>
        generateAtlasManifest({
          out: opts.manifestPath,
          listfile: listfilePath,
          log: (msg: string) => safeLog(opts.output, "info", msg),
        }),
    );
  } catch (err) {
    safeLog(opts.output, "warn", `Atlas manifest generation failed: ${String(err)}`);
  }
}
