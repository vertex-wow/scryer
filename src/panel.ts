import * as path from "path";
import * as vscode from "vscode";
import { AssetService } from "./assets/index.js";
import type { AtlasManifest } from "./assets/atlas-manifest.js";
import { parseXmlFile } from "./parser/index.js";
import { resolveInheritance } from "./parser/inherit.js";
import { collectTexturePaths } from "./parser/collect-textures.js";
import type { FrameIR, TextureIR } from "./parser/ir.js";
import { resolveFlavorConfig } from "./flavors/config.js";
import { FLAVOR_INFO, listInstalledFlavors } from "./assets/build-info.js";
import type { HostMessage, Viewport, WebviewMessage } from "./protocol.js";

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
  private readonly loadingBar: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];
  private readonly pendingOps = new Set<"extracting" | "buildingAtlas">();
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

    this.loadingBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 92);
    this.loadingBar.tooltip = "Scryer background work in progress";
    this.disposables.push(this.loadingBar);

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
          this.atlasGenDone = false;
          this.extractionTriedPaths.clear();
        }
        if (
          e.affectsConfiguration("scryer.flavor") ||
          e.affectsConfiguration("scryer.locale") ||
          e.affectsConfiguration("scryer.screenResolution")
        ) {
          void this.renderFile(uri);
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

  private syncStatus(): void {
    if (this.pendingOps.size === 0) {
      try {
        void this.panel.webview.postMessage({ type: "setStatus", state: "idle" } as HostMessage);
      } catch {
        /* panel disposed */
      }
      this.loadingBar.hide();
    } else {
      const state = this.pendingOps.has("extracting") ? "extracting" : "buildingAtlas";
      try {
        void this.panel.webview.postMessage({ type: "setStatus", state } as HostMessage);
      } catch {
        /* panel disposed */
      }
      const label = state === "extracting" ? "extracting textures" : "building atlas";
      this.loadingBar.text = `$(loading~spin) Scryer: ${label}`;
      this.loadingBar.show();
    }
  }

  private startOp(op: "extracting" | "buildingAtlas"): void {
    this.pendingOps.add(op);
    this.syncStatus();
  }

  private endOp(op: "extracting" | "buildingAtlas"): void {
    this.pendingOps.delete(op);
    this.syncStatus();
  }

  private handleWebviewMessage(message: unknown, uri: vscode.Uri): void {
    if (typeof message !== "object" || !message) return;
    const msg = message as WebviewMessage;

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

      case "settingChange": {
        const cfg = vscode.workspace.getConfiguration("scryer");
        void cfg.update(msg.key, msg.value, vscode.ConfigurationTarget.Workspace);
        break;
      }

      case "dbg":
        this.output.trace(`status: ${msg.text ?? ""}`);
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

    this.retryInProgress = true;
    try {
      await this.assets.extractMissing(Array.from(batch.keys()));
      // Use lightweight invalidation: picks up newly extracted files without resetting
      // blizzardFilesPromise or the registry cache, preventing a re-extraction loop.
      this.assets.invalidateTextures();
      await Promise.all(
        Array.from(batch).map(([rawPath, addonDir]) => this.resolveAndSendAsset(rawPath, addonDir)),
      );
      this.output.debug(`#3: textures resolved (${batch.size} extracted)`);
    } finally {
      this.retryInProgress = false;
      // Mark all attempted paths so future re-renders don't re-queue them.
      for (const rawPath of batch.keys()) this.extractionTriedPaths.add(rawPath);
    }
  }

  async renderFile(uri: vscode.Uri, reason?: string): Promise<void> {
    // Reset missing-path state for the new render cycle.
    if (this.extractDebounce !== undefined) {
      clearTimeout(this.extractDebounce);
      this.extractDebounce = undefined;
    }
    this.missingPaths.clear();

    const cfg = vscode.workspace.getConfiguration("scryer");
    const preloadMode = cfg.get<string>("userAddonPreload") ?? "on-demand";
    const flavor = cfg.get<string>("flavor") ?? "retail";
    const locale = cfg.get<string>("locale") ?? "enUS";
    const screenResolution = cfg.get<string>("screenResolution") ?? "1920x1080";
    const userConfigPath = cfg.get<string>("flavorConfigPath") || undefined;
    const flavorConfig = resolveFlavorConfig(flavor, userConfigPath);
    const [rw, rh] = screenResolution.split("x").map(Number);
    if (rw && rh) {
      flavorConfig.screenWidth = rw;
      flavorConfig.screenHeight = rh;
      flavorConfig.uiParentWidth = Math.round((flavorConfig.uiParentHeight * rw) / rh);
    }

    // Kick off Blizzard addon file extraction if needed, but don't block the render.
    // isFirstExtraction is only true when extraction hasn't run this session yet — this
    // prevents "pending" UI and a redundant re-render on subsequent panel opens where
    // the shared AssetService already settled which files are present.
    // Log prefix: #1 = no cache, all placeholders (Blizzard extraction in-flight),
    //             #2 = shared templates ready, texture placeholders for missing assets,
    //             #3 = no placeholders, all textures resolved (logged in runExtractAndRetry).
    const isFirstExtraction =
      !this.blizzardExtractionDone && !this.assets.hasBlizzardExtractionRun();
    const rn = isFirstExtraction ? "#1" : "#2";
    this.output.debug(
      isFirstExtraction
        ? `${rn}: no cache — all placeholders`
        : `${rn}: shared templates ready${reason ? ` (${reason})` : ""}`,
    );
    this.output.trace(
      `${rn}:   param viewport: UIParent ${flavorConfig.uiParentWidth}×${flavorConfig.uiParentHeight} (screen ${flavorConfig.screenWidth}×${flavorConfig.screenHeight})`,
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
      if (!this.blizzardExtractionDone) {
        this.startOp("extracting");
        void this.assets.ensureBlizzardFiles().then((extracted) => {
          this.endOp("extracting");
          this.blizzardExtractionDone = true;
          if (extracted) {
            this.assets.invalidateAfterBlizzardExtraction();
            // Extraction downloads the listfile as a side effect — allow atlas
            // manifest generation to retry on the upcoming re-render.
            this.atlasGenDone = false;
          }
          // Re-render to flip pending state or pick up newly extracted templates.
          // Skipped when isFirstExtraction was false (files already known present).
          if (isFirstExtraction) void this.renderFile(uri, "Blizzard extraction settled");
        });
      }

      // Ensure atlas manifest exists; generate from wago.tools if absent.
      // Non-blocking: triggers a re-render only when a manifest is newly created.
      if (!this.atlasGenDone && !this.assets.hasAtlasManifestRun()) {
        this.atlasGenDone = true;
        this.startOp("buildingAtlas");
        void this.assets.ensureAtlasManifest().then((generated) => {
          this.endOp("buildingAtlas");
          if (generated) void this.renderFile(uri, "atlas manifest ready");
        });
      }

      // Load Blizzard template registry (disk-cached; fast after first parse).
      const blizzardRegistry = this.assets.loadBlizzardTemplates();
      this.output.debug(
        `${rn}:   Blizzard registry: ${blizzardRegistry.size} template${blizzardRegistry.size === 1 ? "" : "s"}`,
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
        `${rn}:   Render: ${renderFrames.length} frame${renderFrames.length === 1 ? "" : "s"}, ${texturePaths.length} texture${texturePaths.length === 1 ? "" : "s"}`,
      );
      for (const frame of renderFrames) {
        if (frame.templateChain.length > 0) {
          this.output.debug(
            `${rn}:   ${frame.name ?? "<anonymous>"}: inherits [${frame.templateChain.filter(Boolean).join(" → ")}]`,
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
        toolbarState: { flavor, locale, screenResolution },
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
    } catch (err) {
      this.output.error(`Error rendering ${uri.fsPath}: ${String(err)}`);
      this.output.show(true);
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
    const locale = cfg.get<string>("locale") ?? "enUS";
    const screenResolution = cfg.get<string>("screenResolution") ?? "1920x1080";
    const userConfigPath = cfg.get<string>("flavorConfigPath") || undefined;
    const c = resolveFlavorConfig(flavor, userConfigPath);

    const sbH = c.statusBarHeight;
    const rsz = c.rulerSize;
    const s = (val: string, target: string) => (val === target ? " selected" : "");
    const installDir = cfg.get<string>("installDir") ?? "";
    const installed = new Set(
      installDir ? listInstalledFlavors(installDir).map((f) => f.flavor) : [],
    );
    const flavorOptions = Object.keys(FLAVOR_INFO)
      .map((key) => {
        const label = key
          .split("_")
          .map((w) => w[0].toUpperCase() + w.slice(1))
          .join(" ");
        const mark = installed.has(key) ? " ✓" : "";
        return `<option value="${key}"${s(flavor, key)}>${label}${mark}</option>`;
      })
      .join("\n      ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Scryer Preview</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:${c.rulerBg};overflow:hidden;position:fixed;inset:0;user-select:none}
    #viewport{position:absolute;top:0;left:0;transform-origin:0 0;will-change:transform}
    #status-bar{position:fixed;top:0;left:0;right:0;height:${sbH}px;background:${c.statusBarBg};display:flex;align-items:center;z-index:10001;border-bottom:1px solid ${c.rulerBorder};font:${c.statusBarFont};color:${c.statusBarColor};white-space:nowrap;overflow:hidden}
    .toolbar-btn{flex-shrink:0;background:none;border:none;border-right:1px solid ${c.rulerBorder};cursor:pointer;height:${sbH}px;padding:0 7px;display:flex;align-items:center;justify-content:center;font-size:14px;color:${c.statusBarColor};opacity:0.55}
    .toolbar-btn:hover{background:rgba(255,255,255,0.07);opacity:0.85}
    .toolbar-btn.active{background:rgba(74,158,255,0.12);opacity:1;box-shadow:inset 0 -2px 0 #4a9eff}
    .ruler-icon{filter:sepia(1) saturate(8) hue-rotate(-30deg) brightness(0.85);display:inline-block}
    .toolbar-btn:hover .ruler-icon,.toolbar-btn.active .ruler-icon{filter:sepia(1) saturate(8) hue-rotate(-30deg) brightness(1.15)}
    #zoom-select,#flavor-select,#resolution-select,#locale-select{flex-shrink:0;background:none;border:none;border-right:1px solid ${c.rulerBorder};cursor:pointer;height:${sbH}px;padding:0 4px;color:${c.statusBarColor};font:${c.statusBarFont};outline:none;opacity:0.7}
    #zoom-select{min-width:62px}
    #flavor-select{min-width:72px}
    #resolution-select{min-width:70px}
    #locale-select{min-width:44px}
    #zoom-select:hover,#flavor-select:hover,#resolution-select:hover,#locale-select:hover{background:rgba(255,255,255,0.07);opacity:1}
    #zoom-select option,#flavor-select option,#resolution-select option,#locale-select option{background:${c.statusBarBg};color:${c.statusBarColor}}
    #flavor-select option:disabled,#resolution-select option:disabled{opacity:0.45;font-style:italic}
    #debug{padding:0 4px;white-space:pre-wrap}
    #ruler-top{position:fixed;top:${sbH}px;left:0;right:0;height:${rsz}px;z-index:9999;display:none}
    #ruler-left{position:fixed;top:${sbH}px;left:0;bottom:0;width:${rsz}px;z-index:9999;display:none}
    #ruler-corner{position:fixed;top:${sbH}px;left:0;width:${rsz}px;height:${rsz}px;z-index:10000;background:${c.rulerBg};border-right:1px solid ${c.rulerBorder};border-bottom:1px solid ${c.rulerBorder};display:none}
    body.show-ruler #ruler-top,body.show-ruler #ruler-left,body.show-ruler #ruler-corner{display:block}
    body.mode-grab{cursor:grab}
    body.mode-grab.panning{cursor:grabbing}
    body.mode-grab #viewport *{pointer-events:none}
  </style>
</head>
<body>
  <div id="status-bar">
    <button id="ruler-toggle" class="toolbar-btn" title="Toggle pixel ruler"><span class="ruler-icon">📏</span></button>
    <button id="grab-toggle" class="toolbar-btn" title="Grab — pan and zoom (drag · middle-drag · space-drag · ctrl+scroll · ctrl+0 fit · ctrl+shift+0 reset)"><svg width="12" height="13" viewBox="0 0 12 13" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="2" width="2" height="6" rx="1"/><rect x="4" y="0" width="2" height="8" rx="1"/><rect x="7" y="0" width="2" height="8" rx="1"/><rect x="10" y="2" width="2" height="6" rx="1"/><rect x="0" y="7" width="12" height="6" rx="2"/></svg></button>
    <button id="interact-toggle" class="toolbar-btn" title="Interact — normal mouse cursor"><svg width="10" height="13" viewBox="0 0 10 13" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><polygon points="0,0 0,10 2.5,7.5 4.5,12.5 6,12 4,7 7.5,7"/></svg></button>
    <button id="recenter-btn" class="toolbar-btn" title="Re-center canvas"><svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.4" xmlns="http://www.w3.org/2000/svg"><circle cx="6.5" cy="6.5" r="2.8"/><line x1="6.5" y1="0.5" x2="6.5" y2="3.7"/><line x1="6.5" y1="9.3" x2="6.5" y2="12.5"/><line x1="0.5" y1="6.5" x2="3.7" y2="6.5"/><line x1="9.3" y1="6.5" x2="12.5" y2="6.5"/></svg></button>
    <select id="flavor-select" title="WoW flavor (✓ = installed)">
      ${flavorOptions}
    </select>
    <select id="resolution-select" title="Screen resolution">
      <option disabled>=16:9=</option>
      <option value="1280x720"${s(screenResolution, "1280x720")}>1280x720</option>
      <option value="1920x1080"${s(screenResolution, "1920x1080")}>1920x1080</option>
      <option value="2560x1440"${s(screenResolution, "2560x1440")}>2560x1440</option>
      <option value="3840x2160"${s(screenResolution, "3840x2160")}>3840x2160</option>
      <option disabled>=16:10=</option>
      <option value="1440x900"${s(screenResolution, "1440x900")}>1440x900</option>
      <option value="1920x1200"${s(screenResolution, "1920x1200")}>1920x1200</option>
      <option value="2560x1600"${s(screenResolution, "2560x1600")}>2560x1600</option>
      <option disabled>=21:9=</option>
      <option value="1720x720"${s(screenResolution, "1720x720")}>1720x720</option>
      <option value="2580x1080"${s(screenResolution, "2580x1080")}>2580x1080</option>
      <option value="3440x1440"${s(screenResolution, "3440x1440")}>3440x1440</option>
      <option disabled>=4:3=</option>
      <option value="800x600"${s(screenResolution, "800x600")}>800x600</option>
      <option value="1024x768"${s(screenResolution, "1024x768")}>1024x768</option>
    </select>
    <select id="locale-select" title="WoW locale (GetLocale)">
      <option value="enUS" title="English (US)"${s(locale, "enUS")}>enUS</option>
      <option value="enGB" title="English (GB)"${s(locale, "enGB")}>enGB</option>
      <option value="deDE" title="German"${s(locale, "deDE")}>deDE</option>
      <option value="frFR" title="French"${s(locale, "frFR")}>frFR</option>
      <option value="esES" title="Spanish (Spain)"${s(locale, "esES")}>esES</option>
      <option value="esMX" title="Spanish (Latin America)"${s(locale, "esMX")}>esMX</option>
      <option value="ptBR" title="Portuguese (Brazil)"${s(locale, "ptBR")}>ptBR</option>
      <option value="ptPT" title="Portuguese (Portugal)"${s(locale, "ptPT")}>ptPT</option>
      <option value="ruRU" title="Russian"${s(locale, "ruRU")}>ruRU</option>
      <option value="koKR" title="Korean"${s(locale, "koKR")}>koKR</option>
      <option value="zhTW" title="Traditional Chinese"${s(locale, "zhTW")}>zhTW</option>
      <option value="zhCN" title="Simplified Chinese"${s(locale, "zhCN")}>zhCN</option>
      <option value="itIT" title="Italian"${s(locale, "itIT")}>itIT</option>
    </select>
    <select id="zoom-select" title="Zoom level">
      <option value="fit">Fit</option>
      <option value="25">25%</option>
      <option value="50">50%</option>
      <option value="75">75%</option>
      <option value="100" selected>100%</option>
      <option value="150">150%</option>
      <option value="200">200%</option>
      <option value="400">400%</option>
    </select>
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
