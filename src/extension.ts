import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { listInstalledFlavors } from "./assets/build-info.js";
import { AssetService } from "./assets/index.js";
import { isSvgConverterAvailable, pngToTga, resolveFlipTool, svgToPng } from "./assets/svg.js";
import { ScryerLivePanel } from "./panels/live-panel.js";
import { ScryerPanel } from "./panels/panel.js";
import { ADDON_NAMES, SHARED_ADDON_NAMES } from "./parser/blizzard-registry.js";
import { collectTexturePaths, parseXmlFile, resolveInheritance } from "./parser/index.js";
import { TeeLogOutputChannel } from "./logger.js";

interface GitRepo {
  checkIgnore(paths: string[]): Promise<Set<string>>;
}
interface GitApi {
  getRepository(uri: vscode.Uri): GitRepo | null;
}

async function filterGitIgnored(uris: vscode.Uri[]): Promise<vscode.Uri[]> {
  try {
    const ext = vscode.extensions.getExtension<{ getAPI(v: number): GitApi }>("vscode.git");
    if (!ext) return uris;
    if (!ext.isActive) await ext.activate();
    const git = ext.exports.getAPI(1);
    const byRepo = new Map<GitRepo, vscode.Uri[]>();
    const repoless: vscode.Uri[] = [];
    for (const uri of uris) {
      const repo = git.getRepository(uri);
      if (!repo) repoless.push(uri);
      else {
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
          else kept.push(uri);
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
    return uris;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  // Single shared output channel and asset service for the entire extension session.
  // Sharing AssetService preserves blizzardFilesEnsured across panel opens so extraction
  // only runs once per session rather than on every new panel.
  const rawOutput = vscode.window.createOutputChannel("Scryer", { log: true });
  const output = new TeeLogOutputChannel(rawOutput);
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
  }

  async function maybeShowSetupNotice(a: AssetService): Promise<void> {
    if (context.workspaceState.get<boolean>("scryer.assetSetupNoticeSeen")) return;
    if (a.installDir) return; // extraction runs automatically when a panel opens
    if (await a.hasExtractedAssets()) return; // assets already on disk from a prior extraction
    await context.workspaceState.update("scryer.assetSetupNoticeSeen", true);
    const msg =
      "Scryer: No extracted assets found. Set scryer.installDir to your WoW installation to enable automatic texture extraction.";
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
  output.setLogFile(path.join(assets.cacheRoot, "logs", "extension.log"));
  assets.checkBuildVersion();
  assets.detectAndLogFlavors();
  logAssetParams(assets);
  void Promise.resolve().then(() => maybeShowSetupNotice(assets));

  // Re-create AssetService and re-run startup checks when relevant settings change.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("scryer.defaultTarget") ||
        e.affectsConfiguration("scryer.flavor") ||
        e.affectsConfiguration("scryer.installDir") ||
        e.affectsConfiguration("scryer.cacheLocation") ||
        e.affectsConfiguration("scryer.cacheDir") ||
        e.affectsConfiguration("scryer.assetServerPath") ||
        e.affectsConfiguration("scryer.assetServerIdleTimeout") ||
        e.affectsConfiguration("scryer.tactKeysUrls") ||
        e.affectsConfiguration("scryer.atlasCsvUrls")
      ) {
        assets = AssetService.fromConfig(context, output);
        output.setLogFile(path.join(assets.cacheRoot, "logs", "extension.log"));
        assets.checkBuildVersion();
        assets.detectAndLogFlavors();
        logAssetParams(assets);
      }
    }),
  );

  const TARGET_CHOICES: Array<{ id: string; detail: string }> = [
    { id: "mainline", detail: "Mainline (The War Within)" },
    { id: "mists", detail: "Mists of Pandaria Classic" },
    { id: "bcc", detail: "Burning Crusade Classic" },
    { id: "classic_era", detail: "Classic Era" },
  ];
  const EXTRACTION_TO_TARGET: Record<string, string> = {
    retail: "mainline",
    classic: "mists",
    classic_era: "classic_era",
  };
  const selectFlavorCmd = vscode.commands.registerCommand("scryer.selectFlavor", async () => {
    const installDir = vscode.workspace.getConfiguration("scryer").get<string>("installDir") ?? "";
    const installed = installDir ? listInstalledFlavors(installDir) : [];
    const installedVersions = new Map(
      installed.map(({ flavor, version }) => [EXTRACTION_TO_TARGET[flavor] ?? flavor, version]),
    );
    const current =
      vscode.workspace.getConfiguration("scryer").get<string>("defaultTarget") ?? "mainline";
    const items = TARGET_CHOICES.map(({ id, detail }) => ({
      label: id,
      description: installedVersions.has(id)
        ? `${detail}  —  ${installedVersions.get(id)}`
        : detail,
      picked: id === current,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title: "Scryer: Select WoW Target",
      placeHolder: `Current: ${current}`,
    });
    if (picked) {
      await vscode.workspace
        .getConfiguration("scryer")
        .update("defaultTarget", picked.label, vscode.ConfigurationTarget.Workspace);
    }
  });
  context.subscriptions.push(selectFlavorCmd);

  const toggleRulerCmd = vscode.commands.registerCommand("scryer.toggleRuler", async () => {
    const cfg = vscode.workspace.getConfiguration("scryer");
    const current = cfg.get<boolean>("showRuler") ?? true;
    await cfg.update("showRuler", !current, vscode.ConfigurationTarget.Workspace);
  });
  context.subscriptions.push(toggleRulerCmd);

  const eyedropperCmd = vscode.commands.registerCommand("scryer.eyedropper", () => {
    (ScryerPanel.activePanel ?? ScryerLivePanel.activePanel)?.toggleEyedropper();
  });
  context.subscriptions.push(eyedropperCmd);

  const toggleGameInputCmd = vscode.commands.registerCommand("scryer.toggleGameInput", () => {
    (ScryerPanel.activePanel ?? ScryerLivePanel.activePanel)?.setCanvasMode("interact");
  });
  context.subscriptions.push(toggleGameInputCmd);

  const toggleGrabPanCmd = vscode.commands.registerCommand("scryer.toggleGrabPan", () => {
    (ScryerPanel.activePanel ?? ScryerLivePanel.activePanel)?.setCanvasMode("grab");
  });
  context.subscriptions.push(toggleGrabPanCmd);

  const recenterCanvasCmd = vscode.commands.registerCommand("scryer.recenterCanvas", () => {
    (ScryerPanel.activePanel ?? ScryerLivePanel.activePanel)?.recenterCanvas();
  });
  context.subscriptions.push(recenterCanvasCmd);

  const cmd = vscode.commands.registerCommand("scryer.open", (uri?: vscode.Uri) => {
    const resolved = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!resolved) {
      void vscode.window.showErrorMessage("Scryer: Open a .xml file first.");
      return;
    }
    if (!resolved.fsPath.endsWith(".xml")) {
      void vscode.window.showErrorMessage("Scryer: Active file is not an XML file.");
      return;
    }
    output.info(`Viewing ${path.basename(resolved.fsPath)}`);
    ScryerPanel.create(context, resolved, assets, output);
  });

  context.subscriptions.push(cmd);

  const liveCmd = vscode.commands.registerCommand("scryer.openLive", (uri?: vscode.Uri) => {
    const resolved = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!resolved) {
      void vscode.window.showErrorMessage("Scryer: Open a .toc file first.");
      return;
    }
    if (!resolved.fsPath.endsWith(".toc")) {
      void vscode.window.showErrorMessage("Scryer: Active file is not a TOC file.");
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
        void vscode.window.showErrorMessage("Scryer: No folder selected.");
        return;
      }
      const folderName = uri.fsPath.split(/[\\/]/).pop()!;
      const tocUri = vscode.Uri.joinPath(uri, `${folderName}.toc`);
      try {
        await vscode.workspace.fs.stat(tocUri);
      } catch {
        void vscode.window.showErrorMessage(
          `Scryer: No matching TOC file found (${folderName}.toc).`,
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
      "shared-templates": "cached shared templates, no textures",
      "all-templates": "all Blizzard templates cached, no textures",
      "all-templates-shared-textures":
        "all Blizzard templates cached, shared textures queued for pre-warm",
      "all-templates-textures": "all Blizzard templates cached, all textures queued for pre-warm",
    };
    void Promise.resolve().then(async () => {
      // Hold keepalive for the prewarm duration so the server stays warm for
      // the first panel that opens — release once the prewarm settles.
      assets.acquireKeepalive();
      try {
        await assets.ensureBlizzardFiles();
        await assets.ensureAtlasManifest();
        assets.loadBlizzardTemplates();
        if (cancelled) return;
        if (tierIdx >= TIER_ORDER.indexOf("all-templates-shared-textures")) {
          if (!(await assets.hasExtractedAssets())) {
            output.info(
              `cache-warmup: ${TIER_LABEL[startupContent] ?? startupContent} (startupContent=${startupContent})`,
            );
            const hint = !assets.installDir
              ? "Set scryer.installDir to enable extraction."
              : "Extraction was attempted — check Scryer output for errors.";
            output.warn(
              `cache-warmup: startupContent="${startupContent}" requests textures but no extracted assets found — skipping texture pre-warm. ${hint}`,
            );
          } else {
            await vscode.window.withProgress(
              { location: vscode.ProgressLocation.Window, title: "Scryer: Prewarming textures…" },
              () => assets.prewarmBlizzardTextures(SHARED_ADDON_NAMES),
            );
            if (cancelled) return;
            if (tierIdx >= TIER_ORDER.indexOf("all-templates-textures")) {
              await vscode.window.withProgress(
                {
                  location: vscode.ProgressLocation.Window,
                  title: "Scryer: Prewarming all textures…",
                },
                () => assets.prewarmBlizzardTextures(ADDON_NAMES),
              );
            }
            const textureScope =
              tierIdx >= TIER_ORDER.indexOf("all-templates-textures") ? "" : " shared";
            output.info(
              `cache-warmup: all Blizzard templates and${textureScope} textures cached (startupContent=${startupContent})`,
            );
          }
        } else {
          output.info(
            `cache-warmup: ${TIER_LABEL[startupContent] ?? startupContent} (startupContent=${startupContent})`,
          );
        }
      } finally {
        assets.releaseKeepalive();
      }
    });
  }

  // When userAddonPreload="workspace", scan the VS Code workspace for WoW XML files
  // and pre-warm their texture assets at activation so the first panel open is instant.
  const userAddonPreload =
    vscode.workspace.getConfiguration("scryer").get<string>("userAddonPreload") ?? "current-file";
  if (userAddonPreload === "workspace") {
    void Promise.resolve().then(async () => {
      const allXml = await vscode.workspace.findFiles("**/*.xml");
      const xmlFiles = await filterGitIgnored(allXml);
      output.info(`workspace-prewarm: scanning ${xmlFiles.length} XML file(s)`);
      const { frames: blizzardFrames, textures: blizzardTextures } = assets.loadBlizzardTemplates();
      for (const xmlUri of xmlFiles) {
        try {
          const bytes = await vscode.workspace.fs.readFile(xmlUri);
          const content = Buffer.from(bytes).toString("utf-8");
          const doc = parseXmlFile(xmlUri.fsPath, content);
          const [resolved] = resolveInheritance(
            [doc],
            blizzardFrames,
            { warnings: { count: 0 } },
            blizzardTextures,
          );
          if (!resolved) continue;
          const frames = resolved.frames.filter((f) => !f.virtual);
          const addonDir = path.dirname(xmlUri.fsPath);
          for (const rawPath of collectTexturePaths(frames)) {
            void assets.resolveToAbsPath(rawPath, addonDir);
          }
        } catch {
          // Not a WoW addon XML file; skip silently.
        }
      }

      // Loose BLPs: decode any addon-bundled BLP textures not captured by the XML scan.
      const blpUris = await filterGitIgnored(await vscode.workspace.findFiles("**/*.blp"));
      for (const uri of blpUris) {
        void assets.resolveToAbsPath(path.basename(uri.fsPath), path.dirname(uri.fsPath));
      }
      output.debug(`workspace-prewarm: queued ${blpUris.length} loose BLP(s) for decode`);

      // Loose SVGs: convert to PNG alongside the source if no PNG/TGA sibling exists.
      const svgUris = await filterGitIgnored(await vscode.workspace.findFiles("**/*.svg"));
      if (svgUris.length > 0) {
        const cfg = vscode.workspace.getConfiguration("scryer");
        const rsvgPath = cfg.get<string>("rsvgConvertPath") || undefined;
        if (!isSvgConverterAvailable(rsvgPath)) {
          output.warn(
            `workspace-prewarm: skipping ${svgUris.length} SVG(s) — rsvg-convert not found (install librsvg2-bin on Linux/macOS, or set scryer.rsvgConvertPath)`,
          );
        } else {
          const explicitConvert = cfg.get<string>("imageConvertPath") || undefined;
          const flipper = resolveFlipTool(explicitConvert);
          let pngCount = 0;
          let tgaCount = 0;
          for (const uri of svgUris) {
            const base = uri.fsPath.slice(0, -4); // strip .svg
            const hasPng = fs.existsSync(base + ".png");
            const hasTga = fs.existsSync(base + ".tga");
            if (hasPng && hasTga) continue;
            try {
              if (!hasPng) {
                await svgToPng(uri.fsPath, base + ".png", rsvgPath);
                pngCount++;
              }
              if (!hasTga && flipper) {
                await pngToTga(base + ".png", base + ".tga", flipper);
                tgaCount++;
              }
            } catch (err) {
              output.warn(
                `workspace-prewarm: SVG conversion failed for ${path.basename(uri.fsPath)}: ${String(err)}`,
              );
            }
          }
          if (pngCount > 0 || tgaCount > 0)
            output.info(
              `workspace-prewarm: converted ${pngCount} SVG(s) to PNG, ${tgaCount} to TGA`,
            );
        }
      }

      output.info("workspace-prewarm: done");
    });
  }
}

export function deactivate(): void {}
