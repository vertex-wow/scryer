import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { AssetService } from "./assets/index.js";
import type { AtlasManifest } from "./assets/atlas-manifest.js";
import { parseXmlFile } from "./parser/index.js";
import { resolveInheritance } from "./parser/inherit.js";
import { collectTexturePaths } from "./parser/collect-textures.js";
import type { FrameIR, TextureIR } from "./parser/ir.js";
import { resolveFlavorConfig } from "./flavors/config.js";
import type { HostMessage, Viewport } from "./protocol.js";

// Minimal surface of the vscode.git extension API needed to check gitignore status.
interface GitRepo {
  checkIgnore(paths: string[]): Promise<Set<string>>;
}
interface GitApi {
  getRepository(uri: vscode.Uri): GitRepo | null;
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 32; i++) result += chars[Math.floor(Math.random() * chars.length)];
  return result;
}

// How long after the last unresolved-asset report to wait before triggering extraction.
const EXTRACT_DEBOUNCE_MS = 300;

// ---------------------------------------------------------------------------
// Atlas name resolution
// ---------------------------------------------------------------------------

function resolveAtlasInTexture(tex: TextureIR, manifest: AtlasManifest): void {
  if (!tex.atlas) return;
  const origLower = tex.atlas.toLowerCase();
  const stripped = tex.atlas.replace(/^[_!]+/, "");
  const strippedLower = stripped.toLowerCase();
  const entry =
    manifest[tex.atlas] ??
    manifest[origLower] ??
    manifest[stripped] ??
    manifest[strippedLower] ??
    manifest[strippedLower + "-2x"];
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
  for (const tex of [
    frame.normalTexture,
    frame.pushedTexture,
    frame.disabledTexture,
    frame.highlightTexture,
  ]) {
    if (tex) resolveAtlasInTexture(tex, manifest);
  }
  for (const child of frame.children) {
    resolveAtlasInFrame(child, manifest);
  }
}

function resolveAtlasNames(frames: FrameIR[], manifest: AtlasManifest): void {
  for (const frame of frames) {
    resolveAtlasInFrame(frame, manifest);
  }
}
// How long after the last document change to wait before re-rendering in current-file mode.
const RENDER_DEBOUNCE_MS = 300;

export class ScryerPanel {
  static readonly viewType = "scryer.preview";

  private readonly panel: vscode.WebviewPanel;
  private readonly output: vscode.LogOutputChannel;
  private readonly context: vscode.ExtensionContext;
  private readonly statusBar: vscode.StatusBarItem;
  private readonly installDirBar: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];
  private assets: AssetService;

  // rawPath → addonDir for textures that could not be resolved in the current render cycle.
  private missingPaths = new Map<string, string>();
  // Set while the extract-and-retry pass is running; suppresses re-queuing failed retries.
  private retryInProgress = false;
  private extractDebounce: ReturnType<typeof setTimeout> | undefined;
  private renderDebounce: ReturnType<typeof setTimeout> | undefined;
  // True once the Blizzard addon extraction attempt has finished for this asset service
  // instance; prevents the "pending fetches" label from flickering on every re-render.
  private blizzardExtractionDone = false;
  // True once the workspace-wide texture pre-warm has been kicked off for this panel.
  private workspacePrewarmDone = false;
  // True once atlas manifest generation has been attempted for this panel lifetime.
  private atlasGenDone = false;
  // Paths already attempted for extraction; prevents re-queuing on subsequent re-renders
  // when extraction produced no result (e.g. file not in CASC data store).
  private extractionTriedPaths = new Set<string>();

  static create(
    context: vscode.ExtensionContext,
    uri: vscode.Uri,
    assets: AssetService,
    output: vscode.LogOutputChannel,
  ): ScryerPanel {
    const column = vscode.window.activeTextEditor
      ? vscode.ViewColumn.Beside
      : vscode.ViewColumn.One;

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

    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.statusBar.command = "scryer.toggleRuler";
    this.statusBar.tooltip = "Toggle pixel ruler overlay";
    this.updateStatusBar();
    this.statusBar.show();
    this.disposables.push(this.statusBar);

    this.installDirBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 91);
    this.installDirBar.command = {
      command: "workbench.action.openSettings",
      title: "Open Settings",
      arguments: ["@id:scryer.installDir"],
    };
    this.installDirBar.text = "$(warning) Scryer: set installDir";
    this.installDirBar.tooltip =
      "scryer.installDir is not set — extraction is disabled. Click to configure.";
    this.installDirBar.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    this.disposables.push(this.installDirBar);
    this.updateInstallDirBar();

    this.panel.webview.html = this.buildHtml();

    this.panel.webview.onDidReceiveMessage(
      (message: unknown) => this.handleWebviewMessage(message, uri),
      null,
      this.disposables,
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // Re-resolve assets and propagate setting changes to the webview.
    vscode.workspace.onDidChangeConfiguration(
      (e) => {
        if (e.affectsConfiguration("scryer")) {
          this.assets.invalidate();
          this.blizzardExtractionDone = false;
          this.workspacePrewarmDone = false;
          this.atlasGenDone = false;
          this.extractionTriedPaths.clear();
        }
        if (e.affectsConfiguration("scryer.showRuler")) {
          this.updateStatusBar();
          void this.panel.webview.postMessage(this.rulerMessage());
        }
        if (e.affectsConfiguration("scryer.installDir")) {
          this.updateInstallDirBar();
        }
      },
      null,
      this.disposables,
    );

    // In current-file mode, re-render whenever the document buffer changes.
    vscode.workspace.onDidChangeTextDocument(
      (e) => {
        if (
          e.document.uri.toString() === uri.toString() &&
          vscode.workspace.getConfiguration("scryer").get<string>("userAddonPreload") ===
            "current-file"
        ) {
          if (this.renderDebounce !== undefined) clearTimeout(this.renderDebounce);
          this.renderDebounce = setTimeout(() => {
            this.renderDebounce = undefined;
            void this.renderFile(uri);
          }, RENDER_DEBOUNCE_MS);
        }
      },
      null,
      this.disposables,
    );
  }

  private rulerMessage(): HostMessage {
    const show = vscode.workspace.getConfiguration("scryer").get<boolean>("showRuler") ?? true;
    return { type: "setRuler", show };
  }

  private updateStatusBar(): void {
    const show = vscode.workspace.getConfiguration("scryer").get<boolean>("showRuler") ?? true;
    this.statusBar.text = `📏 ${show ? "ON" : "OFF"}`;
  }

  private updateInstallDirBar(): void {
    const installDir = vscode.workspace.getConfiguration("scryer").get<string>("installDir") ?? "";
    if (installDir) {
      this.installDirBar.hide();
    } else {
      this.installDirBar.show();
    }
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

      case "toggleRuler": {
        const cfg = vscode.workspace.getConfiguration("scryer");
        const current = cfg.get<boolean>("showRuler") ?? true;
        void cfg.update("showRuler", !current, vscode.ConfigurationTarget.Workspace);
        break;
      }

      case "dbg":
        this.output.trace(`status: ${(message as { type: string; text?: string }).text ?? ""}`);
        break;
    }
  }

  private async resolveAndSendAsset(rawPath: string, addonDir: string): Promise<void> {
    const absPath = await this.assets.resolveToAbsPath(rawPath, addonDir);
    if (!absPath) {
      this.output.warn(`Asset not found: ${rawPath}`);
      if (!this.retryInProgress && !this.extractionTriedPaths.has(rawPath)) {
        this.missingPaths.set(rawPath, addonDir);
        this.scheduleMissingExtract();
      }
      return;
    }

    try {
      const uri = this.panel.webview.asWebviewUri(vscode.Uri.file(absPath)).toString();
      const msg: HostMessage = { type: "assetResolved", path: rawPath, uri };
      void this.panel.webview.postMessage(msg);
    } catch {
      // Panel was disposed before the asset resolved — nothing to update.
    }
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

    const cfg = vscode.workspace.getConfiguration("scryer");
    const preloadMode = cfg.get<string>("userAddonPreload") ?? "on-demand";
    const flavor = cfg.get<string>("flavor") ?? "retail";
    const userConfigPath = cfg.get<string>("flavorConfigPath") || undefined;
    const flavorConfig = resolveFlavorConfig(flavor, userConfigPath);
    this.output.trace(
      `param viewport: UIParent ${flavorConfig.uiParentWidth}×${flavorConfig.uiParentHeight} (screen ${flavorConfig.screenWidth}×${flavorConfig.screenHeight})`,
    );

    try {
      let content: string;
      if (preloadMode === "current-file") {
        const openDoc = vscode.workspace.textDocuments.find(
          (d) => d.uri.toString() === uri.toString(),
        );
        content = openDoc
          ? openDoc.getText()
          : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf-8");
      } else {
        content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf-8");
      }
      const doc = parseXmlFile(uri.fsPath, content);

      // Kick off Blizzard addon file extraction if needed, but don't block the render.
      // isFirstExtraction is only true when extraction hasn't run this session yet — this
      // prevents "pending" UI and a redundant re-render on subsequent panel opens where
      // the shared AssetService already settled which files are present.
      const isFirstExtraction =
        !this.blizzardExtractionDone && !this.assets.hasBlizzardExtractionRun();
      if (!this.blizzardExtractionDone) {
        void this.assets.ensureBlizzardFiles().then((extracted) => {
          this.blizzardExtractionDone = true;
          if (extracted) {
            this.assets.invalidateAfterBlizzardExtraction();
            // Extraction downloads the listfile as a side effect — allow atlas
            // manifest generation to retry on the upcoming re-render.
            this.atlasGenDone = false;
          }
          // Re-render to flip pending state or pick up newly extracted templates.
          // Skipped when isFirstExtraction was false (files already known present).
          if (isFirstExtraction) void this.renderFile(uri);
        });
      }

      // Ensure atlas manifest exists; generate from wago.tools if absent.
      // Non-blocking: triggers a re-render only when a manifest is newly created.
      if (!this.atlasGenDone && !this.assets.hasAtlasManifestRun()) {
        this.atlasGenDone = true;
        void this.assets.ensureAtlasManifest().then((generated) => {
          if (generated) void this.renderFile(uri);
        });
      }

      // Load Blizzard template registry (disk-cached; fast after first parse).
      const blizzardRegistry = this.assets.loadBlizzardTemplates();
      this.output.debug(
        `  Blizzard registry: ${blizzardRegistry.size} template${blizzardRegistry.size === 1 ? "" : "s"}`,
      );

      const warnCb = (msg: string) => this.output.warn(msg);

      const warns = { count: 0 };
      const [resolved] = resolveInheritance([doc], blizzardRegistry, {
        warnings: warns,
        pending: isFirstExtraction,
        warn: warnCb,
      });
      if (!resolved) return;

      const renderFrames = resolved.frames.filter((f) => !f.virtual);
      const addonDir = path.dirname(uri.fsPath);

      // Resolve atlas names from the manifest before collecting paths or sending IR.
      const atlasManifest = this.assets.loadAtlasManifest();
      if (atlasManifest) resolveAtlasNames(renderFrames, atlasManifest);

      const texturePaths = collectTexturePaths(renderFrames);

      this.output.debug(
        `  Render: ${renderFrames.length} frame${renderFrames.length === 1 ? "" : "s"}, ${texturePaths.length} texture${texturePaths.length === 1 ? "" : "s"}`,
      );
      for (const frame of renderFrames) {
        if (frame.templateChain.length > 0) {
          this.output.debug(
            `  ${frame.name ?? "<anonymous>"}: inherits [${frame.templateChain.filter(Boolean).join(" → ")}]`,
          );
        }
      }

      const viewport: Viewport = {
        w: flavorConfig.uiParentWidth,
        h: flavorConfig.uiParentHeight,
      };

      // Resolve the default font from the asset cache so the webview can inject @font-face.
      // If not cached yet, kick off extraction non-blocking and deliver via "fontResolved"
      // so that the render is not delayed and a spurious re-render is not triggered later.
      let defaultFontUri: string | undefined;
      if (flavorConfig.defaultFont) {
        const fontAbsPath = await this.assets.resolveToAbsPath(flavorConfig.defaultFont, "");
        if (fontAbsPath) {
          defaultFontUri = this.panel.webview.asWebviewUri(vscode.Uri.file(fontAbsPath)).toString();
        } else if (this.assets.claimExtraction(flavorConfig.defaultFont)) {
          void this.extractAndSendFont(flavorConfig.defaultFont);
        }
      }

      const msg: HostMessage = {
        type: "render",
        frames: renderFrames,
        viewport,
        warnings: warns.count,
        extractionPending: isFirstExtraction,
        pendingFiles: isFirstExtraction ? texturePaths.length : 0,
        flavorConfig,
        defaultFontUri,
      };

      void this.panel.webview.postMessage(msg);
      void this.panel.webview.postMessage(this.rulerMessage());

      // When userAddonPreload is "saved-file" or "current-file", proactively resolve and
      // decode all textures found in the frame tree so they hit the PNG cache before the
      // webview requests them. "on-demand" skips this and lets the webview drive
      // resolution via requestAsset messages instead.
      if (preloadMode !== "on-demand") {
        for (const rawPath of texturePaths) {
          void this.resolveAndSendAsset(rawPath, addonDir);
        }
      }

      // "workspace" extends the pre-warm to every WoW XML file in the workspace.
      // Kicked off once per panel lifetime so re-renders don't repeat the scan.
      if (preloadMode === "workspace" && !this.workspacePrewarmDone) {
        this.workspacePrewarmDone = true;
        void this.prewarmWorkspace(uri, blizzardRegistry);
      }
    } catch (err) {
      this.output.error(`Error rendering ${uri.fsPath}: ${String(err)}`);
      this.output.show(true);
    }
  }

  /** Returns uris with gitignored paths removed. Falls back to the full list on any error. */
  private async filterGitIgnored(uris: vscode.Uri[]): Promise<vscode.Uri[]> {
    try {
      const ext = vscode.extensions.getExtension<{ getAPI(v: number): GitApi }>("vscode.git");
      if (!ext) return uris;
      if (!ext.isActive) await ext.activate();
      const git = ext.exports.getAPI(1);

      // Group URIs by repository so we can batch each checkIgnore call.
      const byRepo = new Map<GitRepo, vscode.Uri[]>();
      const repoless: vscode.Uri[] = [];
      for (const uri of uris) {
        const repo = git.getRepository(uri);
        if (!repo) {
          repoless.push(uri);
        } else {
          const list = byRepo.get(repo) ?? [];
          list.push(uri);
          byRepo.set(repo, list);
        }
      }

      const kept: vscode.Uri[] = [...repoless];
      for (const [repo, repoUris] of byRepo) {
        const checkable: vscode.Uri[] = [];
        for (const uri of repoUris) {
          try {
            if (fs.realpathSync(uri.fsPath) === uri.fsPath) checkable.push(uri);
            else kept.push(uri); // under a symlink — treat as not ignored
          } catch {
            checkable.push(uri);
          }
        }
        if (checkable.length === 0) continue;
        const ignored = await repo.checkIgnore(checkable.map((u) => u.fsPath));
        for (const uri of checkable) {
          if (!ignored.has(uri.fsPath)) kept.push(uri);
        }
      }
      return kept;
    } catch {
      return uris; // git extension unavailable; proceed unfiltered
    }
  }

  private async prewarmWorkspace(
    currentUri: vscode.Uri,
    blizzardRegistry: Map<string, FrameIR>,
  ): Promise<void> {
    const allXmlFiles = await vscode.workspace.findFiles("**/*.xml");
    const xmlFiles = await this.filterGitIgnored(allXmlFiles);
    for (const xmlUri of xmlFiles) {
      if (xmlUri.toString() === currentUri.toString()) continue; // already rendered
      try {
        const bytes = await vscode.workspace.fs.readFile(xmlUri);
        const content = Buffer.from(bytes).toString("utf-8");
        const doc = parseXmlFile(xmlUri.fsPath, content);
        const [resolved] = resolveInheritance([doc], blizzardRegistry, {
          warnings: { count: 0 },
        });
        if (!resolved) continue;
        const frames = resolved.frames.filter((f) => !f.virtual);
        const addonDir = path.dirname(xmlUri.fsPath);
        for (const rawPath of collectTexturePaths(frames)) {
          void this.resolveAndSendAsset(rawPath, addonDir);
        }
      } catch {
        // Not a WoW addon XML file; skip silently
      }
    }
  }

  private async extractAndSendFont(fontPath: string): Promise<void> {
    await this.assets.extractMissing([fontPath]);
    this.assets.invalidateAfterBlizzardExtraction();
    const fontAbsPath = await this.assets.resolveToAbsPath(fontPath, "");
    if (!fontAbsPath) return;
    const fontUri = this.panel.webview.asWebviewUri(vscode.Uri.file(fontAbsPath)).toString();
    this.output.trace(`asset-extracted: "${fontPath}" → ${path.basename(fontAbsPath)}`);
    try {
      const msg: HostMessage = { type: "fontResolved", uri: fontUri };
      void this.panel.webview.postMessage(msg);
    } catch {
      // Panel was disposed before the font resolved.
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

    // Fixed 8px body padding on all sides; computed values derive from config.
    const BP = 8;
    const sbH = c.statusBarHeight;
    const rsz = c.rulerSize;
    // Scroll padding in CSS px — one UIParent dimension per side so frames can be
    // scrolled fully off-screen in any direction.
    const padH = Math.round(c.uiParentWidth * c.frameScale);
    const padV = Math.round(c.uiParentHeight * c.frameScale);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Scryer Preview</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:${c.rulerBg};display:flex;flex-direction:column;align-items:flex-start;padding:${padV + BP}px ${padH + BP}px;padding-top:${padV + sbH + BP}px;overflow:scroll}
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
    body.show-ruler{padding-top:${padV + sbH + rsz + BP}px;padding-left:${padH + rsz + BP}px}
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
    if (this.extractDebounce !== undefined) {
      clearTimeout(this.extractDebounce);
    }
    if (this.renderDebounce !== undefined) {
      clearTimeout(this.renderDebounce);
    }
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
