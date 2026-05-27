import * as vscode from "vscode";
import { AssetService } from "./assets/index.js";
import { ADDON_NAMES, SHARED_ADDON_NAMES } from "./parser/blizzard-registry.js";
import { ScryerPanel } from "./panel.js";

export function activate(context: vscode.ExtensionContext): void {
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
    ScryerPanel.create(context, resolved);
  });

  context.subscriptions.push(cmd);

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
    const output = vscode.window.createOutputChannel("Scryer", { log: true });
    context.subscriptions.push(output);
    const assets = AssetService.fromConfig(context, output);
    let cancelled = false;
    context.subscriptions.push({
      dispose: () => {
        cancelled = true;
      },
    });
    void Promise.resolve().then(async () => {
      assets.loadBlizzardTemplates();
      output.info(`[Scryer] startup: templates loaded (tier: ${startupContent})`);
      if (cancelled) return;
      if (tierIdx >= TIER_ORDER.indexOf("all-templates-shared-textures")) {
        await assets.prewarmBlizzardTextures(SHARED_ADDON_NAMES);
        output.info("[Scryer] startup: shared textures pre-warmed");
      }
      if (cancelled) return;
      if (tierIdx >= TIER_ORDER.indexOf("all-templates-textures")) {
        await assets.prewarmBlizzardTextures(ADDON_NAMES);
        output.info("[Scryer] startup: all textures pre-warmed");
      }
    });
  }
}

export function deactivate(): void {}
