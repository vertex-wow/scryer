import type { HostMessage, WebviewMessage } from "../protocol.js";
import { renderFrames } from "./renderer.js";

declare function acquireVsCodeApi(): {
  postMessage(msg: WebviewMessage): void;
};

const vscode = acquireVsCodeApi();

const viewport = document.getElementById("viewport");
if (!viewport) throw new Error("Missing #viewport element");

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case "render":
    case "reload": {
      viewport.innerHTML = "";
      const root = renderFrames(msg.frames, msg.viewport);
      viewport.appendChild(root);
      break;
    }
  }
});

// Tell the host we're ready
vscode.postMessage({ type: "ready" });
