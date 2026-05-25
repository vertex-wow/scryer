import * as vscode from "vscode";
import { parseXmlFile } from "./parser/index.js";
import { resolveInheritance } from "./parser/inherit.js";
import type { HostMessage, Viewport } from "./protocol.js";

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 32; i++) result += chars[Math.floor(Math.random() * chars.length)];
  return result;
}

const DEFAULT_VIEWPORT: Viewport = { w: 1280, h: 720 };

export class ScryerPanel {
  static readonly viewType = "scryer.preview";

  private readonly panel: vscode.WebviewPanel;
  private readonly output: vscode.OutputChannel;
  private disposables: vscode.Disposable[] = [];
  private pendingUri: vscode.Uri | undefined;

  static create(context: vscode.ExtensionContext, uri: vscode.Uri): ScryerPanel {
    const column = vscode.window.activeTextEditor
      ? vscode.ViewColumn.Beside
      : vscode.ViewColumn.One;

    const panel = vscode.window.createWebviewPanel(
      ScryerPanel.viewType,
      `Scryer: ${uri.path.split("/").pop() ?? "Preview"}`,
      column,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist")],
        retainContextWhenHidden: true,
      },
    );

    return new ScryerPanel(panel, context, uri);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    uri: vscode.Uri,
  ) {
    this.panel = panel;
    this.output = vscode.window.createOutputChannel("Scryer");
    this.panel.webview.html = this.buildHtml(context);

    this.panel.webview.onDidReceiveMessage(
      (message: unknown) => this.handleWebviewMessage(message, uri),
      null,
      this.disposables,
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private handleWebviewMessage(message: unknown, uri: vscode.Uri): void {
    if (typeof message !== "object" || !message) return;
    const msg = message as { type: string };
    if (msg.type === "ready") {
      void this.renderFile(uri);
    }
  }

  async renderFile(uri: vscode.Uri): Promise<void> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const content = Buffer.from(bytes).toString("utf-8");
      const doc = parseXmlFile(uri.fsPath, content);
      const [resolved] = resolveInheritance([doc]);
      if (!resolved) return;

      const msg: HostMessage = {
        type: "render",
        frames: resolved.frames.filter((f) => !f.virtual),
        viewport: DEFAULT_VIEWPORT,
      };

      void this.panel.webview.postMessage(msg);
    } catch (err) {
      this.output.appendLine(`[Scryer] Error rendering ${uri.fsPath}: ${String(err)}`);
      this.output.show(true);
    }
  }

  private buildHtml(context: vscode.ExtensionContext): string {
    const webview = this.panel.webview;
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, "dist", "webview.js"),
    );
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource}`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Scryer Preview</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#1a1a1a;display:flex;flex-direction:column;align-items:flex-start;padding:8px;overflow:auto}
    #viewport{position:relative}
    #debug{font:11px monospace;color:#888;padding:4px 0;white-space:pre-wrap}
  </style>
</head>
<body>
  <div id="debug">script not yet loaded</div>
  <div id="viewport"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.output.dispose();
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
