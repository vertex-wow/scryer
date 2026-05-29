import { LuaFactory, LuaTimeoutError, type LuaEngine } from "wasmoon";
import compatLua from "./compat.lua";

export async function createSandbox(
  wasmPath: string,
  opts?: { timeout?: number },
): Promise<LuaEngine> {
  const factory = new LuaFactory(wasmPath);
  const lua = await factory.createEngine({
    openStandardLibs: true,
    functionTimeout: opts?.timeout,
  });

  // Remove dangerous globals and replace debug with a restricted subset
  // needed only for the setfenv/getfenv shim.
  await lua.doString(`
        io = nil
        os = nil
        package = nil
        loadfile = nil
        dofile = nil
        local _get = debug.getupvalue
        local _set = debug.setupvalue
        local _info = debug.getinfo
        debug = { getupvalue = _get, setupvalue = _set, getinfo = _info }
    `);

  // Bootstrap WoW Lua 5.1 compat: extensions, shim, aliases, bit library.
  await lua.doString(compatLua);

  return lua;
}

/**
 * Run a Lua script with a per-call timeout. Unlike engine.doString(), this
 * installs a Lua instruction-count hook that fires every 1000 opcodes, so
 * a tight loop (`while true do end`) is actually interrupted once the
 * deadline passes.
 *
 * Throws on any Lua error, including timeout.
 */
export async function doStringWithTimeout(
  lua: LuaEngine,
  script: string,
  timeoutMs: number,
): Promise<void> {
  const thread = lua.global.newThread();
  const threadIndex = lua.global.getTop();
  try {
    thread.loadString(script);
    await thread.run(0, { timeout: timeoutMs });
  } finally {
    lua.global.remove(threadIndex);
  }
}

/**
 * Returns true if the error came from a Lua execution timeout — either a
 * directly-thrown LuaTimeoutError (coroutine yield path) or the hook-based
 * error wrapped by wasmoon's assertOk (tight-loop path).
 */
export function isLuaTimeout(e: unknown): boolean {
  if (e instanceof LuaTimeoutError) return true;
  return e instanceof Error && e.message.includes("thread timeout exceeded");
}
