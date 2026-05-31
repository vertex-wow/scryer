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
  type ExtractCoreOptions,
  type ExtractionResult,
  type Flavor,
} from "./extract-core.js";
import { generateAtlasManifest } from "./atlas-gen.js";

export interface ExtractorOptions {
  flavor: string;
  outDir: string;
  /** WoW root directory. Empty string means extraction is unavailable. */
  wowDir?: string;
  cascToolPath?: string;
  listfileDir?: string;
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
  return /\.\w+$/i.test(slashed) ? slashed : slashed + ".blp";
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

function writeLogLine(output: vscode.LogOutputChannel, line: string): void {
  const level = classifyLine(line);
  safeLog(output, level, line);
}

function makeCoreOpts(opts: ExtractorOptions): ExtractCoreOptions {
  return {
    flavor: (opts.flavor || "retail") as Flavor,
    outDir: opts.outDir,
    wowDir: opts.wowDir!,
    cascToolPath: opts.cascToolPath,
    listfileDir: opts.listfileDir ?? "",
    log: (line: string) => writeLogLine(opts.output, line),
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
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Scryer: extracting ${paths.length} file${paths.length === 1 ? "" : "s"}…`,
        cancellable: false,
      },
      () => extractPaths(normalized, makeCoreOpts(opts)),
    );
  } catch (err) {
    safeLog(opts.output, "warn", `Extraction failed: ${String(err)}`);
  }
}

/**
 * Extract all Blizzard addon interface files via a bulk --type interface pass.
 * Much faster than per-file extraction for the initial Blizzard corpus setup.
 * Errors when wowDir is not configured — it is required for extraction to work.
 */
export async function extractInterface(opts: ExtractorOptions): Promise<void> {
  if (!opts.wowDir) {
    safeLog(
      opts.output,
      "error",
      "scryer.installDir is not set. Set it to your WoW root directory (the folder containing _retail_/, _classic_/, .build.info) to enable extraction.",
    );
    return;
  }
  let result: ExtractionResult | undefined;
  try {
    result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Scryer: extracting Blizzard addon files…",
        cancellable: false,
      },
      () => extractBulk("interface", makeCoreOpts(opts)),
    );
  } catch (err) {
    safeLog(
      opts.output,
      "error",
      `asset-extraction failed: "${opts.flavor}/interface" → ${String(err)} — individual file errors logged above at trace level`,
    );
    return;
  }
  safeLog(
    opts.output,
    "info",
    `assets-extraction: Blizzard addons extracted (${result.exported} exported, ${result.skippedExists} cached, ${result.errors} ignored)`,
  );
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

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Scryer: generating atlas manifest…",
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
