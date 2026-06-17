import * as vscode from "vscode";
import type { HostMessage, WebviewMessage } from "../protocol.js";

export class PanelToolbar {
  public ephemeralSettings: Record<string, unknown> = {};
  public eyedropperActive = false;
  public lastEyedropperText: string | undefined;
  private lastCursorPos: { x: number; y: number } | undefined;

  constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly statusBar: vscode.StatusBarItem,
  ) {}

  public getSetting<T>(key: string): T {
    if (key in this.ephemeralSettings) {
      return this.ephemeralSettings[key] as T;
    }
    return vscode.workspace.getConfiguration("scryer").get<T>(key) as T;
  }

  public rulerMessage(): HostMessage {
    const show = this.getSetting<boolean>("showRuler") ?? true;
    return { type: "setRuler", show };
  }

  public updateStatusBar(): void {
    if (this.eyedropperActive && this.lastEyedropperText) {
      this.statusBar.text = `🔬 ${this.lastEyedropperText}`;
      this.statusBar.tooltip = "Eyedropper — Ctrl+C in preview to copy";
    } else {
      const pos = this.lastCursorPos ? ` ${this.lastCursorPos.x}, ${this.lastCursorPos.y}` : "";
      this.statusBar.text = `$(target)${pos}`;
      this.statusBar.tooltip = undefined;
    }
  }

  public toggleEyedropper(): void {
    this.eyedropperActive = !this.eyedropperActive;
    if (!this.eyedropperActive) this.lastEyedropperText = undefined;
    void this.panel.webview.postMessage({ type: "setEyedropper", active: this.eyedropperActive });
    this.updateStatusBar();
  }

  /**
   * Handles common toolbar-related messages.
   * Returns true if the message indicates a setting change that requires a re-render.
   */
  public handleMessage(msg: WebviewMessage): boolean {
    switch (msg.type) {
      case "toggleRuler": {
        const current = this.getSetting<boolean>("showRuler") ?? true;
        this.ephemeralSettings["showRuler"] = !current;
        this.updateStatusBar();
        void this.panel.webview.postMessage(this.rulerMessage());
        return false;
      }

      case "settingChange": {
        this.ephemeralSettings[msg.key] = msg.value;
        return true;
      }

      case "eyedropperOn": {
        this.eyedropperActive = true;
        this.updateStatusBar();
        return false;
      }

      case "eyedropperOff": {
        this.eyedropperActive = false;
        this.lastEyedropperText = undefined;
        this.updateStatusBar();
        return false;
      }

      case "eyedropperSample": {
        const { r, g, b, a, x, y } = msg;
        this.lastEyedropperText = this.formatColorForStatusBar(r, g, b, a, x, y);
        this.statusBar.text = `🔬 ${this.lastEyedropperText}`;
        this.statusBar.tooltip = "Eyedropper — Ctrl+C in preview to copy";
        return false;
      }

      case "eyedropperCopy": {
        void vscode.env.clipboard.writeText(msg.text);
        return false;
      }

      case "cursorMove": {
        this.lastCursorPos = { x: msg.x, y: msg.y };
        if (!this.eyedropperActive) this.updateStatusBar();
        return false;
      }

      case "cursorLeave": {
        this.lastCursorPos = undefined;
        if (!this.eyedropperActive) this.updateStatusBar();
        return false;
      }
    }
    return false;
  }

  private formatColorForStatusBar(
    r: number,
    g: number,
    b: number,
    a: number,
    x: number,
    y: number,
  ): string {
    const h = (n: number) => Math.round(n).toString(16).toUpperCase().padStart(2, "0");
    const hex = `#${h(r)}${h(g)}${h(b)}`;
    const wow = `|c${h(a)}${h(r)}${h(g)}${h(b)}`;
    const css = `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${(a / 255).toFixed(2)})`;
    const cc = `CreateColor(${(r / 255).toFixed(2)}, ${(g / 255).toFixed(2)}, ${(b / 255).toFixed(2)}, ${(a / 255).toFixed(2)})`;
    return `(${x}, ${y})  ${hex}  ${wow}  ${css}  ${cc}`;
  }
}
