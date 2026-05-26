import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

export interface ExtractorOptions {
  flavor: string;
  extractScriptPath: string;
  output: vscode.OutputChannel;
}

/**
 * Normalize a WoW-relative texture path for the paths file:
 * - backslashes → forward slashes
 * - no extension → append .blp (WoW XML paths often omit the extension; BLP is the
 *   default, and the community listfile uses explicit .blp entries)
 */
function normalizeForExtraction(rawPath: string): string {
  const slashed = rawPath.replace(/\\/g, "/");
  return /\.(blp|tga|png)$/i.test(slashed) ? slashed : slashed + ".blp";
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
        title: `Scryer: extracting ${paths.length} texture${paths.length === 1 ? "" : "s"}…`,
        cancellable: false,
      },
      () => spawnExtract(scriptPath, tmpFile, opts),
    );
  } catch (err) {
    opts.output.appendLine(`[Scryer] Extraction failed: ${String(err)}`);
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
    opts.output.appendLine(`[Scryer] Spawning: ${scriptPath} ${flavor} --paths-file ${pathsFile}`);
    const proc = cp.spawn(scriptPath, [flavor, "--paths-file", pathsFile], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout?.on("data", (d: Buffer) => opts.output.append(String(d)));
    proc.stderr?.on("data", (d: Buffer) => opts.output.append(String(d)));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`extract.sh exited with code ${code}`));
    });
  });
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
