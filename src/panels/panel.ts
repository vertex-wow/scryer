import * as path from "path";
import { buildPanelHtml } from "./panel-html.js";
import { PanelToolbar } from "./panel-toolbar.js";
import * as vscode from "vscode";
import { resolveAtlasNames } from "../assets/atlas-manifest.js";
import { FLAVOR_INFO, listInstalledFlavors } from "../assets/build-info.js";
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
import { resolveFlavorConfig } from "../flavors/config.js";
import { collectTexturePaths } from "../parser/collect-textures.js";
import { parseXmlFile } from "../parser/index.js";
import { resolveInheritance } from "../parser/inherit.js";
import type { HostMessage, Viewport, WebviewMessage } from "../protocol.js";

// How long after the last document change to wait before re-rendering in current-file mode.
// How long after the last unresolved-asset report to wait before triggering extraction.
const EXTRACT_DEBOUNCE_MS = 300;

// How long after the last document change to wait before re-rendering in current-file mode.
const RENDER_DEBOUNCE_MS = 300;

export class ScryerPanel {
  static readonly viewType = "scryer.preview";
  static activePanel: ScryerPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly output: vscode.LogOutputChannel;
  private readonly context: vscode.ExtensionContext;
  private readonly statusBar: vscode.StatusBarItem;
  private readonly installDirBar: vscode.StatusBarItem;
  private readonly loadingBar: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];
  private readonly pendingOps = new Set<"extracting" | "buildingAtlas">();
  private assets: AssetService;
  private toolbar: PanelToolbar;

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
          ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri),
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
    this.statusBar.show();
    this.toolbar = new PanelToolbar(this.panel, this.statusBar);
    this.toolbar.updateStatusBar();
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

    const flavor = this.toolbar.getSetting<string>("flavor") ?? "retail";
    const locale = this.toolbar.getSetting<string>("locale") ?? "enUS";
    const screenResolution = this.toolbar.getSetting<string>("screenResolution") ?? "1920x1080";
    const workareaBackground =
      this.toolbar.getSetting<string>("workareaBackground") ?? "checkerBoardAuto";
    const workareaBackgroundPath = this.toolbar.getSetting<string>("workareaBackgroundPath") ?? "";
    this.panel.webview.html = buildPanelHtml({
      title: `Scryer: ${uri.path.split("/").pop() ?? "Preview"}`,
      webview: this.panel.webview,
      extensionUri: this.context.extensionUri,
      flavor,
      locale,
      screenResolution,
      workareaBackground,
      workareaBackgroundPath,
    });

    this.panel.webview.onDidReceiveMessage(
      (message: unknown) => this.handleWebviewMessage(message, uri),
      null,
      this.disposables,
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.onDidChangeViewState(
      () => {
        if (this.panel.active) ScryerPanel.activePanel = this;
      },
      null,
      this.disposables,
    );
    if (this.panel.active) ScryerPanel.activePanel = this;

    // Re-resolve assets and propagate setting changes to the webview.
    vscode.workspace.onDidChangeConfiguration(
      (e) => {
        if (e.affectsConfiguration("scryer")) {
          this.assets.invalidate();
          this.blizzardExtractionDone = false;
          this.atlasGenDone = false;
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
          void this.renderFile(uri);
        }

        if (
          e.affectsConfiguration("scryer.showRuler") &&
          !("showRuler" in this.toolbar.ephemeralSettings)
        ) {
          this.toolbar.updateStatusBar();
          void this.panel.webview.postMessage(this.toolbar.rulerMessage());
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

  toggleEyedropper(): void {
    this.toolbar.toggleEyedropper();
  }

  setCanvasMode(mode: CanvasMode): void {
    void this.panel.webview.postMessage({ type: "setCanvasMode", mode });
  }

  recenterCanvas(): void {
    void this.panel.webview.postMessage({ type: "recenterCanvas" });
  }

  private handleWebviewMessage(message: unknown, uri: vscode.Uri): void {
    if (typeof message !== "object" || !message) return;
    const msg = message as WebviewMessage;

    if (this.toolbar.handleMessage(msg)) {
      void this.renderFile(uri);
      return;
    }

    switch (msg.type) {
      case "ready":
        void this.renderFile(uri);
        break;

      case "requestAsset":
        if (msg.path) {
          this.output.trace(`    requestAsset: ${msg.path}`);
          void this.resolveAndSendAsset(msg.path, path.dirname(uri.fsPath));
        }
        break;

      case "dbg":
        this.output.trace(`status: ${msg.text ?? ""}`);
        break;
    }
  }

  private async resolveAndSendAsset(rawPath: string, addonDir: string): Promise<void> {
    const absPath = await this.assets.resolveToAbsPath(rawPath, addonDir);
    if (!absPath) {
      if (this.retryInProgress) {
        // After extraction pass — file still not found. Log at warn so it's visible.
        this.output.warn(`texture miss (after extraction): ${rawPath}`);
      } else if (this.extractionTriedPaths.has(rawPath)) {
        this.output.trace(`texture miss (already tried): ${rawPath}`);
      } else if (!this.missingPaths.has(rawPath)) {
        this.output.debug(`texture miss (queued for extraction): ${rawPath}`);
        this.missingPaths.set(rawPath, addonDir);
        this.scheduleMissingExtract();
      }
      return;
    }

    this.output.trace(`texture resolved: ${rawPath} → ${path.basename(absPath)}`);
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

    this.output.info(`texture extraction: ${batch.size} missing asset(s) — extracting`);
    if (this.output.logLevel <= vscode.LogLevel.Debug) {
      for (const p of batch.keys()) this.output.debug(`  → ${p}`);
    }

    this.retryInProgress = true;
    let resolved = 0;
    try {
      await this.assets.extractMissing(Array.from(batch.keys()));
      // Use lightweight invalidation: picks up newly extracted files without resetting
      // blizzardFilesPromise or the registry cache, preventing a re-extraction loop.
      this.assets.invalidateTextures();
      await Promise.all(
        Array.from(batch).map(async ([rawPath, addonDir]) => {
          const found = await this.assets.resolveToAbsPath(rawPath, addonDir);
          if (found) resolved++;
          return this.resolveAndSendAsset(rawPath, addonDir);
        }),
      );
      this.output.info(`texture extraction: ${resolved}/${batch.size} resolved`);
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
      if (this.missingPaths.size > 0) {
        this.output.debug(
          `render cycle reset — cancelled pending extraction of ${this.missingPaths.size} asset(s)`,
        );
      }
    }
    this.missingPaths.clear();

    const cfg = vscode.workspace.getConfiguration("scryer");
    const preloadMode = cfg.get<string>("userAddonPreload") ?? "on-demand";
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
      const { frames: blizzardFrames, textures: blizzardTextures } =
        this.assets.loadBlizzardTemplates();
      this.output.debug(
        `${rn}:   Blizzard registry: ${blizzardFrames.size} frame template${blizzardFrames.size === 1 ? "" : "s"}, ${blizzardTextures.size} texture template${blizzardTextures.size === 1 ? "" : "s"}`,
      );

      const warnCb = (msg: string) => this.output.warn(msg);

      const warns = { count: 0 };
      const [resolved] = resolveInheritance(
        [doc],
        blizzardFrames,
        {
          warnings: warns,
          pending: isFirstExtraction,
          warn: warnCb,
        },
        blizzardTextures,
      );
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

      let customBackgroundUri: string | undefined;
      let customBackgroundIsFolder: boolean | undefined;
      if (workareaBackground === "custom" && workareaBackgroundPath) {
        try {
          const stat = await vscode.workspace.fs.stat(vscode.Uri.file(workareaBackgroundPath));
          let targetPath = workareaBackgroundPath;
          if (stat.type === vscode.FileType.Directory) {
            customBackgroundIsFolder = true;
            targetPath = path.join(workareaBackgroundPath, `${screenResolution}.png`);
          }
          try {
            await vscode.workspace.fs.stat(vscode.Uri.file(targetPath));
            customBackgroundUri = this.panel.webview
              .asWebviewUri(vscode.Uri.file(targetPath))
              .toString();
          } catch {
            // target path does not exist
          }
        } catch {
          // invalid path
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
        customBackgroundUri,
        customBackgroundIsFolder,
        toolbarState: {
          flavor,
          locale,
          screenResolution,
          defaultCanvasMode,
          workareaBackground,
          workareaBackgroundPath,
        },
      };

      void this.panel.webview.postMessage(msg);
      void this.panel.webview.postMessage(this.toolbar.rulerMessage());

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

  dispose(): void {
    if (ScryerPanel.activePanel === this) ScryerPanel.activePanel = undefined;
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
