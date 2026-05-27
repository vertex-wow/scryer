import * as path from "path";
import * as vscode from "vscode";
import { AssetService } from "./assets/index.js";
import { parseXmlFile } from "./parser/index.js";
import { resolveInheritance } from "./parser/inherit.js";
import { collectTexturePaths } from "./parser/collect-textures.js";
import type { HostMessage, Viewport } from "./protocol.js";

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 32; i++) result += chars[Math.floor(Math.random() * chars.length)];
  return result;
}

const DEFAULT_VIEWPORT: Viewport = { w: 1280, h: 720 };

// How long after the last unresolved-asset report to wait before triggering extraction.
const EXTRACT_DEBOUNCE_MS = 300;

export class ScryerPanel {
  static readonly viewType = "scryer.preview";

  private readonly panel: vscode.WebviewPanel;
  private readonly output: vscode.LogOutputChannel;
  private readonly context: vscode.ExtensionContext;
  private disposables: vscode.Disposable[] = [];
  private assets: AssetService;

  // rawPath → addonDir for textures that could not be resolved in the current render cycle.
  private missingPaths = new Map<string, string>();
  // Set while the extract-and-retry pass is running; suppresses re-queuing failed retries.
  private retryInProgress = false;
  private extractDebounce: ReturnType<typeof setTimeout> | undefined;
  // True once the Blizzard addon extraction attempt has finished for this asset service
  // instance; prevents the "pending fetches" label from flickering on every re-render.
  private blizzardExtractionDone = false;
  // Paths already attempted for extraction; prevents re-queuing on subsequent re-renders
  // when extraction produced no result (e.g. file not in CASC data store).
  private extractionTriedPaths = new Set<string>();

  static create(context: vscode.ExtensionContext, uri: vscode.Uri): ScryerPanel {
    const column = vscode.window.activeTextEditor
      ? vscode.ViewColumn.Beside
      : vscode.ViewColumn.One;

    const output = vscode.window.createOutputChannel("Scryer", { log: true });
    const assets = AssetService.fromConfig(context, output);

    const panel = vscode.window.createWebviewPanel(
      ScryerPanel.viewType,
      `Scryer: ${uri.path.split("/").pop() ?? "Preview"}`,
      column,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, "dist"),
          ...assets.webviewResourceRoots(),
        ],
        retainContextWhenHidden: true,
      },
    );

    return new ScryerPanel(panel, context, uri, output, assets);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    uri: vscode.Uri,
    output: vscode.LogOutputChannel,
    assets: AssetService,
  ) {
    this.panel = panel;
    this.context = context;
    this.output = output;
    this.assets = assets;
    this.panel.webview.html = this.buildHtml();

    this.panel.webview.onDidReceiveMessage(
      (message: unknown) => this.handleWebviewMessage(message, uri),
      null,
      this.disposables,
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // Re-resolve assets when config changes (new extractedAssetsDir etc.)
    vscode.workspace.onDidChangeConfiguration(
      (e) => {
        if (e.affectsConfiguration("scryer")) {
          this.assets = AssetService.fromConfig(this.context, this.output);
          this.blizzardExtractionDone = false;
          this.extractionTriedPaths.clear();
        }
      },
      null,
      this.disposables,
    );
  }

  private handleWebviewMessage(message: unknown, uri: vscode.Uri): void {
    if (typeof message !== "object" || !message) return;
    const msg = message as { type: string; path?: string; atlas?: string };

    switch (msg.type) {
      case "ready":
        void this.renderFile(uri);
        break;

      case "requestAsset":
        if (msg.path) {
          void this.resolveAndSendAsset(msg.path, path.dirname(uri.fsPath));
        }
        break;
    }
  }

  private logLevel(): vscode.LogLevel {
    const s = vscode.workspace.getConfiguration("scryer").get<string>("logLevel") ?? "warning";
    const map: Record<string, vscode.LogLevel> = {
      off: vscode.LogLevel.Off,
      trace: vscode.LogLevel.Trace,
      debug: vscode.LogLevel.Debug,
      info: vscode.LogLevel.Info,
      warning: vscode.LogLevel.Warning,
      error: vscode.LogLevel.Error,
    };
    return map[s] ?? vscode.LogLevel.Warning;
  }

  private isEnabled(messageLevel: vscode.LogLevel): boolean {
    const l = this.logLevel();
    return l !== vscode.LogLevel.Off && l <= messageLevel;
  }

  private async resolveAndSendAsset(rawPath: string, addonDir: string): Promise<void> {
    const absPath = await this.assets.resolveToAbsPath(rawPath, addonDir);
    if (!absPath) {
      if (this.isEnabled(vscode.LogLevel.Warning)) {
        this.output.warn(
          `Asset not found: ${rawPath} — configure scryer.extractedAssetsDir to load real textures.`,
        );
      }
      if (!this.retryInProgress && !this.extractionTriedPaths.has(rawPath)) {
        this.missingPaths.set(rawPath, addonDir);
        this.scheduleMissingExtract();
      }
      return;
    }

    const uri = this.panel.webview.asWebviewUri(vscode.Uri.file(absPath)).toString();
    const msg: HostMessage = { type: "assetResolved", path: rawPath, uri };
    void this.panel.webview.postMessage(msg);
  }

  private scheduleMissingExtract(): void {
    if (this.extractDebounce !== undefined) clearTimeout(this.extractDebounce);
    this.extractDebounce = setTimeout(() => {
      this.extractDebounce = undefined;
      void this.runExtractAndRetry();
    }, EXTRACT_DEBOUNCE_MS);
  }

  private async runExtractAndRetry(): Promise<void> {
    const batch = new Map(this.missingPaths);
    this.missingPaths.clear();
    if (batch.size === 0) return;

    await this.assets.extractMissing(Array.from(batch.keys()));
    // Use lightweight invalidation: picks up newly extracted files without resetting
    // blizzardFilesEnsured or the registry cache, preventing a re-extraction loop.
    this.assets.invalidateTextures();

    this.retryInProgress = true;
    try {
      await Promise.all(
        Array.from(batch).map(([rawPath, addonDir]) => this.resolveAndSendAsset(rawPath, addonDir)),
      );
    } finally {
      this.retryInProgress = false;
      // Mark all attempted paths so future re-renders don't re-queue them.
      for (const rawPath of batch.keys()) this.extractionTriedPaths.add(rawPath);
    }
  }

  async renderFile(uri: vscode.Uri): Promise<void> {
    // Reset missing-path state for the new render cycle.
    if (this.extractDebounce !== undefined) {
      clearTimeout(this.extractDebounce);
      this.extractDebounce = undefined;
    }
    this.missingPaths.clear();

    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const content = Buffer.from(bytes).toString("utf-8");
      const doc = parseXmlFile(uri.fsPath, content);

      // Kick off Blizzard addon file extraction if needed, but don't block the render.
      // On the first attempt, always re-render when done: if extraction succeeded,
      // templates will be available; if it failed, the status needs to flip from
      // "pending fetches" to "warning(s)". Subsequent renders skip this entirely.
      const isFirstExtraction = !this.blizzardExtractionDone;
      if (isFirstExtraction) {
        void this.assets.ensureBlizzardFiles().then((extracted) => {
          this.blizzardExtractionDone = true;
          if (extracted) this.assets.invalidate();
          void this.renderFile(uri);
        });
      }

      // Load Blizzard template registry (disk-cached; fast after first parse).
      const blizzardRegistry = this.assets.loadBlizzardTemplates();
      if (this.isEnabled(vscode.LogLevel.Debug)) {
        this.output.debug(`Blizzard registry: ${blizzardRegistry.size} templates`);
      }

      const warnCb = this.isEnabled(vscode.LogLevel.Warning)
        ? (msg: string) => this.output.warn(msg)
        : undefined;

      const warns = { count: 0 };
      const [resolved] = resolveInheritance([doc], blizzardRegistry, {
        warnings: warns,
        pending: isFirstExtraction,
        warn: warnCb,
      });
      if (!resolved) return;

      const renderFrames = resolved.frames.filter((f) => !f.virtual);
      const addonDir = path.dirname(uri.fsPath);
      const texturePaths = collectTexturePaths(renderFrames);

      if (this.isEnabled(vscode.LogLevel.Debug)) {
        this.output.debug(`Render: ${renderFrames.length} frames, ${texturePaths.length} textures`);
        for (const frame of renderFrames) {
          if (frame.templateChain.length > 0) {
            this.output.debug(
              `  ${frame.name ?? "<anonymous>"}: inherits [${frame.templateChain.filter(Boolean).join(" → ")}]`,
            );
          }
        }
      }

      const msg: HostMessage = {
        type: "render",
        frames: renderFrames,
        viewport: DEFAULT_VIEWPORT,
        warnings: warns.count,
        extractionPending: isFirstExtraction,
        pendingFiles: isFirstExtraction ? texturePaths.length : 0,
      };

      void this.panel.webview.postMessage(msg);

      // Proactively queue all texture paths found in the resolved frame tree.
      // This triggers extraction for the full inheritance stack up-front rather
      // than waiting for the webview to request them one at a time.
      for (const rawPath of texturePaths) {
        void this.resolveAndSendAsset(rawPath, addonDir);
      }
    } catch (err) {
      if (this.isEnabled(vscode.LogLevel.Error)) {
        this.output.error(`Error rendering ${uri.fsPath}: ${String(err)}`);
        this.output.show(true);
      }
    }
  }

  private buildHtml(): string {
    const webview = this.panel.webview;
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js"),
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
    if (this.extractDebounce !== undefined) {
      clearTimeout(this.extractDebounce);
    }
    this.output.dispose();
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
