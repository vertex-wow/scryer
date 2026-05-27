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

/** After a render, collect all unique [data-asset-path] values and request each. */
function requestRenderedAssets(): void {
  const els = Array.from(viewport!.querySelectorAll<HTMLElement>("[data-asset-path]"));
  const seen = new Set<string>();
  for (const el of els) {
    const p = el.dataset.assetPath;
    if (p && !seen.has(p)) {
      seen.add(p);
      vscode.postMessage({ type: "requestAsset", path: p });
    }
  }
}

/** Apply a resolved asset URI to all texture elements sharing that path. */
function applyAsset(rawPath: string, uri: string): void {
  const selector = `[data-asset-path="${rawPath.replace(/"/g, '\\"')}"]`;
  const els = Array.from(viewport!.querySelectorAll<HTMLElement>(selector));
  for (const el of els) {
    el.style.backgroundImage = `url("${uri}")`;
    el.style.backgroundSize = "100% 100%";
    el.style.backgroundRepeat = "no-repeat";
    // Remove the placeholder child so the real texture shows through.
    const ph = el.querySelector("[data-placeholder]");
    if (ph) ph.remove();
  }
}

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case "render":
    case "reload": {
      dbg(
        `render received — ${msg.frames.length} frame(s), viewport ${msg.viewport.w}x${msg.viewport.h}`,
      );
      try {
        viewport!.innerHTML = "";
        const root = renderFrames(msg.frames, msg.viewport);
        viewport!.appendChild(root);
        let suffix = " OK";
        if (msg.extractionPending)
          suffix = msg.pendingFiles > 0 ? ` — ${msg.pendingFiles} file(s) pending` : ` — pending`;
        else if (msg.warnings > 0) suffix = ` — ${msg.warnings} warning(s)`;
        dbg(`rendered ${msg.frames.length} frame(s)${suffix}`);
        requestRenderedAssets();
      } catch (e) {
        dbg(`render error: ${String(e)}`);
      }
      break;
    }

    case "assetResolved": {
      applyAsset(msg.path, msg.uri);
      break;
    }
  }
});

// Tell the host we're ready
dbg("posting ready");
vscode.postMessage({ type: "ready" });
