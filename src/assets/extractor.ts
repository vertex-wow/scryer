import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

export interface ExtractorOptions {
  flavor: string;
  extractScriptPath: string;
  output: vscode.LogOutputChannel;
  logLevel: vscode.LogLevel;
}

/**
 * Normalize a WoW-relative path for the paths file:
 * - backslashes → forward slashes
 * - no extension → append .blp (WoW XML texture references conventionally omit
 *   the extension; BLP is the default and community listfile uses explicit .blp entries)
 * - any existing extension → kept as-is (handles XML/TOC/LUA interface files)
 */
function normalizeForExtraction(rawPath: string): string {
  const slashed = rawPath.replace(/\\/g, "/");
  return /\.\w+$/i.test(slashed) ? slashed : slashed + ".blp";
}

/**
 * Shell-script-based texture extractor. Delegates to dev/extract.sh.
 *
 * This module is intentionally isolated so it can be replaced wholesale when
 * the in-JS CASC reader is implemented (see backlog: "In-process JavaScript
 * CASC reader"). At that point only this file and the one-line call in
 * AssetService.extractMissing need to change.
 */
export async function shellExtractMissing(paths: string[], opts: ExtractorOptions): Promise<void> {
  if (paths.length === 0) return;

  const scriptPath = resolveScriptPath(opts.extractScriptPath);
  if (!scriptPath) return;

  const tmpFile = path.join(os.tmpdir(), `scryer-missing-${Date.now()}.txt`);
  const normalized = paths.map(normalizeForExtraction);
  await fs.promises.writeFile(tmpFile, normalized.join("\n") + "\n", "utf8");

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Scryer: extracting ${paths.length} file${paths.length === 1 ? "" : "s"}…`,
        cancellable: false,
      },
      () => spawnExtract(scriptPath, tmpFile, opts),
    );
  } catch (err) {
    safeLog(opts.output, "info", `[Scryer] Extraction failed: ${String(err)}`);
  } finally {
    await fs.promises.unlink(tmpFile).catch(() => {});
  }
}

function spawnExtract(
  scriptPath: string,
  pathsFile: string,
  opts: ExtractorOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const flavor = opts.flavor || "retail";
    safeLog(
      opts.output,
      "debug",
      `[Scryer] Spawning: ${scriptPath} ${flavor} --paths-file ${pathsFile}`,
    );
    const proc = cp.spawn(scriptPath, [flavor, "--paths-file", pathsFile], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const { onData, flush } = makeLineHandler(opts);
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("error", reject);
    proc.on("close", (code) => {
      flush();
      if (code === 0) resolve();
      else reject(new Error(`extract.sh exited with code ${code}`));
    });
  });
}

/**
 * Extract all Blizzard addon interface files via a single glob-based --type interface call.
 * Much faster than per-file --paths-file for the initial Blizzard corpus extraction.
 */
export async function shellExtractInterface(opts: ExtractorOptions): Promise<void> {
  const scriptPath = resolveScriptPath(opts.extractScriptPath);
  if (!scriptPath) return;

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Scryer: extracting Blizzard addon files…",
        cancellable: false,
      },
      () => spawnExtractInterface(scriptPath, opts),
    );
  } catch (err) {
    safeLog(opts.output, "info", `[Scryer] Interface extraction failed: ${String(err)}`);
  }
}

function spawnExtractInterface(scriptPath: string, opts: ExtractorOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const flavor = opts.flavor || "retail";
    safeLog(opts.output, "debug", `[Scryer] Spawning: ${scriptPath} ${flavor} --type interface`);
    const proc = cp.spawn(scriptPath, [flavor, "--type", "interface"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const { onData, flush } = makeLineHandler(opts);
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("error", reject);
    proc.on("close", (code) => {
      flush();
      if (code === 0) resolve();
      else reject(new Error(`extract.sh exited with code ${code}`));
    });
  });
}

/** Lines with 4+ leading spaces are trace-level tool internals; shallower lines are debug. */
function classifyLine(line: string): "trace" | "debug" {
  const indent = line.length - line.trimStart().length;
  return indent >= 4 ? "trace" : "debug";
}

/**
 * Write a log line, gating on the scryer.logLevel setting.
 * We must check the setting ourselves because LogOutputChannel's built-in
 * logLevel defaults to Info and silently drops trace/debug calls regardless
 * of the scryer.logLevel setting.
 */
function writeLogLine(
  output: vscode.LogOutputChannel,
  logLevel: vscode.LogLevel,
  line: string,
): void {
  const level = classifyLine(line);
  if (level === "trace") {
    if (logLevel <= vscode.LogLevel.Trace) safeLog(output, "trace", line);
  } else {
    if (logLevel <= vscode.LogLevel.Debug) safeLog(output, "debug", line);
  }
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

/** Returns handlers that buffer partial chunks and write complete lines at the right level. */
function makeLineHandler(opts: ExtractorOptions): {
  onData: (d: Buffer) => void;
  flush: () => void;
} {
  let buf = "";
  return {
    onData(d: Buffer): void {
      buf += String(d);
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) writeLogLine(opts.output, opts.logLevel, line);
    },
    flush(): void {
      if (buf) {
        writeLogLine(opts.output, opts.logLevel, buf);
        buf = "";
      }
    },
  };
}

function resolveScriptPath(explicit: string): string | null {
  if (explicit) {
    return fs.existsSync(explicit) ? explicit : null;
  }
  const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!wsFolder) return null;
  const auto = path.join(wsFolder, "dev", "extract.sh");
  return fs.existsSync(auto) ? auto : null;
}
