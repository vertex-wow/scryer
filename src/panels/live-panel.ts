import * as path from "path";
import { buildPanelHtml } from "./panel-html.js";
import { PanelToolbar } from "./panel-toolbar.js";
import * as vscode from "vscode";
import type { LuaEngine } from "wasmoon";
import { resolveAtlasNames } from "../assets/atlas-manifest.js";
import { FLAVOR_INFO, listInstalledFlavors } from "../assets/build-info.js";
import { isExtracting } from "../assets/extractor.js";
import { AssetService } from "../assets/index.js";
import type { CanvasMode } from "../constants.js";
import {
  DEFAULT_CANVAS_MODE,
  WORKAREA_BG_BLACK,
  WORKAREA_BG_CHECKERBOARD_DARK_COLOR1,
  WORKAREA_BG_CHECKERBOARD_DARK_COLOR2,
  WORKAREA_BG_CHECKERBOARD_LIGHT_COLOR1,
  WORKAREA_BG_CHECKERBOARD_LIGHT_COLOR2,
  WORKAREA_BG_GRAY,
  WORKAREA_BG_MAGENTA,
  WORKAREA_BG_WHITE,
  ZOOM_PRESETS,
} from "../constants.js";
import type { ResolvedFlavorConfig } from "../flavors/config.js";
import { resolveFlavorConfig } from "../flavors/config.js";
import { registerFrameModel } from "../lua/createframe.js";
import { EventEngine } from "../lua/event-engine.js";
import { FrameRegistry } from "../lua/frame-registry.js";
import { createSandbox } from "../lua/sandbox.js";
import { runTocAddon } from "../lua/toc-runner.js";
import { registerWowApi, VirtualClock } from "../lua/wow-api.js";
import type { FrameIR, TextureIR } from "../parser/ir.js";
import { parseToc } from "../parser/toc.js";
import type { HostMessage, Viewport, WebviewMessage } from "../protocol.js";
import { layoutAll } from "../webview/layout.js";

/** Strip WoW color codes like |cAARRGGBBtext|r from a string. */
function stripWowColorCodes(s: string): string {
  return s.replace(/\|c[0-9a-fA-F]{8}(.*?)\|r/g, "$1").replace(/\|c[0-9a-fA-F]{8}/g, "");
}

const RENDER_DEBOUNCE_MS = 400;
const EXTRACT_DEBOUNCE_MS = 300;

// ---------------------------------------------------------------------------

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
  static activePanel: ScryerLivePanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly output: vscode.LogOutputChannel;
  private readonly context: vscode.ExtensionContext;
  private readonly statusBar: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];
  private assets: AssetService;
  private toolbar: PanelToolbar;

  private session: LiveSession | undefined;
  private missingPaths = new Map<string, string>();
  private retryInProgress = false;
  private extractDebounce: ReturnType<typeof setTimeout> | undefined;
  private renderDebounce: ReturnType<typeof setTimeout> | undefined;
  private extractionTriedPaths = new Set<string>();
  private defaultFontUri: string | undefined;
  private customBackgroundUri: string | undefined;
  private customBackgroundIsFolder: boolean | undefined;

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
          ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri),
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
    this.statusBar.show();
    this.toolbar = new PanelToolbar(this.panel, this.statusBar);
    this.toolbar.updateStatusBar();
    this.disposables.push(this.statusBar);

    const flavor = this.toolbar.getSetting<string>("flavor") ?? "retail";
    const locale = this.toolbar.getSetting<string>("locale") ?? "enUS";
    const screenResolution = this.toolbar.getSetting<string>("screenResolution") ?? "1920x1080";
    const workareaBackground =
      this.toolbar.getSetting<string>("workareaBackground") ?? "checkerBoardAuto";
    const workareaBackgroundPath = this.toolbar.getSetting<string>("workareaBackgroundPath") ?? "";
    this.panel.webview.html = buildPanelHtml({
      title: `Scryer Live: ${uri.path.split("/").pop() ?? "Preview"}`,
      webview: this.panel.webview,
      extensionUri: this.context.extensionUri,
      flavor,
      locale,
      screenResolution,
      workareaBackground,
      workareaBackgroundPath,
    });

    this.panel.webview.onDidReceiveMessage(
      (message: unknown) => void this.handleWebviewMessage(message, uri),
      null,
      this.disposables,
    );

    this.assets.acquireKeepalive();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.onDidChangeViewState(
      () => {
        if (this.panel.active) ScryerLivePanel.activePanel = this;
      },
      null,
      this.disposables,
    );
    if (this.panel.active) ScryerLivePanel.activePanel = this;

    vscode.workspace.onDidChangeConfiguration(
      (e) => {
        if (e.affectsConfiguration("scryer")) {
          this.assets.invalidate();
          this.extractionTriedPaths.clear();
        }

        let needsRender = false;
        for (const key of [
          "flavor",
          "locale",
          "screenResolution",
          "defaultCanvasMode",
          "workareaBackground",
          "workareaBackgroundPath",
        ]) {
          if (e.affectsConfiguration(`scryer.${key}`) && !(key in this.toolbar.ephemeralSettings)) {
            needsRender = true;
          }
        }
        if (needsRender) {
          void this.runAndRender(uri);
        }

        if (
          e.affectsConfiguration("scryer.showRuler") &&
          !("showRuler" in this.toolbar.ephemeralSettings)
        ) {
          this.toolbar.updateStatusBar();
          void this.panel.webview.postMessage(this.toolbar.rulerMessage());
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

  toggleEyedropper(): void {
    this.toolbar.toggleEyedropper();
  }

  setCanvasMode(mode: CanvasMode): void {
    void this.panel.webview.postMessage({ type: "setCanvasMode", mode });
  }

  recenterCanvas(): void {
    void this.panel.webview.postMessage({ type: "recenterCanvas" });
  }

  // ── Webview message handler ──────────────────────────────────────────────────

  private async handleWebviewMessage(message: unknown, uri: vscode.Uri): Promise<void> {
    if (typeof message !== "object" || !message) return;
    const msg = message as WebviewMessage;

    if (this.toolbar.handleMessage(msg)) {
      void this.runAndRender(uri);
      return;
    }

    switch (msg.type) {
      case "ready":
        if (isExtracting())
          void this.panel.webview.postMessage({
            type: "setStatus",
            state: "extracting",
          } as HostMessage);
        void this.runAndRender(uri);
        break;

      case "requestAsset":
        if (msg.path) {
          this.output.trace(`    requestAsset: ${msg.path}`);
          void this.resolveAndSendAsset(msg.path, path.dirname(uri.fsPath));
        }
        break;

      case "frameEvent": {
        if (!this.session) break;
        await this.session.engine.dispatchFrameEvent(msg.frameId, msg.event, msg.extra ?? []);
        break;
      }
    }
  }

  private async resolveLocalOverride(
    rawPath: string,
    addonDir: string,
  ): Promise<string | undefined> {
    const normalised = rawPath
      .replace(/\\/g, "/")
      .replace(/\.[^/.]+$/, "")
      .toLowerCase();
    const localPath = path.join(addonDir, "assets", normalised + ".png");
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(localPath));
      return this.panel.webview.asWebviewUri(vscode.Uri.file(localPath)).toString();
    } catch {
      return undefined;
    }
  }

  private async resolveAndSendAsset(
    rawPath: string,
    addonDir: string,
    skipFailed = false,
  ): Promise<void> {
    if (this.toolbar.getSetting<boolean>("localTextureOverrides") !== false) {
      const overrideUri = await this.resolveLocalOverride(rawPath, addonDir);
      if (overrideUri) {
        void this.panel.webview.postMessage({
          type: "assetResolved",
          path: rawPath,
          uri: overrideUri,
        } as HostMessage);
        return;
      }
    }

    const absPath = await this.assets.resolveToAbsPath(rawPath, addonDir);
    if (!absPath) {
      if (skipFailed) return;
      if (this.retryInProgress) {
        this.output.warn(`texture miss (after extraction): ${rawPath}`);
        void this.panel.webview.postMessage({ type: "assetFailed", path: rawPath } as HostMessage);
      } else if (this.extractionTriedPaths.has(rawPath)) {
        this.output.trace(`texture miss (already tried): ${rawPath}`);
        void this.panel.webview.postMessage({ type: "assetFailed", path: rawPath } as HostMessage);
      } else if (!this.missingPaths.has(rawPath)) {
        this.output.debug(`texture miss (queued for extraction): ${rawPath}`);
        this.missingPaths.set(rawPath, addonDir);
        this.scheduleMissingExtract();
      }
      return;
    }
    this.output.trace(`texture resolved: ${rawPath} → ${path.basename(absPath)}`);
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

    this.output.info(`texture extraction: ${batch.size} missing asset(s) — extracting`);
    if (this.output.logLevel <= vscode.LogLevel.Debug) {
      for (const p of batch.keys()) this.output.debug(`  → ${p}`);
    }

    // Capture blocking state before starting extraction, then start extractMissing
    // immediately so userJobs is incremented before any async gap. The pre-check runs
    // concurrently — this prevents the notification from closing mid-check (which would
    // cause it to reopen when extractMissing later sees wasIdle=true).
    const wasBlocked = isExtracting();
    const extractionPromise = this.assets.extractMissing(Array.from(batch.keys()));

    const preReportedFailed = new Set<string>();
    if (wasBlocked) {
      await Promise.all(
        Array.from(batch).map(async ([rawPath, addonDir]) => {
          const found = await this.assets.resolveToAbsPath(rawPath, addonDir);
          if (!found) {
            preReportedFailed.add(rawPath);
            void this.panel.webview.postMessage({
              type: "assetFailed",
              path: rawPath,
            } as HostMessage);
          }
        }),
      );
    }

    await extractionPromise;
    this.assets.invalidateTextures();

    this.retryInProgress = true;
    let resolved = 0;
    try {
      await Promise.all(
        Array.from(batch).map(async ([rawPath, addonDir]) => {
          const found = await this.assets.resolveToAbsPath(rawPath, addonDir);
          if (found) resolved++;
          return this.resolveAndSendAsset(rawPath, addonDir, preReportedFailed.has(rawPath));
        }),
      );
      this.output.info(`texture extraction: ${resolved}/${batch.size} resolved`);
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
      toolbarState: {
        flavor: this.toolbar.getSetting<string>("flavor") ?? "retail",
        locale: this.toolbar.getSetting<string>("locale") ?? "enUS",
        screenResolution: this.toolbar.getSetting<string>("screenResolution") ?? "1920x1080",
        defaultCanvasMode:
          this.toolbar.getSetting<CanvasMode>("defaultCanvasMode") ?? DEFAULT_CANVAS_MODE,
        workareaBackground:
          this.toolbar.getSetting<string>("workareaBackground") ?? "checkerBoardAuto",
        workareaBackgroundPath: this.toolbar.getSetting<string>("workareaBackgroundPath") ?? "",
        localTextureOverrides: this.toolbar.getSetting<boolean>("localTextureOverrides") !== false,
      },
      customBackgroundUri: this.customBackgroundUri,
      customBackgroundIsFolder: this.customBackgroundIsFolder,
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
    const flavor = this.toolbar.getSetting<string>("flavor") ?? "retail";
    const locale = this.toolbar.getSetting<string>("locale") ?? "enUS";
    const screenResolution = this.toolbar.getSetting<string>("screenResolution") ?? "1920x1080";
    const defaultCanvasMode =
      this.toolbar.getSetting<CanvasMode>("defaultCanvasMode") ?? DEFAULT_CANVAS_MODE;
    const workareaBackground =
      this.toolbar.getSetting<string>("workareaBackground") ?? "checkerBoardAuto";
    const workareaBackgroundPath = this.toolbar.getSetting<string>("workareaBackgroundPath") ?? "";
    const userConfigPath = cfg.get<string>("flavorConfigPath") || undefined;
    const flavorConfig = resolveFlavorConfig(flavor, userConfigPath);
    const [rw, rh] = screenResolution.split("x").map(Number);
    if (rw && rh) {
      flavorConfig.screenWidth = rw;
      flavorConfig.screenHeight = rh;
      flavorConfig.uiParentWidth = Math.round((flavorConfig.uiParentHeight * rw) / rh);
    }
    const addonDir = path.dirname(uri.fsPath);

    this.customBackgroundUri = undefined;
    this.customBackgroundIsFolder = undefined;
    if (workareaBackground === "custom" && workareaBackgroundPath) {
      try {
        const stat = await vscode.workspace.fs.stat(vscode.Uri.file(workareaBackgroundPath));
        let targetPath = workareaBackgroundPath;
        if (stat.type === vscode.FileType.Directory) {
          this.customBackgroundIsFolder = true;
          targetPath = path.join(workareaBackgroundPath, `${screenResolution}.png`);
        }
        try {
          await vscode.workspace.fs.stat(vscode.Uri.file(targetPath));
          this.customBackgroundUri = this.panel.webview
            .asWebviewUri(vscode.Uri.file(targetPath))
            .toString();
        } catch {}
      } catch {}
    }

    try {
      // Read the TOC file
      const tocContent = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf-8");
      const toc = parseToc(tocContent, uri.fsPath);

      // Build a fresh sandbox + registry
      const wasmPath = vscode.Uri.joinPath(this.context.extensionUri, "dist", "glue.wasm").fsPath;
      const registry = new FrameRegistry(flavorConfig.uiParentWidth, flavorConfig.uiParentHeight);
      const clock = new VirtualClock();
      const sandbox = await createSandbox(wasmPath, { timeout: flavorConfig.sandboxTimeout });

      // Extract critical Blizzard addons at user priority (SharedXMLBase, Colors,
      // SharedXML, FrameXML). FrameXML is required for loadBlizzardTemplates() to
      // find NineSlicePanelTemplate and other inherited frame templates. Fonts come
      // from the background prewarm and pop in once extracted.
      await this.assets.ensureBlizzardLuaCritical();

      // Generate atlas manifest if needed — listfile is guaranteed present after extraction.
      await this.assets.ensureAtlasManifest();
      const atlasManifest = this.assets.loadAtlasManifest();

      await registerWowApi(sandbox, {
        clock,
        flavor: flavor as "retail" | "classic" | "classic_era",
        locale,
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

      const { frames: blizzardTemplates, textures: blizzardTextureTemplates } =
        this.assets.loadBlizzardTemplates();

      await registerFrameModel(
        sandbox,
        registry,
        blizzardTemplates,
        blizzardTextureTemplates,
        atlasManifest ?? undefined,
      );

      // Load Blizzard Lua in dependency order before running the user's addon.
      // SharedXMLBase → Blizzard_Colors (needed by SharedColorConstants.lua) → SharedXML.
      // Per ADR 011: every file in this list must succeed — failures are hard errors,
      // not silent skips. If a file fails, fix the missing C stub or add the dependency
      // addon to this list; do not add a shadow stub in wow-api.ts.
      for (const addonName of ["Blizzard_SharedXMLBase", "Blizzard_Colors", "Blizzard_SharedXML"]) {
        const luaFiles = this.assets.blizzardAddonLuaFiles(addonName, (rel) => {
          this.output.warn(
            `[Live] Blizzard Lua not extracted — ${addonName}/${rel} (run full extraction to fix)`,
          );
        });
        if (luaFiles.length === 0) {
          this.output.warn(
            `[Live] ${addonName}: no Lua files loaded — TOC file missing or CDN-only stub.\n` +
              `  Blizzard templates, NineSlice borders, and shared APIs will be unavailable.\n` +
              `  Fix: Battle.net → World of Warcraft → Options → Scan and Repair.`,
          );
        }
        for (const luaPath of luaFiles) {
          try {
            const content = Buffer.from(
              await vscode.workspace.fs.readFile(vscode.Uri.file(luaPath)),
            ).toString("utf-8");
            await sandbox.doString(content);
          } catch (e) {
            const errorStr = String(e);
            this.output.warn(`[Live] Blizzard Lua failed: ${path.basename(luaPath)}: ${e}`);

            const troubleshooting = `
TROUBLESHOOTING:
1. **Load-Order Issue?** Check if a Blizzard addon dependency is missing:
   - Review the addon load list in src/live-panel.ts (around line 408)
   - Ensure all dependencies are loaded before the file that failed
   - Common dependencies: Blizzard_SharedXMLBase, Blizzard_Colors, Blizzard_SharedXML

2. **C-Layer Issue?** If the error mentions an undefined function/variable:
   - Identify the function name from the error message (e.g., CreateFrame, CreateCounter, GetOrCreateTableEntry)
   - Check the WoW API wiki (in _reference/vscode-wow-api or wowpedia.fandom.com) to confirm it's a C-level API
   - Check if it already exists in src/lua/wow-api.ts registerWowApi()
   - If missing, implement a proper C-layer stub in wow-api.ts (do NOT add workarounds in Blizzard Lua)
   - See docs/decisions/011_blizzard_lua_load_philosophy.md

3. **Still stuck?** Review the stack trace in the error below to identify which addon/function is actually missing.`;

            throw new Error(
              `Blizzard Lua file failed to load: ${path.basename(luaPath)}\n` +
                `Error: ${errorStr}` +
                troubleshooting,
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
        blizzardTextureTemplates,
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

      // Fire Show() on every named root frame so the OnShow cascade runs (e.g.
      // PanelTemplates_TabResize). Scryer renders all frames for preview regardless
      // of hidden state, so triggering OnShow here matches what the player would see
      // after the frame becomes visible in-game.
      for (const rootFrame of registry.serialize()) {
        if (rootFrame.name) {
          try {
            await sandbox.doString(`if ${rootFrame.name} then ${rootFrame.name}:Show() end`);
          } catch {
            // OnShow errors are non-fatal for preview
          }
        }
      }

      // Serialize the initial frame tree
      registry.clearDirty();
      const frames = registry.serialize();

      // Resolve default font — queue for extraction if missing.
      let defaultFontUri: string | undefined;
      if (flavorConfig.defaultFont) {
        const fontAbsPath = await this.assets.resolveToAbsPath(flavorConfig.defaultFont, "");
        if (fontAbsPath) {
          defaultFontUri = this.panel.webview.asWebviewUri(vscode.Uri.file(fontAbsPath)).toString();
        } else if (!this.extractionTriedPaths.has(flavorConfig.defaultFont)) {
          this.output.trace(`    font miss — queuing extraction: ${flavorConfig.defaultFont}`);
          this.missingPaths.set(flavorConfig.defaultFont, "");
          this.scheduleMissingExtract();
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
        customBackgroundUri: this.customBackgroundUri,
        toolbarState: {
          flavor,
          locale,
          screenResolution,
          defaultCanvasMode,
          workareaBackground,
          workareaBackgroundPath,
          localTextureOverrides:
            this.toolbar.getSetting<boolean>("localTextureOverrides") !== false,
        },
      };

      void this.panel.webview.postMessage(renderMsg);
      void this.panel.webview.postMessage(this.toolbar.rulerMessage());

      for (const rawPath of collectTexturePaths(frames)) {
        void this.resolveAndSendAsset(rawPath, addonDir);
      }

      this.output.debug(`[Live] rendered ${frames.length} root frame(s); event engine started`);

      // ── Tab position debug logging ────────────────────────────────────────
      const dbgRects = layoutAll(frames, { w: viewport.w, h: viewport.h });
      const allFrames: FrameIR[] = [];
      (function collect(list: FrameIR[]) {
        for (const f of list) {
          allFrames.push(f);
          if (f.children) collect(f.children);
        }
      })(frames);
      for (const f of allFrames) {
        if (!f.name) continue;
        const rect = dbgRects.get(f);
        const anchors = f.anchors
          .map(
            (a) =>
              `${a.point}→${a.relativeTo ?? a.relativeKey ?? "(parent)"}[${a.relativePoint ?? a.point}] x=${a.x ?? 0} y=${a.y ?? 0}`,
          )
          .join(", ");
        this.output.debug(
          `[Live][tab-dbg] ${f.name}: left=${rect ? Math.round(rect.left) : "?"} right=${rect ? Math.round(rect.left + rect.width) : "?"} w=${rect ? Math.round(rect.width) : "?"} anchors=[${anchors}]`,
        );
      }
      // ─────────────────────────────────────────────────────────────────────
    } catch (err) {
      this.stopSession();
      this.output.error(`[Live] Error running ${uri.fsPath}: ${String(err)}`);
      this.output.show(true);
    }
  }

  dispose(): void {
    if (ScryerLivePanel.activePanel === this) ScryerLivePanel.activePanel = undefined;
    if (this.extractDebounce !== undefined) clearTimeout(this.extractDebounce);
    if (this.renderDebounce !== undefined) clearTimeout(this.renderDebounce);
    this.assets.releaseKeepalive();
    this.stopSession();
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
