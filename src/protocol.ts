import type { FrameIR } from "./parser/ir.js";
import type { ResolvedFlavorConfig } from "./flavors/config.js";
import type { CanvasMode } from "./constants.js";

export type { ResolvedFlavorConfig };

export interface Viewport {
  w: number;
  h: number;
}

export interface ToolbarState {
  flavor: string;
  locale: string;
  screenResolution: string;
  defaultCanvasMode: CanvasMode;
  workareaBackground: string;
  workareaBackgroundPath: string;
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
      customBackgroundUri?: string;
      customBackgroundIsFolder?: boolean;
      toolbarState: ToolbarState;
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
      customBackgroundUri?: string;
      customBackgroundIsFolder?: boolean;
      toolbarState: ToolbarState;
    }
  | { type: "assetResolved"; path: string; uri: string }
  | { type: "assetFailed"; path: string }
  | { type: "fontResolved"; uri: string }
  | { type: "setRuler"; show: boolean }
  | { type: "setStatus"; state: "idle" | "extracting" | "buildingAtlas" }
  | { type: "setEyedropper"; active: boolean }
  | { type: "setCanvasMode"; mode: CanvasMode }
  | { type: "recenterCanvas" };

// Webview → extension host
export type WebviewMessage =
  | { type: "ready" }
  | { type: "requestAsset"; path?: string; atlas?: string }
  | { type: "toggleRuler" }
  | { type: "dbg"; text: string }
  | {
      type: "frameEvent";
      frameId: number;
      event: "OnClick" | "OnEnter" | "OnLeave";
      extra?: unknown[];
    }
  | {
      type: "settingChange";
      key: "flavor" | "locale" | "screenResolution" | "defaultCanvasMode" | "workareaBackground";
      value: string;
    }
  | { type: "eyedropperOn" }
  | { type: "eyedropperOff" }
  | { type: "eyedropperSample"; r: number; g: number; b: number; a: number; x: number; y: number }
  | { type: "eyedropperCopy"; text: string };
