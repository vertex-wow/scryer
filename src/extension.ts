import * as vscode from "vscode";
import { AssetService } from "./assets/index.js";
import { ScryerPanel } from "./panel.js";

export function activate(context: vscode.ExtensionContext): void {
  const cmd = vscode.commands.registerCommand("scryer.open", (uri?: vscode.Uri) => {
    const resolved = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!resolved) {
      void vscode.window.showErrorMessage("Scryer: open a .xml file first.");
      return;
    }
    if (!resolved.fsPath.endsWith(".xml")) {
      void vscode.window.showErrorMessage("Scryer: active file is not an XML file.");
      return;
    }
    ScryerPanel.create(context, resolved);
  });

  context.subscriptions.push(cmd);

  // If startupContent requests eager template loading, pre-warm the registry disk cache
  // so the first panel open returns immediately from cache instead of parsing from disk.
  // Deferred past activation via a resolved promise so activate() returns promptly.
  const startupContent =
    vscode.workspace.getConfiguration("scryer").get<string>("startupContent") ?? "none";
  if (startupContent === "shared-templates" || startupContent === "all-templates") {
    const output = vscode.window.createOutputChannel("Scryer", { log: true });
    context.subscriptions.push(output);
    const assets = AssetService.fromConfig(context, output);
    void Promise.resolve().then(() => {
      assets.loadBlizzardTemplates();
    });
  }
}

export function deactivate(): void {}
