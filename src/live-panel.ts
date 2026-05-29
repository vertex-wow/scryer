import * as path from "path";
import * as vscode from "vscode";
import { AssetService } from "./assets/index.js";
import type { AtlasManifest } from "./assets/atlas-manifest.js";
import { parseToc } from "./parser/toc.js";
import { createSandbox } from "./lua/sandbox.js";
import { registerWowApi, VirtualClock } from "./lua/wow-api.js";
import { registerFrameModel } from "./lua/createframe.js";
import { FrameRegistry } from "./lua/frame-registry.js";
import { runTocAddon } from "./lua/toc-runner.js";
import { resolveFlavorConfig } from "./flavors/config.js";
import type { HostMessage, Viewport } from "./protocol.js";
import type { FrameIR, TextureIR } from "./parser/ir.js";

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 32; i++) result += chars[Math.floor(Math.random() * chars.length)];
  return result;
}

/** Strip WoW color codes like |cAARRGGBBtext|r from a string. */
function stripWowColorCodes(s: string): string {
  return s.replace(/\|c[0-9a-fA-F]{8}(.*?)\|r/g, "$1").replace(/\|c[0-9a-fA-F]{8}/g, "");
}

const RENDER_DEBOUNCE_MS = 400;
const EXTRACT_DEBOUNCE_MS = 300;

// ---------------------------------------------------------------------------
// Atlas name resolution (identical to panel.ts)
// ---------------------------------------------------------------------------

function resolveAtlasInTexture(tex: TextureIR, manifest: AtlasManifest): void {
  if (!tex.atlas) return;
  const lower = tex.atlas.toLowerCase();
  const entry = manifest[tex.atlas] ?? manifest[lower] ?? manifest[lower + "-2x"];
  if (!entry) return;
  tex.resolvedAtlas = {
    file: entry.file,
    x: entry.x,
    y: entry.y,
    width: entry.width,
    height: entry.height,
    sheetW: entry.sheetW,
    sheetH: entry.sheetH,
    tilesH: entry.tilesH,
    tilesV: entry.tilesV,
  };
}

function resolveAtlasInFrame(frame: FrameIR, manifest: AtlasManifest): void {
  for (const layer of frame.layers) {
    for (const obj of layer.objects) {
      if (obj.kind === "Texture" || obj.kind === "MaskTexture") {
        resolveAtlasInTexture(obj as TextureIR, manifest);
      }
    }
  }
  for (const child of frame.children) {
    resolveAtlasInFrame(child, manifest);
  }
}

function resolveAtlasNames(frames: FrameIR[], manifest: AtlasManifest): void {
  for (const frame of frames) resolveAtlasInFrame(frame, manifest);
}

function collectTexturePaths(frames: FrameIR[]): string[] {
  const paths: string[] = [];
  function walk(frame: FrameIR): void {
    for (const layer of frame.layers) {
      for (const obj of layer.objects) {
        if ((obj.kind === "Texture" || obj.kind === "MaskTexture") && (obj as TextureIR).file) {
          paths.push((obj as TextureIR).file!);
        }
      }
    }
    for (const child of frame.children) walk(child);
  }
  for (const f of frames) walk(f);
  return paths;
}

// ---------------------------------------------------------------------------

export class ScryerLivePanel {
  static readonly viewType = "scryer.live";

  private readonly panel: vscode.WebviewPanel;
  private readonly output: vscode.LogOutputChannel;
  private readonly context: vscode.ExtensionContext;
  private readonly statusBar: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];
  private assets: AssetService;

  private missingPaths = new Map<string, string>();
  private retryInProgress = false;
  private extractDebounce: ReturnType<typeof setTimeout> | undefined;
  private renderDebounce: ReturnType<typeof setTimeout> | undefined;
  private extractionTriedPaths = new Set<string>();

  static create(
    context: vscode.ExtensionContext,
    uri: vscode.Uri,
    assets: AssetService,
    output: vscode.LogOutputChannel,
  ): ScryerLivePanel {
    const column = vscode.window.activeTextEditor
      ? vscode.ViewColumn.Beside
      : vscode.ViewColumn.One;

    const panel = vscode.window.createWebviewPanel(
      ScryerLivePanel.viewType,
      `Scryer Live: ${uri.path.split("/").pop() ?? "Preview"}`,
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

    return new ScryerLivePanel(panel, context, uri, output, assets);
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

    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.statusBar.command = "scryer.toggleRuler";
    this.statusBar.tooltip = "Toggle pixel ruler overlay";
    this.updateStatusBar();
    this.statusBar.show();
    this.disposables.push(this.statusBar);

    this.panel.webview.html = this.buildHtml();

    this.panel.webview.onDidReceiveMessage(
      (message: unknown) => this.handleWebviewMessage(message, uri),
      null,
      this.disposables,
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    vscode.workspace.onDidChangeConfiguration(
      (e) => {
        if (e.affectsConfiguration("scryer")) {
          this.assets.invalidate();
          this.extractionTriedPaths.clear();
        }
        if (e.affectsConfiguration("scryer.showRuler")) {
          this.updateStatusBar();
          void this.panel.webview.postMessage(this.rulerMessage());
        }
      },
      null,
      this.disposables,
    );

    // Re-render when any .lua, .xml, or .toc file in the addon directory changes.
    const addonDir = path.normalize(path.dirname(uri.fsPath));
    vscode.workspace.onDidChangeTextDocument(
      (e) => {
        const docPath = e.document.uri.fsPath;
        const ext = path.extname(docPath).toLowerCase();
        if (
          (ext === ".lua" || ext === ".xml" || ext === ".toc") &&
          path.normalize(path.dirname(docPath)) === addonDir
        ) {
          if (this.renderDebounce !== undefined) clearTimeout(this.renderDebounce);
          this.renderDebounce = setTimeout(() => {
            this.renderDebounce = undefined;
            void this.runAndRender(uri);
          }, RENDER_DEBOUNCE_MS);
        }
      },
      null,
      this.disposables,
    );

    // Update panel title once the TOC is parsed (async, best-effort)
    void this.updateTitle(uri);
  }

  private async updateTitle(uri: vscode.Uri): Promise<void> {
    try {
      const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf-8");
      const toc = parseToc(content, uri.fsPath);
      if (toc.title) {
        this.panel.title = `Scryer: ${stripWowColorCodes(toc.title)}`;
      }
    } catch {
      // Non-fatal — panel title stays as filename
    }
  }

  private rulerMessage(): HostMessage {
    const show = vscode.workspace.getConfiguration("scryer").get<boolean>("showRuler") ?? true;
    return { type: "setRuler", show };
  }

  private updateStatusBar(): void {
    const show = vscode.workspace.getConfiguration("scryer").get<boolean>("showRuler") ?? true;
    this.statusBar.text = `📏 ${show ? "ON" : "OFF"}`;
  }

  private handleWebviewMessage(message: unknown, uri: vscode.Uri): void {
    if (typeof message !== "object" || !message) return;
    const msg = message as { type: string; path?: string };

    switch (msg.type) {
      case "ready":
        void this.runAndRender(uri);
        break;

      case "requestAsset":
        if (msg.path) {
          void this.resolveAndSendAsset(msg.path, path.dirname(uri.fsPath));
        }
        break;

      case "toggleRuler": {
        const cfg = vscode.workspace.getConfiguration("scryer");
        const current = cfg.get<boolean>("showRuler") ?? true;
        void cfg.update("showRuler", !current, vscode.ConfigurationTarget.Workspace);
        break;
      }
    }
  }

  private async resolveAndSendAsset(rawPath: string, addonDir: string): Promise<void> {
    const absPath = await this.assets.resolveToAbsPath(rawPath, addonDir);
    if (!absPath) {
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
    this.assets.invalidateTextures();

    this.retryInProgress = true;
    try {
      await Promise.all(
        Array.from(batch).map(([rawPath, addonDir]) => this.resolveAndSendAsset(rawPath, addonDir)),
      );
    } finally {
      this.retryInProgress = false;
      for (const rawPath of batch.keys()) this.extractionTriedPaths.add(rawPath);
    }
  }

  async runAndRender(uri: vscode.Uri): Promise<void> {
    if (this.extractDebounce !== undefined) {
      clearTimeout(this.extractDebounce);
      this.extractDebounce = undefined;
    }
    this.missingPaths.clear();

    const cfg = vscode.workspace.getConfiguration("scryer");
    const flavor = cfg.get<string>("flavor") ?? "retail";
    const userConfigPath = cfg.get<string>("flavorConfigPath") || undefined;
    const flavorConfig = resolveFlavorConfig(flavor, userConfigPath);

    try {
      // Read the TOC file
      const tocContent = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf-8");
      const toc = parseToc(tocContent, uri.fsPath);
      const addonDir = path.dirname(uri.fsPath);

      // Build a fresh sandbox + registry for each render cycle
      const wasmPath = vscode.Uri.joinPath(this.context.extensionUri, "dist", "glue.wasm").fsPath;
      const registry = new FrameRegistry(flavorConfig.uiParentWidth, flavorConfig.uiParentHeight);
      const clock = new VirtualClock();
      const sandbox = await createSandbox(wasmPath);

      try {
        await registerWowApi(sandbox, {
          clock,
          print: (msg) => this.output.info(`[Lua] ${msg}`),
          isAddonLoaded: () => true,
          getAddonMetadata: (name, key) => {
            if (
              name.toLowerCase() ===
              path.basename(toc.sourceFile, path.extname(toc.sourceFile)).toLowerCase()
            ) {
              return toc.rawMeta[key] ?? null;
            }
            return null;
          },
        });

        await registerFrameModel(sandbox, registry);

        // Load blizzard templates (disk-cached; fast after first parse)
        const blizzardTemplates = this.assets.loadBlizzardTemplates();

        // Run the TOC load sequence
        await runTocAddon({
          toc,
          addonDir,
          sandbox,
          blizzardTemplates,
          readFile: async (absPath) => {
            // Prefer open document buffer (unsaved changes) over disk
            const docUri = vscode.Uri.file(absPath);
            const openDoc = vscode.workspace.textDocuments.find(
              (d) => d.uri.toString() === docUri.toString(),
            );
            if (openDoc) return openDoc.getText();
            return Buffer.from(await vscode.workspace.fs.readFile(docUri)).toString("utf-8");
          },
          output: {
            info: (msg) => this.output.info(msg),
            warn: (msg) => this.output.warn(msg),
            error: (msg) => this.output.error(msg),
          },
        });

        // Advance clock one tick to fire any immediate timers (C_Timer.After(0, ...))
        clock.advance(0.001);
      } finally {
        sandbox.global.close();
      }

      // Serialize frame tree → FrameIR[]
      registry.clearDirty();
      const frames = registry.serialize();

      // Resolve atlas names
      const atlasManifest = this.assets.loadAtlasManifest();
      if (atlasManifest) resolveAtlasNames(frames, atlasManifest);

      const texturePaths = collectTexturePaths(frames);

      // Resolve default font
      let defaultFontUri: string | undefined;
      if (flavorConfig.defaultFont) {
        const fontAbsPath = await this.assets.resolveToAbsPath(flavorConfig.defaultFont, "");
        if (fontAbsPath) {
          defaultFontUri = this.panel.webview.asWebviewUri(vscode.Uri.file(fontAbsPath)).toString();
        }
      }

      const viewport: Viewport = { w: flavorConfig.uiParentWidth, h: flavorConfig.uiParentHeight };

      const msg: HostMessage = {
        type: "render",
        frames,
        viewport,
        warnings: 0,
        extractionPending: false,
        pendingFiles: 0,
        flavorConfig,
        defaultFontUri,
      };

      void this.panel.webview.postMessage(msg);
      void this.panel.webview.postMessage(this.rulerMessage());

      for (const rawPath of texturePaths) {
        void this.resolveAndSendAsset(rawPath, addonDir);
      }

      this.output.debug(
        `[Live] rendered ${frames.length} root frame(s), ${texturePaths.length} textures`,
      );
    } catch (err) {
      this.output.error(`[Live] Error running ${uri.fsPath}: ${String(err)}`);
      this.output.show(true);
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
      `font-src ${webview.cspSource}`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    const cfg = vscode.workspace.getConfiguration("scryer");
    const flavor = cfg.get<string>("flavor") ?? "retail";
    const userConfigPath = cfg.get<string>("flavorConfigPath") || undefined;
    const c = resolveFlavorConfig(flavor, userConfigPath);

    const BP = 8;
    const sbH = c.statusBarHeight;
    const rsz = c.rulerSize;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Scryer Live</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:${c.rulerBg};display:flex;flex-direction:column;align-items:flex-start;padding:${BP}px;padding-top:${sbH + BP}px;overflow:auto}
    #viewport{position:relative}
    #status-bar{position:fixed;top:0;left:0;right:0;height:${sbH}px;background:${c.statusBarBg};display:flex;align-items:center;z-index:10001;border-bottom:1px solid ${c.rulerBorder};font:${c.statusBarFont};color:${c.statusBarColor};white-space:nowrap;overflow:hidden}
    #ruler-toggle{flex-shrink:0;background:none;border:none;border-right:1px solid ${c.rulerBorder};cursor:pointer;font:14px/${sbH}px system-ui;padding:0 5px;height:${sbH}px}
    #ruler-toggle:hover{background:#2e2e2e}
    .ruler-icon{filter:sepia(1) saturate(8) hue-rotate(-30deg) brightness(0.85);display:inline-block}
    #ruler-toggle:hover .ruler-icon{filter:sepia(1) saturate(8) hue-rotate(-30deg) brightness(1.1)}
    #debug{padding:0 4px;white-space:pre-wrap}
    #ruler-top{position:fixed;top:${sbH}px;left:0;right:0;height:${rsz}px;z-index:9999;display:none}
    #ruler-left{position:fixed;top:${sbH}px;left:0;bottom:0;width:${rsz}px;z-index:9999;display:none}
    #ruler-corner{position:fixed;top:${sbH}px;left:0;width:${rsz}px;height:${rsz}px;z-index:10000;background:${c.rulerBg};border-right:1px solid ${c.rulerBorder};border-bottom:1px solid ${c.rulerBorder};display:none}
    body.show-ruler{padding-top:${sbH + rsz + BP}px;padding-left:${rsz + BP}px}
    body.show-ruler #ruler-top,body.show-ruler #ruler-left,body.show-ruler #ruler-corner{display:block}
  </style>
</head>
<body>
  <div id="status-bar">
    <button id="ruler-toggle" title="Toggle pixel ruler"><span class="ruler-icon">📏</span></button>
    <span id="debug">script not yet loaded</span>
  </div>
  <div id="viewport"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    if (this.extractDebounce !== undefined) clearTimeout(this.extractDebounce);
    if (this.renderDebounce !== undefined) clearTimeout(this.renderDebounce);
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
