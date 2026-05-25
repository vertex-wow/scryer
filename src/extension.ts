import * as vscode from "vscode";
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
}

export function deactivate(): void {}
