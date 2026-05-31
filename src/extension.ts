import * as path from "path";
import * as vscode from "vscode";
import { AssetService } from "./assets/index.js";
import { FLAVOR_INFO, listInstalledFlavors } from "./assets/build-info.js";
import { ADDON_NAMES, SHARED_ADDON_NAMES } from "./parser/blizzard-registry.js";
import { ScryerPanel } from "./panel.js";
import { ScryerLivePanel } from "./live-panel.js";

export function activate(context: vscode.ExtensionContext): void {
  // Single shared output channel and asset service for the entire extension session.
  // Sharing AssetService preserves blizzardFilesEnsured across panel opens so extraction
  // only runs once per session rather than on every new panel.
  const output = vscode.window.createOutputChannel("Scryer", { log: true });
  context.subscriptions.push(output);
  output.info("activated — set log level via the Output panel filter to control verbosity");
  function logAssetParams(a: AssetService): void {
    output.debug(`param game-install-dir: ${a.installDir || "(not set)"}`);
    output.debug(`param cache-global: ${a.cacheRoot}`);
    if (!a.installDir) {
      output.warn(
        "scryer.installDir is not set — texture extraction disabled. Set it to your WoW root directory (the folder containing _retail_/, _classic_/, .build.info).",
      );
    }
    if (!a.isCascToolAvailable()) {
      output.warn(
        "rustydemon-cli not found — texture extraction disabled. Install it or set scryer.cascToolPath.",
      );
    }
  }

  async function maybeShowSetupNotice(a: AssetService): Promise<void> {
    if (context.workspaceState.get<boolean>("scryer.assetSetupNoticeSeen")) return;
    if (a.installDir && a.isCascToolAvailable()) return; // extraction runs automatically when a panel opens
    if (await a.hasExtractedAssets()) return; // assets already on disk from a prior extraction
    await context.workspaceState.update("scryer.assetSetupNoticeSeen", true);
    const missingTool = !a.isCascToolAvailable();
    const msg = missingTool
      ? "Scryer: No extracted assets found. Set scryer.installDir and scryer.cascToolPath to enable automatic texture extraction."
      : "Scryer: No extracted assets found. Set scryer.installDir to your WoW installation to enable automatic texture extraction.";
    const pick = await vscode.window.showInformationMessage(msg, "Open Settings", "Learn More");
    if (pick === "Open Settings") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:scryer");
    } else if (pick === "Learn More") {
      await vscode.commands.executeCommand(
        "markdown.showPreview",
        vscode.Uri.joinPath(context.extensionUri, "docs", "configuration.md"),
      );
    }
  }

  let assets = AssetService.fromConfig(context, output);
  assets.checkBuildVersion();
  assets.detectAndLogFlavors();
  logAssetParams(assets);
  void Promise.resolve().then(() => maybeShowSetupNotice(assets));

  // Re-create AssetService and re-run startup checks when relevant settings change.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("scryer.flavor") ||
        e.affectsConfiguration("scryer.installDir") ||
        e.affectsConfiguration("scryer.cacheLocation") ||
        e.affectsConfiguration("scryer.cacheDir") ||
        e.affectsConfiguration("scryer.cascToolPath")
      ) {
        assets = AssetService.fromConfig(context, output);
        assets.checkBuildVersion();
        assets.detectAndLogFlavors();
        logAssetParams(assets);
      }
    }),
  );

  const selectFlavorCmd = vscode.commands.registerCommand("scryer.selectFlavor", async () => {
    const installDir = vscode.workspace.getConfiguration("scryer").get<string>("installDir") ?? "";
    const installed = installDir ? listInstalledFlavors(installDir) : [];
    const items =
      installed.length > 0
        ? installed.map(({ flavor, version }) => ({ label: flavor, description: version }))
        : Object.keys(FLAVOR_INFO).map((f) => ({ label: f, description: "" }));

    const current = vscode.workspace.getConfiguration("scryer").get<string>("flavor") ?? "retail";
    const picked = await vscode.window.showQuickPick(items, {
      title: "Scryer: Select WoW Flavor",
      placeHolder: `Current: ${current}`,
    });
    if (picked) {
      await vscode.workspace
        .getConfiguration("scryer")
        .update("flavor", picked.label, vscode.ConfigurationTarget.Workspace);
    }
  });
  context.subscriptions.push(selectFlavorCmd);

  const toggleRulerCmd = vscode.commands.registerCommand("scryer.toggleRuler", async () => {
    const cfg = vscode.workspace.getConfiguration("scryer");
    const current = cfg.get<boolean>("showRuler") ?? true;
    await cfg.update("showRuler", !current, vscode.ConfigurationTarget.Workspace);
  });
  context.subscriptions.push(toggleRulerCmd);

  const cmd = vscode.commands.registerCommand("scryer.open", (uri?: vscode.Uri) => {
    const resolved = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!resolved) {
      void vscode.window.showErrorMessage("Scryer: open a .xml file first.");
      return;
    }
    if (!resolved.fsPath.endsWith(".xml")) {
      void vscode.window.showErrorMessage("Scryer: active file is not an XML file.");
      return;
    }
    output.info(`Viewing ${path.basename(resolved.fsPath)}`);
    ScryerPanel.create(context, resolved, assets, output);
  });

  context.subscriptions.push(cmd);

  const liveCmd = vscode.commands.registerCommand("scryer.openLive", (uri?: vscode.Uri) => {
    const resolved = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!resolved) {
      void vscode.window.showErrorMessage("Scryer: open a .toc file first.");
      return;
    }
    if (!resolved.fsPath.endsWith(".toc")) {
      void vscode.window.showErrorMessage("Scryer: active file is not a TOC file.");
      return;
    }
    output.info(`Viewing Live ${path.basename(resolved.fsPath)}`);
    ScryerLivePanel.create(context, resolved, assets, output);
  });

  context.subscriptions.push(liveCmd);

  const liveFolderCmd = vscode.commands.registerCommand(
    "scryer.openLiveFolder",
    async (uri?: vscode.Uri) => {
      if (!uri) {
        void vscode.window.showErrorMessage("Scryer: no folder selected.");
        return;
      }
      const folderName = uri.fsPath.split(/[\\/]/).pop()!;
      const tocUri = vscode.Uri.joinPath(uri, `${folderName}.toc`);
      try {
        await vscode.workspace.fs.stat(tocUri);
      } catch {
        void vscode.window.showErrorMessage(
          `Scryer: no matching TOC file found (${folderName}.toc).`,
        );
        return;
      }
      output.info(`Viewing Live ${path.basename(tocUri.fsPath)}`);
      ScryerLivePanel.create(context, tocUri, assets, output);
    },
  );

  context.subscriptions.push(liveFolderCmd);

  // Pre-warm template registry and/or texture caches at activation so the first panel
  // open is fast. Deferred past activate() via a resolved promise so activation is
  // not delayed by synchronous registry parsing.
  //
  // Tiers are executed progressively from cheapest to configured target so the most
  // useful data (shared templates, shared textures) is available as early as possible.
  // Template loading is a single step regardless of tier because there are only two
  // addons and the disk cache makes the difference negligible (<0.5 s). Texture
  // prewarm is split: shared first, then the full set — BLP conversion for FrameXML
  // textures can take several seconds and should not block shared-texture availability.
  const TIER_ORDER = [
    "shared-templates",
    "all-templates",
    "all-templates-shared-textures",
    "all-templates-textures",
  ] as const;
  const startupContent =
    vscode.workspace.getConfiguration("scryer").get<string>("startupContent") ?? "none";
  const tierIdx = (TIER_ORDER as readonly string[]).indexOf(startupContent);
  if (tierIdx >= 0) {
    let cancelled = false;
    context.subscriptions.push({
      dispose: () => {
        cancelled = true;
      },
    });
    const TIER_LABEL: Record<string, string> = {
      "shared-templates": "load shared templates, no textures",
      "all-templates": "all Blizzard templates loaded, no textures",
      "all-templates-shared-textures":
        "all Blizzard templates loaded, shared textures queued for pre-warm",
      "all-templates-textures": "all Blizzard templates loaded, all textures queued for pre-warm",
    };
    void Promise.resolve().then(async () => {
      output.info(
        `cache-warmup: ${TIER_LABEL[startupContent] ?? startupContent} (startupContent=${startupContent})`,
      );
      await assets.ensureBlizzardFiles();
      assets.loadBlizzardTemplates();
      if (cancelled) return;
      if (tierIdx >= TIER_ORDER.indexOf("all-templates-shared-textures")) {
        if (!(await assets.hasExtractedAssets())) {
          output.warn(
            `cache-warmup: startupContent="${startupContent}" requests textures but no extracted assets found — skipping texture pre-warm. Set scryer.installDir to enable extraction.`,
          );
        } else {
          await assets.prewarmBlizzardTextures(SHARED_ADDON_NAMES);
          output.info("cache-warmup: shared Blizzard textures pre-warmed");
          if (cancelled) return;
          if (tierIdx >= TIER_ORDER.indexOf("all-templates-textures")) {
            await assets.prewarmBlizzardTextures(ADDON_NAMES);
            output.info("cache-warmup: all Blizzard textures pre-warmed");
          }
        }
      }
    });
  }
}

export function deactivate(): void {}
