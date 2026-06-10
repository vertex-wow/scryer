import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/**
 * A wrapper around vscode.LogOutputChannel that mirrors all log output to a
 * disk file in addition to the VS Code Output panel.
 */
export class TeeLogOutputChannel implements vscode.LogOutputChannel {
  private fileStream: fs.WriteStream | null = null;
  private lastDate: string | null = null;

  constructor(private readonly channel: vscode.LogOutputChannel) {}

  /**
   * Updates the file path where logs should be written.
   * If a file is already open, it is closed first.
   */
  setLogFile(filePath: string | null): void {
    if (this.fileStream) {
      this.fileStream.close();
      this.fileStream = null;
    }
    this.lastDate = null;
    if (filePath) {
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        this.fileStream = fs.createWriteStream(filePath, { flags: "w" });
      } catch (err) {
        this.channel.error(`Failed to open log file ${filePath}: ${String(err)}`);
      }
    }
  }

  logServer(
    level: "trace" | "debug" | "info" | "warn" | "error",
    msg: string,
    serverTime: string,
  ): void {
    const clean = stripAnsi(msg);
    this.writeLine(level, clean, [], serverTime);
    try {
      this.channel[level](clean);
    } catch {
      // channel was disposed
    }
  }

  private writeLine(level: string, message: string, args: unknown[], timeOverride?: string): void {
    if (!this.fileStream) return;

    const now = new Date();
    const dateStr =
      now.getFullYear() +
      "-" +
      String(now.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(now.getDate()).padStart(2, "0");
    const timeStr =
      timeOverride ??
      String(now.getHours()).padStart(2, "0") +
        ":" +
        String(now.getMinutes()).padStart(2, "0") +
        ":" +
        String(now.getSeconds()).padStart(2, "0");

    if (this.lastDate !== dateStr) {
      const prefix = this.lastDate === null ? "" : "\n";
      this.fileStream.write(`${prefix}${dateStr}:\n`);
      this.lastDate = dateStr;
    }

    let formatted = message;
    if (args && args.length > 0) {
      formatted +=
        " " + args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
    }

    formatted = stripAnsi(formatted);

    const shortLevel = level.charAt(0).toLowerCase();
    this.fileStream.write(`${timeStr} [${shortLevel}] ${formatted}\n`);
  }

  // --- vscode.LogOutputChannel implementation ---

  get name(): string {
    return this.channel.name;
  }

  append(value: string): void {
    this.channel.append(stripAnsi(value));
  }

  appendLine(value: string): void {
    this.channel.appendLine(stripAnsi(value));
  }

  replace(value: string): void {
    this.channel.replace(stripAnsi(value));
  }

  clear(): void {
    this.channel.clear();
  }

  show(columnOrPreserveFocus?: vscode.ViewColumn | boolean, preserveFocus?: boolean): void {
    if (typeof columnOrPreserveFocus === "boolean") {
      this.channel.show(columnOrPreserveFocus);
    } else if (columnOrPreserveFocus !== undefined) {
      this.channel.show(columnOrPreserveFocus, preserveFocus);
    } else {
      this.channel.show();
    }
  }

  hide(): void {
    this.channel.hide();
  }

  dispose(): void {
    this.channel.dispose();
    if (this.fileStream) {
      this.fileStream.close();
      this.fileStream = null;
    }
  }

  get logLevel(): vscode.LogLevel {
    return this.channel.logLevel;
  }

  get onDidChangeLogLevel(): vscode.Event<vscode.LogLevel> {
    return this.channel.onDidChangeLogLevel;
  }

  trace(message: string, ...args: unknown[]): void {
    const clean = stripAnsi(message);
    this.writeLine("trace", clean, args);
    this.channel.trace(clean, ...args);
  }

  debug(message: string, ...args: unknown[]): void {
    const clean = stripAnsi(message);
    this.writeLine("debug", clean, args);
    this.channel.debug(clean, ...args);
  }

  info(message: string, ...args: unknown[]): void {
    const clean = stripAnsi(message);
    this.writeLine("info", clean, args);
    this.channel.info(clean, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    const clean = stripAnsi(message);
    this.writeLine("warn", clean, args);
    this.channel.warn(clean, ...args);
  }

  error(error: string | Error, ...args: unknown[]): void {
    const msg = error instanceof Error ? error.stack || error.message : String(error);
    const clean = stripAnsi(msg);
    this.writeLine("error", clean, args);
    this.channel.error(error instanceof Error ? error : clean, ...args);
  }
}
