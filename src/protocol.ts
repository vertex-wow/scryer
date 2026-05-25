import type { FrameIR } from "./parser/ir.js";

export interface Viewport {
  w: number;
  h: number;
}

// Extension host → webview
export type HostMessage =
  | { type: "render"; frames: FrameIR[]; viewport: Viewport }
  | { type: "reload"; frames: FrameIR[]; viewport: Viewport }
  | { type: "assetResolved"; path: string; uri: string };

// Webview → extension host
export type WebviewMessage =
  | { type: "ready" }
  | { type: "requestAsset"; path?: string; atlas?: string };
