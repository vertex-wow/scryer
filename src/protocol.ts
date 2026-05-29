import type { FrameIR } from "./parser/ir.js";
import type { ResolvedFlavorConfig } from "./flavors/config.js";

export type { ResolvedFlavorConfig };

export interface Viewport {
  w: number;
  h: number;
}

// Extension host → webview
export type HostMessage =
  | {
      type: "render";
      frames: FrameIR[];
      viewport: Viewport;
      warnings: number;
      extractionPending: boolean;
      pendingFiles: number;
      flavorConfig: ResolvedFlavorConfig;
      /** Webview URI for the default font file, if it was resolved from the asset cache. */
      defaultFontUri?: string;
    }
  | {
      type: "reload";
      frames: FrameIR[];
      viewport: Viewport;
      warnings: number;
      extractionPending: boolean;
      pendingFiles: number;
      flavorConfig: ResolvedFlavorConfig;
      defaultFontUri?: string;
    }
  | { type: "assetResolved"; path: string; uri: string }
  | { type: "setRuler"; show: boolean };

// Webview → extension host
export type WebviewMessage =
  | { type: "ready" }
  | { type: "requestAsset"; path?: string; atlas?: string }
  | { type: "toggleRuler" }
  | {
      type: "frameEvent";
      frameId: number;
      event: "OnClick" | "OnEnter" | "OnLeave";
      extra?: unknown[];
    };
