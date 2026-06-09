import * as cp from "child_process";
import * as readline from "readline";

export interface ExtractionResult {
  ok: boolean;
  extracted: number;
  skipped: number;
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
  log?: (msg: string) => void;
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

    this.options.log?.(`[AssetClient] Starting server: ${this.options.binaryPath}`);

    this.serverProcess = cp.spawn(this.options.binaryPath, [
      "server",
      "--wow-dir",
      this.options.wowDir,
      "--out-dir",
      this.options.outDir,
      "--idle-timeout",
      this.options.idleTimeout.toString(),
    ]);

    if (!this.serverProcess.stdout || !this.serverProcess.stdin || !this.serverProcess.stderr) {
      throw new Error("Failed to start casc-server: missing stdio");
    }

    this.serverProcess.stderr.on("data", (data: Buffer) => {
      this.options.log?.(`[AssetServer log] ${data.toString().trim()}`);
    });

    this.serverProcess.on("exit", (code, signal) => {
      this.options.log?.(`[AssetClient] Server exited with code ${code} signal ${signal}`);
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
      this.options.log?.(`[AssetClient] Failed to start server: ${err.message}`);
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
        this.options.log?.(`[AssetClient] Failed to parse response: ${e}\nLine: ${line}`);
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
      return { ok: true, extracted: 0, skipped: 0, errors: 0 };
    }
    const res = await this.request<ExtractionResult>("extract", { paths });
    if (!res.ok) {
      throw new Error(res.error || "Unknown extraction error");
    }
    return {
      ok: res.ok,
      extracted: res.extracted,
      skipped: res.skipped,
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
