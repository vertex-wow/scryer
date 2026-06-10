import * as cp from "child_process";
import * as readline from "readline";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

const RUST_LEVEL_MAP: Record<string, LogLevel> = {
  TRACE: "trace",
  DEBUG: "debug",
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
};

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

function parseServerLogLine(raw: string): { level: LogLevel; msg: string; timeStr?: string } {
  const clean = raw.replace(ANSI_RE, "");
  const m = clean.match(
    /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})\.\d+Z\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+(.+)$/,
  );
  if (!m) return { level: "info", msg: clean };
  return { level: RUST_LEVEL_MAP[m[2]], msg: m[3], timeStr: m[1] };
}

export interface ExtractionResult {
  ok: boolean;
  extracted: number;
  /** Files in CASC index that could not be extracted locally (CDN-only stubs or encrypted). NOT "already cached". */
  unavailable: number;
  errors: number;
  error?: string;
}

export interface AssetStatus {
  ok: boolean;
  ready: boolean;
  buildHash?: string;
  idleTimeoutMs?: number;
}

export interface AssetClientOptions {
  binaryPath: string;
  wowDir: string;
  outDir: string;
  idleTimeout: number;
  log?: (level: LogLevel, msg: string, serverTime?: string) => void;
  logFile?: string;
}

export class AssetClient {
  private serverProcess: cp.ChildProcess | null = null;
  private requestIdCounter = 0;
  private pendingRequests: Map<
    number,
    { resolve: (val: unknown) => void; reject: (err: unknown) => void }
  > = new Map();
  private rl: readline.Interface | null = null;
  private options: AssetClientOptions;

  constructor(options: AssetClientOptions) {
    this.options = options;
  }

  private async ensureRunning(): Promise<void> {
    if (this.serverProcess && !this.serverProcess.killed) {
      return;
    }

    this.options.log?.("info", `client: Starting server: ${this.options.binaryPath}`);

    const args = [
      "server",
      "--wow-dir",
      this.options.wowDir,
      "--out-dir",
      this.options.outDir,
      "--idle-timeout",
      this.options.idleTimeout.toString(),
    ];
    if (this.options.logFile) {
      args.unshift("--log-file", this.options.logFile);
    }

    this.serverProcess = cp.spawn(this.options.binaryPath, args);

    if (!this.serverProcess.stdout || !this.serverProcess.stdin || !this.serverProcess.stderr) {
      throw new Error("Failed to start casc-server: missing stdio");
    }

    this.serverProcess.stderr.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const { level, msg, timeStr } = parseServerLogLine(trimmed);
        this.options.log?.(level, msg, timeStr);
      }
    });

    this.serverProcess.on("exit", (code, signal) => {
      this.options.log?.("info", `client: Server exited with code ${code} signal ${signal}`);
      this.serverProcess = null;
      this.rl?.close();
      this.rl = null;

      // Reject any pending requests
      const err = new Error("Server process exited");
      for (const req of this.pendingRequests.values()) {
        req.reject(err);
      }
      this.pendingRequests.clear();
    });

    this.serverProcess.on("error", (err) => {
      this.options.log?.("error", `client: Failed to start server: ${err.message}`);
      this.serverProcess = null;
      const rejectErr = new Error(`Failed to start server: ${err.message}`);
      for (const req of this.pendingRequests.values()) {
        req.reject(rejectErr);
      }
      this.pendingRequests.clear();
    });

    this.rl = readline.createInterface({
      input: this.serverProcess.stdout,
      terminal: false,
    });

    this.rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const res = JSON.parse(line);
        if (typeof res.id === "number") {
          const req = this.pendingRequests.get(res.id);
          if (req) {
            this.pendingRequests.delete(res.id);
            req.resolve(res);
          }
        }
      } catch (e) {
        this.options.log?.("warn", `client: Failed to parse response: ${e}\nLine: ${line}`);
      }
    });

    // Wait a brief moment to ensure it didn't crash immediately
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (!this.serverProcess) {
      throw new Error("Server process crashed immediately on startup");
    }
  }

  private async request<T>(method: string, payload: Record<string, unknown> = {}): Promise<T> {
    await this.ensureRunning();

    return new Promise((resolve, reject) => {
      const id = ++this.requestIdCounter;
      this.pendingRequests.set(id, { resolve: resolve as (val: unknown) => void, reject });

      const req = {
        id,
        method,
        ...payload,
      };

      const json = JSON.stringify(req) + "\n";
      this.serverProcess!.stdin!.write(json, (err) => {
        if (err) {
          this.pendingRequests.delete(id);
          reject(err);
        }
      });
    });
  }

  public async extractFiles(paths: string[]): Promise<ExtractionResult> {
    if (paths.length === 0) {
      return { ok: true, extracted: 0, unavailable: 0, errors: 0 };
    }
    this.options.log?.("info", `client: Sending extract request: ${paths.length} path(s)/glob(s)`);
    const res = await this.request<ExtractionResult>("extract", { paths });
    if (!res.ok) {
      throw new Error(res.error || "Unknown extraction error");
    }
    return {
      ok: res.ok,
      extracted: res.extracted,
      unavailable: res.unavailable,
      errors: res.errors,
    };
  }

  public async status(): Promise<AssetStatus> {
    const res = await this.request<AssetStatus>("status");
    return {
      ok: res.ok,
      ready: res.ready,
      buildHash: res.buildHash,
      idleTimeoutMs: res.idleTimeoutMs,
    };
  }

  public async shutdown(): Promise<void> {
    if (!this.serverProcess || this.serverProcess.killed) return;
    try {
      await this.request("shutdown");
    } catch {
      // Ignore errors on shutdown
    }
    this.serverProcess = null;
  }
}
