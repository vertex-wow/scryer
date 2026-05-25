import type { HostMessage, WebviewMessage } from "../protocol.js";
import { renderFrames } from "./renderer.js";

declare function acquireVsCodeApi(): {
  postMessage(msg: WebviewMessage): void;
};

const vscode = acquireVsCodeApi();

const viewport = document.getElementById("viewport");
const debug = document.getElementById("debug");
if (!viewport) throw new Error("Missing #viewport element");

function dbg(msg: string): void {
  if (debug) debug.textContent = msg;
}

dbg("script loaded — waiting for ready handshake");

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case "render":
    case "reload": {
      dbg(
        `render received — ${msg.frames.length} frame(s), viewport ${msg.viewport.w}x${msg.viewport.h}`,
      );
      try {
        viewport.innerHTML = "";
        const root = renderFrames(msg.frames, msg.viewport);
        viewport.appendChild(root);
        dbg(`rendered ${msg.frames.length} frame(s) OK`);
      } catch (e) {
        dbg(`render error: ${String(e)}`);
      }
      break;
    }
  }
});

// Tell the host we're ready
dbg("posting ready");
vscode.postMessage({ type: "ready" });
