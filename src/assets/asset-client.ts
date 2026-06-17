import * as cp from "child_process";
import * as readline from "readline";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";
export type Priority = "user" | "prewarm";

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

function isGlob(p: string): boolean {
  return /[*?[]/.test(p);
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
  /** URLs to fetch community TACT keys from, tried in order. */
  tactKeysUrls?: string[];
}

interface QueuedJob {
  paths: string[];
  cdnEnabled: boolean;
  priority: Priority;
  resolve: (result: ExtractionResult) => void;
  reject: (err: unknown) => void;
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

  private readonly extractQueue: QueuedJob[] = [];
  private extracting = false;

  private keepaliveRefcount = 0;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: AssetClientOptions) {
    this.options = options;
  }

  /**
   * Increment the keepalive ref-count. While the count is > 0, a heartbeat timer
   * pings `status` every idleTimeout/2 seconds to keep an already-running server
   * alive. The server is NOT started just for the heartbeat — if it isn't running
   * the ping is silently skipped.
   */
  acquireKeepalive(): void {
    this.keepaliveRefcount++;
    if (this.keepaliveRefcount === 1) {
      const intervalMs = Math.max(1000, this.options.idleTimeout * 500);
      this.keepaliveTimer = setInterval(() => {
        if (this.serverProcess && !this.serverProcess.killed) {
          void this.status().catch(() => {});
        }
      }, intervalMs);
    }
  }

  /** Decrement the keepalive ref-count. When it reaches 0 the heartbeat stops. */
  releaseKeepalive(): void {
    if (this.keepaliveRefcount <= 0) return;
    this.keepaliveRefcount--;
    if (this.keepaliveRefcount === 0 && this.keepaliveTimer !== null) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
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
    if (this.options.tactKeysUrls && this.options.tactKeysUrls.length > 0) {
      args.push("--tact-keys-urls", ...this.options.tactKeysUrls);
    }
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

      const err = new Error("Server process exited");
      for (const req of this.pendingRequests.values()) {
        req.reject(err);
      }
      this.pendingRequests.clear();

      // Reject queued jobs that haven't started yet. drainQueue's finally block
      // resets extracting once the in-flight doExtract throws.
      for (const job of this.extractQueue) {
        job.reject(err);
      }
      this.extractQueue.length = 0;
    });

    this.serverProcess.on("error", (err) => {
      this.options.log?.("error", `client: Failed to start server: ${err.message}`);
      this.serverProcess = null;
      const rejectErr = new Error(`Failed to start server: ${err.message}`);
      for (const req of this.pendingRequests.values()) {
        req.reject(rejectErr);
      }
      this.pendingRequests.clear();

      for (const job of this.extractQueue) {
        job.reject(rejectErr);
      }
      this.extractQueue.length = 0;
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

  /** Remove paths that appear in pending prewarm jobs (exact-path jobs only, no globs). */
  private promoteFromPrewarm(userPaths: string[]): void {
    if (userPaths.some(isGlob)) return;
    const userSet = new Set(userPaths.map((p) => p.toLowerCase()));
    for (let i = this.extractQueue.length - 1; i >= 0; i--) {
      const job = this.extractQueue[i];
      if (job.priority !== "prewarm" || job.paths.some(isGlob)) continue;
      job.paths = job.paths.filter((p) => !userSet.has(p.toLowerCase()));
      if (job.paths.length === 0) {
        this.extractQueue.splice(i, 1);
        job.resolve({ ok: true, extracted: 0, unavailable: 0, errors: 0 });
      }
    }
  }

  private enqueue(job: QueuedJob): void {
    if (job.priority === "user") {
      this.promoteFromPrewarm(job.paths);
      const insertAt = this.extractQueue.findIndex((j) => j.priority === "prewarm");
      if (insertAt === -1) {
        this.extractQueue.push(job);
      } else {
        this.extractQueue.splice(insertAt, 0, job);
      }
    } else {
      this.extractQueue.push(job);
    }
  }

  private async doExtract(paths: string[], cdnEnabled: boolean): Promise<ExtractionResult> {
    this.options.log?.("info", `client: Sending extract request: ${paths.length} path(s)/glob(s)`);
    const res = await this.request<ExtractionResult>("extract", { paths, cdnEnabled });
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

  private async drainQueue(): Promise<void> {
    if (this.extracting) return;
    this.extracting = true;
    try {
      while (this.extractQueue.length > 0) {
        const job = this.extractQueue.shift()!;
        try {
          const result = await this.doExtract(job.paths, job.cdnEnabled);
          job.resolve(result);
        } catch (err) {
          job.reject(err);
          // If the server crashed, the crash handler has already cleared the queue,
          // so the while condition exits naturally on the next iteration.
        }
      }
    } finally {
      this.extracting = false;
    }
  }

  public extractFiles(
    paths: string[],
    cdnEnabled = false,
    priority: Priority = "prewarm",
  ): Promise<ExtractionResult> {
    if (paths.length === 0) {
      return Promise.resolve({ ok: true, extracted: 0, unavailable: 0, errors: 0 });
    }
    return new Promise((resolve, reject) => {
      this.enqueue({ paths, cdnEnabled, priority, resolve, reject });
      void this.drainQueue();
    });
  }

  public async readFileBytes(path: string, cdnEnabled = false): Promise<Buffer | null> {
    const res = await this.request<{ ok: boolean; data?: string; error?: string }>("readFile", {
      path,
      cdnEnabled,
    });
    if (!res.ok || !res.data) return null;
    return Buffer.from(res.data, "base64");
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
    this.keepaliveRefcount = 0;
    if (this.keepaliveTimer !== null) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    if (!this.serverProcess || this.serverProcess.killed) return;
    try {
      await this.request("shutdown");
    } catch {
      // Ignore errors on shutdown
    }
    this.serverProcess = null;
  }
}
