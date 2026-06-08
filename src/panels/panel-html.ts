import * as vscode from "vscode";
import { resolveFlavorConfig } from "../flavors/config.js";
import { FLAVOR_INFO, listInstalledFlavors } from "../assets/build-info.js";
import { buildLocaleDropdownHtml } from "../webview/components/locale-dropdown.js";
import {
  WORKAREA_BG_BLACK,
  WORKAREA_BG_CHECKERBOARD_DARK_COLOR1,
  WORKAREA_BG_CHECKERBOARD_DARK_COLOR2,
  WORKAREA_BG_CHECKERBOARD_LIGHT_COLOR1,
  WORKAREA_BG_CHECKERBOARD_LIGHT_COLOR2,
  WORKAREA_BG_GRAY,
  WORKAREA_BG_MAGENTA,
  WORKAREA_BG_WHITE,
  ZOOM_PRESETS,
} from "../constants.js";

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 32; i++) result += chars[Math.floor(Math.random() * chars.length)];
  return result;
}

export interface PanelHtmlOptions {
  title: string;
  webview: vscode.Webview;
  extensionUri: vscode.Uri;
  flavor: string;
  locale: string;
  screenResolution: string;
  workareaBackground: string;
  workareaBackgroundPath: string;
}

export function buildPanelHtml(options: PanelHtmlOptions): string {
  const {
    title,
    webview,
    extensionUri,
    flavor,
    locale,
    screenResolution,
    workareaBackground,
    workareaBackgroundPath,
  } = options;
  const nonce = getNonce();
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview.js"));
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");

  const cfg = vscode.workspace.getConfiguration("scryer");
  const userConfigPath = cfg.get<string>("flavorConfigPath") || undefined;
  const c = resolveFlavorConfig(flavor, userConfigPath);

  const sbH = c.statusBarHeight;
  const rsz = c.rulerSize;
  const s = (val: string, target: string) => (val === target ? " selected" : "");
  const installDir = cfg.get<string>("installDir") ?? "";
  const installed = new Set(
    installDir ? listInstalledFlavors(installDir).map((f) => f.flavor) : [],
  );

  const flavorOptionsHtml = Object.keys(FLAVOR_INFO)
    .map((key) => {
      const label = key
        .split("_")
        .map((w) => w[0].toUpperCase() + w.slice(1))
        .join(" ");
      const mark = installed.has(key) ? " ✓" : "";
      return `<div class="dropdown-item${s(flavor, key)}" data-value="${key}">
        <span class="dropdown-item-text">${label}${mark}</span>
      </div>`;
    })
    .join("\n        ");

  const currentFlavorLabelParts = flavor
    .split("_")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
  const currentFlavorMark = installed.has(flavor) ? " ✓" : "";
  const flavorLabel = currentFlavorLabelParts + currentFlavorMark;

  const [rw, rh] = screenResolution.split("x").map(Number);
  const currentUiParentWidth = Math.round((768 * rw) / rh);

  const getAspectRatio = (w: number, h: number) => {
    const ratio = w / h;
    if (Math.abs(ratio - 16 / 9) < 0.05) return "16:9";
    if (Math.abs(ratio - 16 / 10) < 0.05) return "16:10";
    if (Math.abs(ratio - 21 / 9) < 0.05) return "21:9";
    if (Math.abs(ratio - 4 / 3) < 0.05) return "4:3";
    const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
    const div = gcd(w, h);
    return `${w / div}:${h / div}`;
  };
  const currentAspect = getAspectRatio(rw, rh);
  const resolutionTitle = `Native Screen Resolution&#10;${currentAspect} ${screenResolution} = ${currentUiParentWidth}x768 in-game`;

  const resOpt = (res: string) => {
    const [w, h] = res.split("x").map(Number);
    const gw = Math.round((768 * w) / h);
    return `<div class="dropdown-item${s(screenResolution, res)}" data-value="${res}" title="${res} = ${gw}x768 in-game">
      <span class="dropdown-item-text">${res}</span>
    </div>`;
  };
  const resHeader = (text: string) =>
    `<div class="dropdown-item disabled"><span class="dropdown-item-text">${text}</span></div>`;

  const bgLabelMap: Record<string, string> = {
    checkerBoardAuto: "Checkerboard (Auto)",
    checkerBoard: "Checkerboard (Dark)",
    checkerBoardLight: "Checkerboard (Light)",
    black: "Black",
    white: "White",
    neutralGray: "Neutral Gray (50%)",
    magenta: "Magenta (Debug)",
    custom: workareaBackgroundPath ? workareaBackgroundPath : "Custom...",
  };
  const bgLabel = bgLabelMap[workareaBackground] ?? workareaBackground;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>${title}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{overflow:hidden;position:fixed;inset:0;user-select:none;background:var(--vscode-editor-background)}
    #viewport{position:absolute;top:0;left:0;transform-origin:0 0;will-change:transform}
    #status-bar{position:fixed;top:0;left:0;right:0;height:${sbH}px;background:${c.statusBarBg};display:flex;align-items:center;z-index:10001;border-bottom:1px solid ${c.rulerBorder};font:${c.toolbarFont};color:${c.statusBarColor};white-space:nowrap;overflow:visible}
    .toolbar-btn{flex-shrink:0;background:none;border:none;border-right:1px solid ${c.rulerBorder};cursor:pointer;height:${sbH}px;padding:0 7px;display:flex;align-items:center;justify-content:center;font-size:14px;color:${c.statusBarColor};opacity:0.55}
    .toolbar-btn:hover{background:rgba(255,255,255,0.07);opacity:0.85}
    .toolbar-btn.active{background:rgba(74,158,255,0.12);opacity:1;box-shadow:inset 0 -2px 0 #4a9eff}
    .ruler-icon{filter:sepia(1) saturate(8) hue-rotate(-30deg) brightness(0.85);display:inline-block}
    .toolbar-btn:hover .ruler-icon,.toolbar-btn.active .ruler-icon{filter:sepia(1) saturate(8) hue-rotate(-30deg) brightness(1.15)}
    #locale-dropdown{justify-content:center;padding:0 8px}
    .locale-stack{display:flex;flex-direction:column;align-items:center;line-height:1;font-size:10px;margin-top:2px;font-family:monospace}
    .locale-single{font-family:monospace;font-size:12px}
    .custom-dropdown{flex-shrink:0;background:none;border:none;color:${c.statusBarColor};font:${c.toolbarFont};outline:none;position:relative;display:flex;align-items:center;border-right:1px solid ${c.rulerBorder};padding:0 8px;height:${sbH}px;cursor:pointer;opacity:0.7}
    .custom-dropdown:hover{background:rgba(255,255,255,0.07);opacity:1}
    .custom-dropdown-trigger{display:flex;align-items:center;gap:4px}
    .dropdown-trigger-label{font:${c.toolbarFont};color:${c.statusBarColor}}
    .custom-dropdown-menu{position:absolute;top:${sbH}px;left:0;background:var(--vscode-dropdown-background);border:1px solid var(--vscode-dropdown-border);color:var(--vscode-dropdown-foreground);display:none;flex-direction:column;min-width:180px;z-index:10002;box-shadow:0 4px 6px rgba(0,0,0,0.3)}
    .custom-dropdown-menu:not(.hidden){display:flex}
    .dropdown-item{padding:4px 8px;display:flex;align-items:center;gap:6px;font:${c.toolbarFont};cursor:pointer}
    .dropdown-item:hover{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}
    .dropdown-item.selected{background:var(--vscode-list-inactiveSelectionBackground)}
    .dropdown-item.disabled{opacity:0.45;font-style:italic;cursor:default;pointer-events:none}
    .dropdown-item-preview{width:14px;height:14px;border:1px solid rgba(255,255,255,0.2);border-radius:2px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:12px}
    #bg-preview{width:14px;height:14px;border:1px solid rgba(255,255,255,0.2);border-radius:2px;flex-shrink:0;pointer-events:none}
    .bg-preview-auto{background:repeating-conic-gradient(${WORKAREA_BG_CHECKERBOARD_DARK_COLOR1} 0% 25%, ${WORKAREA_BG_CHECKERBOARD_DARK_COLOR2} 0% 50%) 50% / 10px 10px}
    body.vscode-light .bg-preview-auto{background:repeating-conic-gradient(${WORKAREA_BG_CHECKERBOARD_LIGHT_COLOR1} 0% 25%, ${WORKAREA_BG_CHECKERBOARD_LIGHT_COLOR2} 0% 50%) 50% / 10px 10px}
    .bg-preview-dark{background:repeating-conic-gradient(${WORKAREA_BG_CHECKERBOARD_DARK_COLOR1} 0% 25%, ${WORKAREA_BG_CHECKERBOARD_DARK_COLOR2} 0% 50%) 50% / 10px 10px}
    .bg-preview-light{background:repeating-conic-gradient(${WORKAREA_BG_CHECKERBOARD_LIGHT_COLOR1} 0% 25%, ${WORKAREA_BG_CHECKERBOARD_LIGHT_COLOR2} 0% 50%) 50% / 10px 10px}
    .bg-preview-black{background:${WORKAREA_BG_BLACK}}
    .bg-preview-white{background:${WORKAREA_BG_WHITE}}
    .bg-preview-gray{background:${WORKAREA_BG_GRAY}}
    .bg-preview-magenta{background:${WORKAREA_BG_MAGENTA}}
    #debug{padding:0 4px;white-space:pre-wrap;font:${c.statusTextFont}}
    #ruler-top{position:fixed;top:${sbH}px;left:0;right:0;height:${rsz}px;z-index:9999;display:none}
    #ruler-left{position:fixed;top:${sbH}px;left:0;bottom:0;width:${rsz}px;z-index:9999;display:none}
    #ruler-corner{position:fixed;top:${sbH}px;left:0;width:${rsz}px;height:${rsz}px;z-index:10000;background:${c.rulerBg};border-right:1px solid ${c.rulerBorder};border-bottom:1px solid ${c.rulerBorder};display:none}
    body.show-ruler #ruler-top,body.show-ruler #ruler-left,body.show-ruler #ruler-corner{display:block}
    body.mode-grab{cursor:grab}
    body.mode-grab.panning{cursor:grabbing}
    body.mode-grab #viewport *{pointer-events:none}
    body.mode-eyedropper{cursor:crosshair}
  </style>
</head>
<body>
  <div id="status-bar">
    <button id="ruler-toggle" class="toolbar-btn" title="Toggle pixel ruler"><span class="ruler-icon">📏</span></button>
    <button id="interact-toggle" class="toolbar-btn" title="Interact — normal mouse cursor"><svg width="10" height="13" viewBox="0 0 10 13" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><polygon points="0,0 0,10 2.5,7.5 4.5,12.5 6,12 4,7 7.5,7"/></svg></button>
    <button id="grab-toggle" class="toolbar-btn" title="Grab — pan and zoom (drag · middle-drag · space-drag · ctrl+scroll · ctrl+0 fit · ctrl+shift+0 reset)"><svg width="12" height="13" viewBox="0 0 12 13" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="2" width="2" height="6" rx="1"/><rect x="4" y="0" width="2" height="8" rx="1"/><rect x="7" y="0" width="2" height="8" rx="1"/><rect x="10" y="2" width="2" height="6" rx="1"/><rect x="0" y="7" width="12" height="6" rx="2"/></svg></button>
    <button id="recenter-btn" class="toolbar-btn" title="Re-center canvas"><svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.4" xmlns="http://www.w3.org/2000/svg"><circle cx="6.5" cy="6.5" r="2.8"/><line x1="6.5" y1="0.5" x2="6.5" y2="3.7"/><line x1="6.5" y1="9.3" x2="6.5" y2="12.5"/><line x1="0.5" y1="6.5" x2="3.7" y2="6.5"/><line x1="9.3" y1="6.5" x2="12.5" y2="6.5"/></svg></button>
    <button id="eyedropper-toggle" class="toolbar-btn" title="Eyedropper &mdash; sample pixel color (Ctrl+C to copy)"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M13.354.646a1.207 1.207 0 0 0-1.708 0L8.5 3.793l-.646-.647a.5.5 0 1 0-.708.708L8.293 5l-7.147 7.146A.5.5 0 0 0 1 12.5v1.793l-.854.853a.5.5 0 1 0 .708.707L1.707 15H3.5a.5.5 0 0 0 .354-.146L11 7.707l1.146 1.147a.5.5 0 0 0 .708-.708l-.647-.646 3.147-3.146a1.207 1.207 0 0 0 0-1.708zM2 12.707l7-7L10.293 7l-7 7H2z"/></svg></button>
    <div id="bg-dropdown" class="custom-dropdown" title="Workarea Background&#10;${bgLabel}">
      <div id="bg-dropdown-trigger" class="custom-dropdown-trigger">
        <div id="bg-preview"></div>
        <span class="dropdown-trigger-label">bg</span>
      </div>
      <div id="bg-dropdown-menu" class="custom-dropdown-menu hidden">
        <div class="dropdown-item${s(workareaBackground, "checkerBoardAuto")}" data-value="checkerBoardAuto">
          <div class="dropdown-item-preview bg-preview-auto"></div>
          <span class="dropdown-item-text">Checkerboard (Auto)</span>
        </div>
        <div class="dropdown-item${s(workareaBackground, "checkerBoard")}" data-value="checkerBoard">
          <div class="dropdown-item-preview bg-preview-dark"></div>
          <span class="dropdown-item-text">Checkerboard (Dark)</span>
        </div>
        <div class="dropdown-item${s(workareaBackground, "checkerBoardLight")}" data-value="checkerBoardLight">
          <div class="dropdown-item-preview bg-preview-light"></div>
          <span class="dropdown-item-text">Checkerboard (Light)</span>
        </div>
        <div class="dropdown-item${s(workareaBackground, "black")}" data-value="black">
          <div class="dropdown-item-preview bg-preview-black"></div>
          <span class="dropdown-item-text">Black</span>
        </div>
        <div class="dropdown-item${s(workareaBackground, "white")}" data-value="white">
          <div class="dropdown-item-preview bg-preview-white"></div>
          <span class="dropdown-item-text">White</span>
        </div>
        <div class="dropdown-item${s(workareaBackground, "neutralGray")}" data-value="neutralGray">
          <div class="dropdown-item-preview bg-preview-gray"></div>
          <span class="dropdown-item-text">Neutral Gray (50%)</span>
        </div>
        <div class="dropdown-item${s(workareaBackground, "magenta")}" data-value="magenta">
          <div class="dropdown-item-preview bg-preview-magenta"></div>
          <span class="dropdown-item-text">Magenta (Debug)</span>
        </div>
        <div class="dropdown-item${s(workareaBackground, "custom")}" data-value="custom" title="Custom background image or folder&#10;Configure via 'scryer.workareaBackgroundPath' in settings">
          <div class="dropdown-item-preview" id="custom-bg-preview">🖼️</div>
          <span class="dropdown-item-text" id="custom-bg-label">${workareaBackgroundPath ? workareaBackgroundPath : "Custom..."}</span>
        </div>
      </div>
    </div>
    <div id="flavor-dropdown" class="custom-dropdown" title="WoW flavor (✓ = installed)">
      <div id="flavor-dropdown-trigger" class="custom-dropdown-trigger">
        <span class="dropdown-trigger-label">${flavorLabel}</span>
      </div>
      <div id="flavor-dropdown-menu" class="custom-dropdown-menu hidden">
        ${flavorOptionsHtml}
      </div>
    </div>
    <div id="resolution-dropdown" class="custom-dropdown" title="${resolutionTitle}">
      <div id="resolution-dropdown-trigger" class="custom-dropdown-trigger">
        <span class="dropdown-trigger-label">${screenResolution}</span>
      </div>
      <div id="resolution-dropdown-menu" class="custom-dropdown-menu hidden">
        ${resHeader("=16:9=")}
        ${resOpt("1280x720")}
        ${resOpt("1920x1080")}
        ${resOpt("2560x1440")}
        ${resOpt("3840x2160")}
        ${resHeader("=16:10=")}
        ${resOpt("1440x900")}
        ${resOpt("1920x1200")}
        ${resOpt("2560x1600")}
        ${resHeader("=21:9=")}
        ${resOpt("1720x720")}
        ${resOpt("2580x1080")}
        ${resOpt("3440x1440")}
        ${resHeader("=4:3=")}
        ${resOpt("800x600")}
        ${resOpt("1024x768")}
      </div>
    </div>
    ${buildLocaleDropdownHtml(locale)}
    <div id="zoom-dropdown" class="custom-dropdown" title="Zoom level">
      <div id="zoom-dropdown-trigger" class="custom-dropdown-trigger">
        <span class="dropdown-trigger-label" id="zoom-dropdown-label">100%</span>
      </div>
      <div id="zoom-dropdown-menu" class="custom-dropdown-menu hidden">
        <div class="dropdown-item" data-value="fit">
          <span class="dropdown-item-text">Fit</span>
        </div>
${ZOOM_PRESETS.map(
  (pct) => `        <div class="dropdown-item${pct === 100 ? " selected" : ""}" data-value="${pct}">
          <span class="dropdown-item-text">${pct}%</span>
        </div>`,
).join("\n")}
      </div>
    </div>
    <span id="debug">script not yet loaded</span>
  </div>
  <div id="viewport"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
