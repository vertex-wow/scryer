import * as path from "path";
import { buildLocaleDropdownHtml } from "./webview/locale-dropdown.js";
import * as vscode from "vscode";
import type { LuaEngine } from "wasmoon";
import { resolveAtlasNames } from "./assets/atlas-manifest.js";
import { FLAVOR_INFO, listInstalledFlavors } from "./assets/build-info.js";
import { AssetService } from "./assets/index.js";
import type { CanvasMode } from "./constants.js";
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
} from "./constants.js";
import type { ResolvedFlavorConfig } from "./flavors/config.js";
import { resolveFlavorConfig } from "./flavors/config.js";
import { registerFrameModel } from "./lua/createframe.js";
import { EventEngine } from "./lua/event-engine.js";
import { FrameRegistry } from "./lua/frame-registry.js";
import { createSandbox } from "./lua/sandbox.js";
import { runTocAddon } from "./lua/toc-runner.js";
import { registerWowApi, VirtualClock } from "./lua/wow-api.js";
import type { FrameIR, TextureIR } from "./parser/ir.js";
import { parseToc } from "./parser/toc.js";
import type { HostMessage, Viewport, WebviewMessage } from "./protocol.js";
import { layoutAll } from "./webview/layout.js";

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

function formatColorForStatusBar(
  r: number,
  g: number,
  b: number,
  a: number,
  x: number,
  y: number,
): string {
  const h = (n: number) => Math.round(n).toString(16).toUpperCase().padStart(2, "0");
  const hex = `#${h(r)}${h(g)}${h(b)}`;
  const wow = `|c${h(a)}${h(r)}${h(g)}${h(b)}`;
  const css = `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${(a / 255).toFixed(2)})`;
  const cc = `CreateColor(${(r / 255).toFixed(2)}, ${(g / 255).toFixed(2)}, ${(b / 255).toFixed(2)}, ${(a / 255).toFixed(2)})`;
  return `(${x}, ${y})  ${hex}  ${wow}  ${css}  ${cc}`;
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
  private eyedropperActive = false;
  private lastEyedropperText: string | undefined;

  private session: LiveSession | undefined;
  private missingPaths = new Map<string, string>();
  private retryInProgress = false;
  private extractDebounce: ReturnType<typeof setTimeout> | undefined;
  private renderDebounce: ReturnType<typeof setTimeout> | undefined;
  private extractionTriedPaths = new Set<string>();
  private defaultFontUri: string | undefined;
  private customBackgroundUri: string | undefined;
  private customBackgroundIsFolder: boolean | undefined;

  private ephemeralSettings: Record<string, unknown> = {};

  private getSetting<T>(key: string): T {
    if (key in this.ephemeralSettings) {
      return this.ephemeralSettings[key] as T;
    }
    return vscode.workspace.getConfiguration("scryer").get<T>(key) as T;
  }

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
          if (e.affectsConfiguration(`scryer.${key}`) && !(key in this.ephemeralSettings)) {
            needsRender = true;
          }
        }
        if (needsRender) {
          void this.runAndRender(uri);
        }

        if (
          e.affectsConfiguration("scryer.showRuler") &&
          !("showRuler" in this.ephemeralSettings)
        ) {
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
    const show = this.getSetting<boolean>("showRuler") ?? true;
    return { type: "setRuler", show };
  }

  private updateStatusBar(): void {
    if (this.eyedropperActive && this.lastEyedropperText) {
      this.statusBar.text = `🔬 ${this.lastEyedropperText}`;
      this.statusBar.tooltip = "Eyedropper — Ctrl+C in preview to copy";
    } else {
      const show = this.getSetting<boolean>("showRuler") ?? true;
      this.statusBar.text = `📏 ${show ? "ON" : "OFF"}`;
      this.statusBar.tooltip = "Toggle pixel ruler overlay";
    }
  }

  toggleEyedropper(): void {
    this.eyedropperActive = !this.eyedropperActive;
    if (!this.eyedropperActive) this.lastEyedropperText = undefined;
    void this.panel.webview.postMessage({ type: "setEyedropper", active: this.eyedropperActive });
    this.updateStatusBar();
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
        const current = this.getSetting<boolean>("showRuler") ?? true;
        this.ephemeralSettings["showRuler"] = !current;
        this.updateStatusBar();
        void this.panel.webview.postMessage(this.rulerMessage());
        break;
      }

      case "settingChange": {
        this.ephemeralSettings[msg.key] = msg.value;
        void this.runAndRender(uri);
        break;
      }

      case "frameEvent": {
        if (!this.session) break;
        await this.session.engine.dispatchFrameEvent(msg.frameId, msg.event, msg.extra ?? []);
        break;
      }

      case "eyedropperOn":
        this.eyedropperActive = true;
        this.updateStatusBar();
        break;

      case "eyedropperOff":
        this.eyedropperActive = false;
        this.lastEyedropperText = undefined;
        this.updateStatusBar();
        break;

      case "eyedropperSample": {
        const { r, g, b, a } = msg;
        this.lastEyedropperText = formatColorForStatusBar(r, g, b, a, msg.x, msg.y);
        this.statusBar.text = `🔬 ${this.lastEyedropperText}`;
        this.statusBar.tooltip = "Eyedropper — Ctrl+C in preview to copy";
        break;
      }

      case "eyedropperCopy":
        void vscode.env.clipboard.writeText(msg.text);
        break;
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
    try {
      this.output.trace(`    assetResolved: ${rawPath} → ${uri}`);
    } catch {
      /* disposed */
    }
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
      toolbarState: {
        flavor: this.getSetting<string>("flavor") ?? "retail",
        locale: this.getSetting<string>("locale") ?? "enUS",
        screenResolution: this.getSetting<string>("screenResolution") ?? "1920x1080",
        defaultCanvasMode: this.getSetting<CanvasMode>("defaultCanvasMode") ?? DEFAULT_CANVAS_MODE,
        workareaBackground: this.getSetting<string>("workareaBackground") ?? "checkerBoardAuto",
        workareaBackgroundPath: this.getSetting<string>("workareaBackgroundPath") ?? "",
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
    const flavor = this.getSetting<string>("flavor") ?? "retail";
    const locale = this.getSetting<string>("locale") ?? "enUS";
    const screenResolution = this.getSetting<string>("screenResolution") ?? "1920x1080";
    const defaultCanvasMode =
      this.getSetting<CanvasMode>("defaultCanvasMode") ?? DEFAULT_CANVAS_MODE;
    const workareaBackground = this.getSetting<string>("workareaBackground") ?? "checkerBoardAuto";
    const workareaBackgroundPath = this.getSetting<string>("workareaBackgroundPath") ?? "";
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

      // Ensure Blizzard source files are present before attempting to load Lua from them.
      // Fire-and-forget extraction like the static panel does; if files are already there
      // this returns immediately. We await so the Lua load below sees the files on disk.
      await this.assets.ensureBlizzardFiles();

      const { frames: blizzardTemplates, textures: blizzardTextureTemplates } =
        this.assets.loadBlizzardTemplates();

      await registerFrameModel(sandbox, registry, blizzardTemplates, blizzardTextureTemplates);

      // Load Blizzard Lua in dependency order before running the user's addon.
      // SharedXMLBase → Blizzard_Colors (needed by SharedColorConstants.lua) → SharedXML.
      // Per ADR 011: every file in this list must succeed — failures are hard errors,
      // not silent skips. If a file fails, fix the missing C stub or add the dependency
      // addon to this list; do not add a shadow stub in wow-api.ts.
      for (const addonName of ["Blizzard_SharedXMLBase", "Blizzard_Colors", "Blizzard_SharedXML"]) {
        for (const luaPath of this.assets.blizzardAddonLuaFiles(addonName, (rel) => {
          this.output.warn(
            `[Live] Blizzard Lua not extracted — ${addonName}/${rel} (run full extraction to fix)`,
          );
        })) {
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
        customBackgroundUri: this.customBackgroundUri,
        toolbarState: {
          flavor,
          locale,
          screenResolution,
          defaultCanvasMode,
          workareaBackground,
          workareaBackgroundPath,
        },
      };

      void this.panel.webview.postMessage(renderMsg);
      void this.panel.webview.postMessage(this.rulerMessage());

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
    const flavor = this.getSetting<string>("flavor") ?? "retail";
    const locale = this.getSetting<string>("locale") ?? "enUS";
    const screenResolution = this.getSetting<string>("screenResolution") ?? "1920x1080";
    const workareaBackground = this.getSetting<string>("workareaBackground") ?? "checkerBoardAuto";
    const workareaBackgroundPath = this.getSetting<string>("workareaBackgroundPath") ?? "";
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

    const [rw, rh] = screenResolution.split("x").map(Number);
    const currentUiParentWidth = Math.round((768 * rw) / rh);
    const resolutionTitle = `Native Screen Resolution&#10;${screenResolution} = ${currentUiParentWidth}x768 in-game`;

    const resOpt = (res: string) => {
      const [w, h] = res.split("x").map(Number);
      const gw = Math.round((768 * w) / h);
      return `<option value="${res}" title="${res} = ${gw}x768 in-game"${s(screenResolution, res)}>${res}</option>`;
    };

    const bgLabelMap: Record<string, string> = {
      checkerBoardAuto: "Checkerboard (Auto)",
      checkerBoard: "Checkerboard (Dark)",
      checkerBoardLight: "Checkerboard (Light)",
      black: "Black",
      white: "White",
      neutralGray: "Neutral Gray (50%)",
      magenta: "Magenta (Debug)",
      custom: workareaBackgroundPath ? workareaBackgroundPath : "Custom...",
    };
    const bgLabel = bgLabelMap[workareaBackground] ?? workareaBackground;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Scryer Live</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{overflow:hidden;position:fixed;inset:0;user-select:none;background:var(--vscode-editor-background)}
    #viewport{position:absolute;top:0;left:0;transform-origin:0 0;will-change:transform}
    #status-bar{position:fixed;top:0;left:0;right:0;height:${sbH}px;background:${c.statusBarBg};display:flex;align-items:center;z-index:10001;border-bottom:1px solid ${c.rulerBorder};font:${c.toolbarFont};color:${c.statusBarColor};white-space:nowrap;overflow:visible}
    .toolbar-btn{flex-shrink:0;background:none;border:none;border-right:1px solid ${c.rulerBorder};cursor:pointer;height:${sbH}px;padding:0 7px;display:flex;align-items:center;justify-content:center;font-size:14px;color:${c.statusBarColor};opacity:0.55}
    .toolbar-btn:hover{background:rgba(255,255,255,0.07);opacity:0.85}
    .toolbar-btn.active{background:rgba(74,158,255,0.12);opacity:1;box-shadow:inset 0 -2px 0 #4a9eff}
    .ruler-icon{filter:sepia(1) saturate(8) hue-rotate(-30deg) brightness(0.85);display:inline-block}
    .toolbar-btn:hover .ruler-icon,.toolbar-btn.active .ruler-icon{filter:sepia(1) saturate(8) hue-rotate(-30deg) brightness(1.15)}
    #zoom-select,#flavor-select,#resolution-select,#bg-select{flex-shrink:0;background:none;border:none;border-right:1px solid ${c.rulerBorder};cursor:pointer;height:${sbH}px;padding:0 4px;color:${c.statusBarColor};font:${c.toolbarFont};outline:none;opacity:0.7}
    #zoom-select{min-width:62px}
    #flavor-select{min-width:72px}
    #resolution-select{min-width:70px}
    #locale-dropdown{min-width:28px;justify-content:center}
    .locale-stack{display:flex;flex-direction:column;align-items:center;line-height:1;font-size:10px;margin-top:2px;font-family:monospace}
    .locale-single{font-family:monospace;font-size:12px}
    .custom-dropdown{position:relative;display:flex;align-items:center;border-right:1px solid ${c.rulerBorder};padding:0 4px;height:${sbH}px;cursor:pointer;opacity:0.7}
    .custom-dropdown:hover{background:rgba(255,255,255,0.07);opacity:1}
    .custom-dropdown-trigger{display:flex;align-items:center;gap:4px}
    .dropdown-trigger-label{font:${c.toolbarFont};color:${c.statusBarColor}}
    .custom-dropdown-menu{position:absolute;top:${sbH}px;left:0;background:var(--vscode-dropdown-background);border:1px solid var(--vscode-dropdown-border);color:var(--vscode-dropdown-foreground);display:none;flex-direction:column;min-width:180px;z-index:10002;box-shadow:0 4px 6px rgba(0,0,0,0.3)}
    .custom-dropdown-menu:not(.hidden){display:flex}
    .dropdown-item{padding:4px 8px;display:flex;align-items:center;gap:6px;font:${c.toolbarFont};cursor:pointer}
    .dropdown-item:hover{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}
    .dropdown-item.selected{background:var(--vscode-list-inactiveSelectionBackground)}
    .dropdown-item-preview{width:14px;height:14px;border:1px solid rgba(255,255,255,0.2);border-radius:2px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:12px}
    #bg-preview{width:14px;height:14px;border:1px solid rgba(255,255,255,0.2);border-radius:2px;flex-shrink:0;pointer-events:none}
    .bg-preview-auto{background:repeating-conic-gradient(${WORKAREA_BG_CHECKERBOARD_DARK_COLOR1} 0% 25%, ${WORKAREA_BG_CHECKERBOARD_DARK_COLOR2} 0% 50%) 50% / 10px 10px}
    body.vscode-light .bg-preview-auto{background:repeating-conic-gradient(${WORKAREA_BG_CHECKERBOARD_LIGHT_COLOR1} 0% 25%, ${WORKAREA_BG_CHECKERBOARD_LIGHT_COLOR2} 0% 50%) 50% / 10px 10px}
    .bg-preview-dark{background:repeating-conic-gradient(${WORKAREA_BG_CHECKERBOARD_DARK_COLOR1} 0% 25%, ${WORKAREA_BG_CHECKERBOARD_DARK_COLOR2} 0% 50%) 50% / 10px 10px}
    .bg-preview-light{background:repeating-conic-gradient(${WORKAREA_BG_CHECKERBOARD_LIGHT_COLOR1} 0% 25%, ${WORKAREA_BG_CHECKERBOARD_LIGHT_COLOR2} 0% 50%) 50% / 10px 10px}
    .bg-preview-black{background:${WORKAREA_BG_BLACK}}
    .bg-preview-white{background:${WORKAREA_BG_WHITE}}
    .bg-preview-gray{background:${WORKAREA_BG_GRAY}}
    .bg-preview-magenta{background:${WORKAREA_BG_MAGENTA}}
    #zoom-select option,#flavor-select option,#resolution-select option,#locale-select option,#bg-select option{background:${c.statusBarBg};color:${c.statusBarColor}}
    #flavor-select option:disabled,#resolution-select option:disabled{opacity:0.45;font-style:italic}
    #debug{padding:0 4px;white-space:pre-wrap;font:${c.statusTextFont}}
    #ruler-top{position:fixed;top:${sbH}px;left:0;right:0;height:${rsz}px;z-index:9999;display:none}
    #ruler-left{position:fixed;top:${sbH}px;left:0;bottom:0;width:${rsz}px;z-index:9999;display:none}
    #ruler-corner{position:fixed;top:${sbH}px;left:0;width:${rsz}px;height:${rsz}px;z-index:10000;background:${c.rulerBg};border-right:1px solid ${c.rulerBorder};border-bottom:1px solid ${c.rulerBorder};display:none}
    body.show-ruler #ruler-top,body.show-ruler #ruler-left,body.show-ruler #ruler-corner{display:block}
    body.mode-grab{cursor:grab}
    body.mode-grab.panning{cursor:grabbing}
    body.mode-grab #viewport *{pointer-events:none}
    body.mode-eyedropper{cursor:crosshair}
  </style>
</head>
<body>
  <div id="status-bar">
    <button id="ruler-toggle" class="toolbar-btn" title="Toggle pixel ruler"><span class="ruler-icon">📏</span></button>
    <button id="interact-toggle" class="toolbar-btn" title="Interact — normal mouse cursor"><svg width="10" height="13" viewBox="0 0 10 13" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><polygon points="0,0 0,10 2.5,7.5 4.5,12.5 6,12 4,7 7.5,7"/></svg></button>
    <button id="grab-toggle" class="toolbar-btn" title="Grab — pan and zoom (drag · middle-drag · space-drag · ctrl+scroll · ctrl+0 fit · ctrl+shift+0 reset)"><svg width="12" height="13" viewBox="0 0 12 13" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="2" width="2" height="6" rx="1"/><rect x="4" y="0" width="2" height="8" rx="1"/><rect x="7" y="0" width="2" height="8" rx="1"/><rect x="10" y="2" width="2" height="6" rx="1"/><rect x="0" y="7" width="12" height="6" rx="2"/></svg></button>
    <button id="recenter-btn" class="toolbar-btn" title="Re-center canvas"><svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.4" xmlns="http://www.w3.org/2000/svg"><circle cx="6.5" cy="6.5" r="2.8"/><line x1="6.5" y1="0.5" x2="6.5" y2="3.7"/><line x1="6.5" y1="9.3" x2="6.5" y2="12.5"/><line x1="0.5" y1="6.5" x2="3.7" y2="6.5"/><line x1="9.3" y1="6.5" x2="12.5" y2="6.5"/></svg></button>
    <button id="eyedropper-toggle" class="toolbar-btn" title="Eyedropper &mdash; sample pixel color (Ctrl+C to copy)"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M13.354.646a1.207 1.207 0 0 0-1.708 0L8.5 3.793l-.646-.647a.5.5 0 1 0-.708.708L8.293 5l-7.147 7.146A.5.5 0 0 0 1 12.5v1.793l-.854.853a.5.5 0 1 0 .708.707L1.707 15H3.5a.5.5 0 0 0 .354-.146L11 7.707l1.146 1.147a.5.5 0 0 0 .708-.708l-.647-.646 3.147-3.146a1.207 1.207 0 0 0 0-1.708zM2 12.707l7-7L10.293 7l-7 7H2z"/></svg></button>
    <div id="bg-dropdown" class="custom-dropdown" title="Workarea Background&#10;${bgLabel}">
      <div id="bg-dropdown-trigger" class="custom-dropdown-trigger">
        <div id="bg-preview"></div>
        <span class="dropdown-trigger-label">bg</span>
      </div>
      <div id="bg-dropdown-menu" class="custom-dropdown-menu hidden">
        <div class="dropdown-item${s(workareaBackground, "checkerBoardAuto")}" data-value="checkerBoardAuto">
          <div class="dropdown-item-preview bg-preview-auto"></div>
          <span class="dropdown-item-text">Checkerboard (Auto)</span>
        </div>
        <div class="dropdown-item${s(workareaBackground, "checkerBoard")}" data-value="checkerBoard">
          <div class="dropdown-item-preview bg-preview-dark"></div>
          <span class="dropdown-item-text">Checkerboard (Dark)</span>
        </div>
        <div class="dropdown-item${s(workareaBackground, "checkerBoardLight")}" data-value="checkerBoardLight">
          <div class="dropdown-item-preview bg-preview-light"></div>
          <span class="dropdown-item-text">Checkerboard (Light)</span>
        </div>
        <div class="dropdown-item${s(workareaBackground, "black")}" data-value="black">
          <div class="dropdown-item-preview bg-preview-black"></div>
          <span class="dropdown-item-text">Black</span>
        </div>
        <div class="dropdown-item${s(workareaBackground, "white")}" data-value="white">
          <div class="dropdown-item-preview bg-preview-white"></div>
          <span class="dropdown-item-text">White</span>
        </div>
        <div class="dropdown-item${s(workareaBackground, "neutralGray")}" data-value="neutralGray">
          <div class="dropdown-item-preview bg-preview-gray"></div>
          <span class="dropdown-item-text">Neutral Gray (50%)</span>
        </div>
        <div class="dropdown-item${s(workareaBackground, "magenta")}" data-value="magenta">
          <div class="dropdown-item-preview bg-preview-magenta"></div>
          <span class="dropdown-item-text">Magenta (Debug)</span>
        </div>
        <div class="dropdown-item${s(workareaBackground, "custom")}" data-value="custom" title="Custom background image or folder&#10;Configure via 'scryer.workareaBackgroundPath' in settings">
          <div class="dropdown-item-preview" id="custom-bg-preview">🖼️</div>
          <span class="dropdown-item-text" id="custom-bg-label">${workareaBackgroundPath ? workareaBackgroundPath : "Custom..."}</span>
        </div>
      </div>
    </div>
    <select id="flavor-select" title="WoW flavor (✓ = installed)">
      ${flavorOptions}
    </select>
    <select id="resolution-select" title="${resolutionTitle}">
      <option disabled>=16:9=</option>
      ${resOpt("1280x720")}
      ${resOpt("1920x1080")}
      ${resOpt("2560x1440")}
      ${resOpt("3840x2160")}
      <option disabled>=16:10=</option>
      ${resOpt("1440x900")}
      ${resOpt("1920x1200")}
      ${resOpt("2560x1600")}
      <option disabled>=21:9=</option>
      ${resOpt("1720x720")}
      ${resOpt("2580x1080")}
      ${resOpt("3440x1440")}
      <option disabled>=4:3=</option>
      ${resOpt("800x600")}
      ${resOpt("1024x768")}
    </select>
    ${buildLocaleDropdownHtml(locale)}
    <select id="zoom-select" title="Zoom level">
      <option value="fit">Fit</option>
${ZOOM_PRESETS.map((pct) => `      <option value="${pct}"${pct === 100 ? " selected" : ""}>${pct}%</option>`).join("\n")}
    </select>
    <span id="debug">script not yet loaded</span>
  </div>
  <div id="viewport"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    if (ScryerLivePanel.activePanel === this) ScryerLivePanel.activePanel = undefined;
    if (this.extractDebounce !== undefined) clearTimeout(this.extractDebounce);
    if (this.renderDebounce !== undefined) clearTimeout(this.renderDebounce);
    this.stopSession();
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
