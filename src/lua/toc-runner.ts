import * as nodePath from "path";
import type { LuaEngine } from "wasmoon";
import type { TocFile } from "../parser/toc.js";
import type { FrameIR } from "../parser/ir.js";
import { importXmlFile, type ImportContext } from "./xml-importer.js";

export interface TocRunnerOptions {
  toc: TocFile;
  addonDir: string;
  sandbox: LuaEngine;
  /** Blizzard virtual template registry from AssetService, or undefined if not available. */
  blizzardTemplates: Map<string, FrameIR> | undefined;
  /** Read file content by absolute path. Throws if the file is missing. */
  readFile: (absPath: string) => Promise<string>;
  output: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

/**
 * Execute the full TOC load sequence: pre-populate SavedVariables, iterate files
 * in order (Lua executed, XML instantiated), then fire ADDON_LOADED + PLAYER_LOGIN.
 *
 * Must be called after createSandbox() + registerWowApi() + registerFrameModel().
 */
export async function runTocAddon(opts: TocRunnerOptions): Promise<void> {
  const { toc, addonDir, sandbox, output } = opts;

  // Addon name from the TOC filename (strip any flavor suffix like _Mainline)
  const rawName = nodePath.basename(toc.sourceFile, nodePath.extname(toc.sourceFile));
  const addonName = rawName.replace(/_Mainline$|_Classic$|_Vanilla$|_BCC$|_WOTLKC$/i, "");

  // Pre-populate SavedVariables as empty tables (no persistence; hot-reload re-injection deferred)
  const svVars = [...toc.savedVariables, ...toc.savedVariablesPerChar];
  if (svVars.length > 0) {
    const init = svVars.map((v) => `if ${v} == nil then ${v} = {} end`).join("\n");
    try {
      await sandbox.doString(init);
    } catch (e) {
      output.error(`[TOC] Error initializing SavedVariables: ${e}`);
    }
  }

  // Import context accumulates this addon's own virtual templates across XML files
  const importCtx: ImportContext = {
    addonTemplates: new Map<string, FrameIR>(),
    blizzardTemplates: opts.blizzardTemplates,
    output: { warn: output.warn, error: output.error },
  };

  // Execute files in TOC order
  for (const file of toc.files) {
    const absPath = nodePath.join(addonDir, file.path.replace(/\\/g, "/"));
    let content: string;
    try {
      content = await opts.readFile(absPath);
    } catch {
      output.warn(`[TOC] Missing file: ${file.path}`);
      continue;
    }

    if (file.type === "lua") {
      try {
        await sandbox.doString(content);
      } catch (e) {
        output.error(`[TOC] Lua error in ${file.path}: ${e}`);
      }
    } else if (file.type === "xml") {
      await importXmlFile(content, absPath, sandbox, importCtx);
    }
  }

  // Fire ADDON_LOADED — frames that called RegisterEvent("ADDON_LOADED") in their
  // OnLoad handlers will receive this via __scryer_fire_event (defined in frame-class.lua).
  try {
    await sandbox.doString(
      `if type(__scryer_fire_event) == "function" then __scryer_fire_event("ADDON_LOADED", ${JSON.stringify(addonName)}) end`,
    );
  } catch (e) {
    output.error(`[TOC] Error firing ADDON_LOADED: ${e}`);
  }

  // Fire PLAYER_LOGIN — triggers post-init code in many addons
  try {
    await sandbox.doString(
      `if type(__scryer_fire_event) == "function" then __scryer_fire_event("PLAYER_LOGIN") end`,
    );
  } catch (e) {
    output.error(`[TOC] Error firing PLAYER_LOGIN: ${e}`);
  }
}
