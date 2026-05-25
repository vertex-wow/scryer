import * as vscode from "vscode";
import { ScryerPanel } from "./panel.js";

export function activate(context: vscode.ExtensionContext): void {
  const cmd = vscode.commands.registerCommand("scryer.open", () => {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (!uri) {
      void vscode.window.showErrorMessage("Scryer: open a .xml file first.");
      return;
    }
    if (!uri.fsPath.endsWith(".xml")) {
      void vscode.window.showErrorMessage("Scryer: active file is not an XML file.");
      return;
    }
    ScryerPanel.create(context, uri);
  });

  context.subscriptions.push(cmd);
}

export function deactivate(): void {}
