import type { LuaEngine } from "wasmoon";
import type { FrameIR } from "../parser/ir.js";
import type { ResolvedFlavorConfig } from "../flavors/config.js";
import { FrameRegistry } from "./frame-registry.js";
import { VirtualClock } from "./wow-api.js";
import { doStringWithTimeout, isLuaTimeout } from "./sandbox.js";

export interface EventEngineCallbacks {
  onFramesDirty: (frames: FrameIR[]) => void;
  output: { warn: (msg: string) => void; error: (msg: string) => void };
}

/**
 * Manages the live-panel event loop:
 *   - Drives the OnUpdate tick at the configured Hz
 *   - Dispatches frameEvent messages from the webview into the Lua sandbox
 *   - Checks the registry after each Lua call and triggers a re-render when dirty
 */
export class EventEngine {
  private interval: ReturnType<typeof setInterval> | undefined;
  private lastTickTime: number;
  private ticking = false;

  constructor(
    private readonly sandbox: LuaEngine,
    private readonly registry: FrameRegistry,
    private readonly clock: VirtualClock,
    private readonly config: ResolvedFlavorConfig,
    private readonly callbacks: EventEngineCallbacks,
  ) {
    this.lastTickTime = Date.now();
  }

  start(): void {
    if (this.interval !== undefined) return;
    const intervalMs = Math.max(1, Math.round(1000 / this.config.onUpdateHz));
    this.interval = setInterval(() => void this.tick(), intervalMs);
  }

  stop(): void {
    if (this.interval !== undefined) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  private async tick(): Promise<void> {
    // Prevent re-entrant ticks if a previous tick is still running
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now();
      const elapsed = (now - this.lastTickTime) / 1000;
      this.lastTickTime = now;

      this.clock.advance(elapsed);

      try {
        await doStringWithTimeout(
          this.sandbox,
          `if type(__scryer_tick) == "function" then __scryer_tick(${elapsed}) end`,
          this.config.onUpdateTimeout,
        );
      } catch (e) {
        if (isLuaTimeout(e)) {
          this.callbacks.output.warn(
            `[Live] OnUpdate timeout — one or more OnUpdate handlers exceeded the per-tick budget (${this.config.onUpdateTimeout}ms)`,
          );
        } else {
          this.callbacks.output.warn(`[Live] OnUpdate error: ${e}`);
        }
      }

      this.flushDirty();
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Dispatch a webview frameEvent (OnClick / OnEnter / OnLeave) into the Lua sandbox.
   * Triggers a re-render if any frame mutations result.
   */
  async dispatchFrameEvent(frameId: number, event: string, extra: unknown[]): Promise<void> {
    const argsStr = extra.length > 0 ? ", " + extra.map((a) => JSON.stringify(a)).join(", ") : "";
    const lua = `if type(__scryer_dispatch_script) == "function" then __scryer_dispatch_script(${frameId}, ${JSON.stringify(event)}${argsStr}) end`;
    try {
      await doStringWithTimeout(this.sandbox, lua, this.config.sandboxTimeout);
    } catch (e) {
      if (isLuaTimeout(e)) {
        this.callbacks.output.warn(`[Live] ${event} handler timeout`);
      } else {
        this.callbacks.output.warn(`[Live] ${event} error: ${e}`);
      }
    }
    this.flushDirty();
  }

  private flushDirty(): void {
    if (!this.registry.isDirty()) return;
    this.registry.clearDirty();
    const frames = this.registry.serialize();
    this.callbacks.onFramesDirty(frames);
  }
}
