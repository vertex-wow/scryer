import { LuaFactory, type LuaEngine } from "wasmoon";
import compatLua from "./compat.lua";

const REMOVE_GLOBALS = ["io", "os", "package", "loadfile", "dofile"];

export async function createSandbox(wasmPath: string): Promise<LuaEngine> {
  const factory = new LuaFactory(wasmPath);
  const lua = await factory.createEngine({ openStandardLibs: true });

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
