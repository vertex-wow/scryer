import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

export interface WorkspaceTarget {
  name?: string;
  flavor: "mainline" | "mists" | "bcc" | "classic_era";
  interfaceVersion?: number;
  wowInstallDir?: string;
  cacheDir?: string;
}

const VALID_FLAVORS = new Set(["mainline", "mists", "bcc", "classic_era"]);
export const TARGET_FILE = ".scryer/target.json";

/**
 * Read and validate .scryer/target.json from the first workspace folder.
 * Returns null if the file is absent, unreadable, or has an invalid flavor.
 */
export function readWorkspaceTarget(): WorkspaceTarget | null {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return null;
  try {
    const raw = fs.readFileSync(path.join(root, TARGET_FILE), "utf8");
    const parsed = JSON.parse(raw) as Partial<WorkspaceTarget>;
    if (!parsed.flavor || !VALID_FLAVORS.has(parsed.flavor)) return null;
    return parsed as WorkspaceTarget;
  } catch {
    return null;
  }
}

/**
 * Returns the effective target flavor and whether it came from .scryer/target.json.
 * Priority: workspace target.json > scryer.defaultTarget setting > "mainline".
 */
export function getEffectiveTarget(): { flavor: string; fromFile: boolean } {
  const ws = readWorkspaceTarget();
  if (ws) return { flavor: ws.flavor, fromFile: true };
  const flavor =
    vscode.workspace.getConfiguration("scryer").get<string>("defaultTarget") ?? "mainline";
  return { flavor, fromFile: false };
}
