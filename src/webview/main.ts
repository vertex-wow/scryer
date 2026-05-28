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

/** Inject or update the @font-face rule for the WoWDefaultFont family. */
function applyDefaultFont(uri: string): void {
  const id = "scryer-default-font";
  let style = document.getElementById(id) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = id;
    document.head.appendChild(style);
  }
  style.textContent = `@font-face { font-family: "WoWDefaultFont"; src: url("${uri}"); }`;
}

/** Apply a resolved asset URI to all texture elements sharing that path. */
function applyAsset(rawPath: string, uri: string): void {
  const selector = `[data-asset-path="${rawPath.replace(/"/g, '\\"')}"]`;
  const els = Array.from(viewport!.querySelectorAll<HTMLElement>(selector));
  for (const el of els) {
    el.style.backgroundImage = `url("${uri}")`;
    el.style.backgroundRepeat = "no-repeat";

    const raw = el.dataset.texCoords;
    if (raw) {
      const { left, right, top, bottom } = JSON.parse(raw) as {
        left: number;
        right: number;
        top: number;
        bottom: number;
      };
      // Use pixel math: CSS background-position percentages don't mean
      // "offset by N% of container" — they use a relative-to-(container - image)
      // coordinate that gives wrong results when the image exceeds the container.
      const bgW = el.offsetWidth / (right - left);
      const bgH = el.offsetHeight / (bottom - top);
      el.style.backgroundSize = `${bgW}px ${bgH}px`;
      el.style.backgroundPosition = `${-left * bgW}px ${-top * bgH}px`;
    } else {
      el.style.backgroundSize = "100% 100%";
      el.style.backgroundPosition = "0% 0%";
    }

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
        if (msg.defaultFontUri) applyDefaultFont(msg.defaultFontUri);
        viewport!.innerHTML = "";
        const root = renderFrames(msg.frames, msg.viewport, msg.flavorConfig);
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
