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
import { EventEngine } from "./lua/event-engine.js";
import { resolveFlavorConfig } from "./flavors/config.js";
import type { ResolvedFlavorConfig } from "./flavors/config.js";
import type { HostMessage, Viewport, WebviewMessage } from "./protocol.js";
import type { FrameIR, TextureIR } from "./parser/ir.js";
import type { LuaEngine } from "wasmoon";

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
  // WoW atlas names may carry tiling-hint prefixes (_ = tile H, ! = tile V).
  // The manifest stores keys both with and without these prefixes, so try the
  // original name first (lowercased), then the stripped variants as fallback.
  const origLower = tex.atlas.toLowerCase();
  const stripped = tex.atlas.replace(/^[_!]+/, "");
  const strippedLower = stripped.toLowerCase();
  const entry =
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
// Live session — holds the active sandbox and event engine
// ---------------------------------------------------------------------------

interface LiveSession {
  sandbox: LuaEngine;
  registry: FrameRegistry;
  clock: VirtualClock;
  engine: EventEngine;
  addonDir: string;
  flavorConfig: ResolvedFlavorConfig;
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

  private session: LiveSession | undefined;
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
      (message: unknown) => void this.handleWebviewMessage(message, uri),
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

  // ── Session lifecycle ────────────────────────────────────────────────────────

  private stopSession(): void {
    if (this.session) {
      this.session.engine.stop();
      try {
        this.session.sandbox.global.close();
      } catch {
        /* ignore */
      }
      this.session = undefined;
    }
  }

  // ── Webview message handler ──────────────────────────────────────────────────

  private async handleWebviewMessage(message: unknown, uri: vscode.Uri): Promise<void> {
    if (typeof message !== "object" || !message) return;
    const msg = message as WebviewMessage;

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

      case "frameEvent": {
        if (!this.session) break;
        await this.session.engine.dispatchFrameEvent(msg.frameId, msg.event, msg.extra ?? []);
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

  // ── Re-render helper (called by EventEngine when frames go dirty) ────────────

  private sendFrames(
    frames: FrameIR[],
    flavorConfig: ResolvedFlavorConfig,
    addonDir: string,
  ): void {
    const atlasManifest = this.assets.loadAtlasManifest();
    if (atlasManifest) resolveAtlasNames(frames, atlasManifest);

    const viewport: Viewport = {
      w: flavorConfig.uiParentWidth,
      h: flavorConfig.uiParentHeight,
    };

    const msg: HostMessage = {
      type: "render",
      frames,
      viewport,
      warnings: 0,
      extractionPending: false,
      pendingFiles: 0,
      flavorConfig,
    };
    void this.panel.webview.postMessage(msg);

    for (const rawPath of collectTexturePaths(frames)) {
      void this.resolveAndSendAsset(rawPath, addonDir);
    }
  }

  // ── Main run-and-render cycle ────────────────────────────────────────────────

  async runAndRender(uri: vscode.Uri): Promise<void> {
    if (this.extractDebounce !== undefined) {
      clearTimeout(this.extractDebounce);
      this.extractDebounce = undefined;
    }
    this.missingPaths.clear();

    // Tear down any existing session first
    this.stopSession();

    const cfg = vscode.workspace.getConfiguration("scryer");
    const flavor = cfg.get<string>("flavor") ?? "retail";
    const userConfigPath = cfg.get<string>("flavorConfigPath") || undefined;
    const flavorConfig = resolveFlavorConfig(flavor, userConfigPath);
    const addonDir = path.dirname(uri.fsPath);

    try {
      // Read the TOC file
      const tocContent = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf-8");
      const toc = parseToc(tocContent, uri.fsPath);

      // Build a fresh sandbox + registry
      const wasmPath = vscode.Uri.joinPath(this.context.extensionUri, "dist", "glue.wasm").fsPath;
      const registry = new FrameRegistry(flavorConfig.uiParentWidth, flavorConfig.uiParentHeight);
      const clock = new VirtualClock();
      const sandbox = await createSandbox(wasmPath, { timeout: flavorConfig.sandboxTimeout });
      const atlasManifest = this.assets.loadAtlasManifest();

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
        atlasManifest,
      });

      // Ensure Blizzard source files are present before attempting to load Lua from them.
      // Fire-and-forget extraction like the static panel does; if files are already there
      // this returns immediately. We await so the Lua load below sees the files on disk.
      await this.assets.ensureBlizzardFiles();

      const blizzardTemplates = this.assets.loadBlizzardTemplates();

      await registerFrameModel(sandbox, registry, blizzardTemplates);

      // Load Blizzard Lua in dependency order before running the user's addon.
      // SharedXMLBase → Blizzard_Colors (needed by SharedColorConstants.lua) → SharedXML.
      // Per ADR 011: every file in this list must succeed — failures are hard errors,
      // not silent skips. If a file fails, fix the missing C stub or add the dependency
      // addon to this list; do not add a shadow stub in wow-api.ts.
      for (const addonName of ["Blizzard_SharedXMLBase", "Blizzard_Colors", "Blizzard_SharedXML"]) {
        for (const luaPath of this.assets.blizzardAddonLuaFiles(addonName)) {
          try {
            const content = Buffer.from(
              await vscode.workspace.fs.readFile(vscode.Uri.file(luaPath)),
            ).toString("utf-8");
            await sandbox.doString(content);
          } catch (e) {
            this.output.warn(`[Live] Blizzard Lua failed: ${path.basename(luaPath)}: ${e}`);
            throw new Error(
              `Blizzard Lua file failed to load: ${path.basename(luaPath)}. ` +
                `Fix the missing C-layer stub or load-order issue rather than adding a shadow stub. See docs/decisions/011_blizzard_lua_load_philosophy.md`,
            );
          }
        }
      }
      // Blizzard Lua files may create frames as side-effects of module-level code.
      // Clear them so the user's addon starts with a clean frame tree.
      registry.clearBlizzardFrames();

      await runTocAddon({
        toc,
        addonDir,
        sandbox,
        blizzardTemplates,
        timeout: flavorConfig.sandboxTimeout,
        readFile: async (absPath) => {
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

      // Advance clock one tick to fire any immediate timers
      clock.advance(0.001);

      // Serialize the initial frame tree
      registry.clearDirty();
      const frames = registry.serialize();

      // Resolve default font
      let defaultFontUri: string | undefined;
      if (flavorConfig.defaultFont) {
        const fontAbsPath = await this.assets.resolveToAbsPath(flavorConfig.defaultFont, "");
        if (fontAbsPath) {
          defaultFontUri = this.panel.webview.asWebviewUri(vscode.Uri.file(fontAbsPath)).toString();
        }
      }

      // Build the EventEngine (sandbox stays alive — NOT closed here)
      const engine = new EventEngine(sandbox, registry, clock, flavorConfig, {
        onFramesDirty: (dirtyFrames) => {
          this.sendFrames(dirtyFrames, flavorConfig, addonDir);
        },
        output: {
          warn: (msg) => this.output.warn(msg),
          error: (msg) => this.output.error(msg),
        },
      });

      this.session = { sandbox, registry, clock, engine, addonDir, flavorConfig };
      engine.start();

      // Send initial render
      if (atlasManifest) resolveAtlasNames(frames, atlasManifest);

      const viewport: Viewport = {
        w: flavorConfig.uiParentWidth,
        h: flavorConfig.uiParentHeight,
      };

      const renderMsg: HostMessage = {
        type: "render",
        frames,
        viewport,
        warnings: 0,
        extractionPending: false,
        pendingFiles: 0,
        flavorConfig,
        defaultFontUri,
      };

      void this.panel.webview.postMessage(renderMsg);
      void this.panel.webview.postMessage(this.rulerMessage());

      for (const rawPath of collectTexturePaths(frames)) {
        void this.resolveAndSendAsset(rawPath, addonDir);
      }

      this.output.debug(`[Live] rendered ${frames.length} root frame(s); event engine started`);
    } catch (err) {
      this.stopSession();
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
    const padH = Math.round(c.uiParentWidth * c.frameScale);
    const padV = Math.round(c.uiParentHeight * c.frameScale);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Scryer Live</title>
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
    if (this.extractDebounce !== undefined) clearTimeout(this.extractDebounce);
    if (this.renderDebounce !== undefined) clearTimeout(this.renderDebounce);
    this.stopSession();
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
