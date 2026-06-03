import * as fs from "fs";
import * as path from "path";
import { createSandbox } from "../../../src/lua/sandbox";
import { registerWowApi, VirtualClock } from "../../../src/lua/wow-api";
import { registerFrameModel } from "../../../src/lua/createframe";
import { FrameRegistry } from "../../../src/lua/frame-registry";
import { parseToc } from "../../../src/parser/toc";
import { runTocAddon } from "../../../src/lua/toc-runner";
import type { LuaEngine } from "wasmoon";

const WASM_PATH = path.join(__dirname, "../../../node_modules/wasmoon/dist/glue.wasm");
const FIXTURE_DIR = path.join(__dirname, "../../fixtures/SimpleAddon");

async function setup(): Promise<{ lua: LuaEngine; registry: FrameRegistry; clock: VirtualClock }> {
  const registry = new FrameRegistry(1024, 768);
  const clock = new VirtualClock();
  const lua = await createSandbox(WASM_PATH);
  await registerWowApi(lua, { clock });
  await registerFrameModel(lua, registry);
  return { lua, registry, clock };
}

async function readFile(absPath: string): Promise<string> {
  return fs.readFileSync(absPath, "utf-8");
}

describe("runTocAddon", () => {
  test("executes Lua file and creates frame", async () => {
    const { lua, registry, clock } = await setup();
    const tocContent = fs.readFileSync(path.join(FIXTURE_DIR, "SimpleAddon.toc"), "utf-8");
    const toc = parseToc(tocContent, path.join(FIXTURE_DIR, "SimpleAddon.toc"));

    try {
      await runTocAddon({
        toc,
        addonDir: FIXTURE_DIR,
        sandbox: lua,
        blizzardTemplates: undefined,
        readFile,
        output: { info: console.info, warn: console.warn, error: console.error },
      });
      clock.advance(0.001);

      // Lua file executed
      const luaLoaded = await lua.doString("return SimpleAddonLuaLoaded");
      expect(luaLoaded).toBe(true);

      // SavedVariables initialized as empty table
      const svType = await lua.doString("return type(SimpleAddonDB)");
      expect(svType).toBe("table");
    } finally {
      lua.global.close();
    }
    void registry;
  });

  test("XML frame created and accessible by name in Lua", async () => {
    const { lua, registry, clock } = await setup();
    const tocContent = fs.readFileSync(path.join(FIXTURE_DIR, "SimpleAddon.toc"), "utf-8");
    const toc = parseToc(tocContent, path.join(FIXTURE_DIR, "SimpleAddon.toc"));

    try {
      await runTocAddon({
        toc,
        addonDir: FIXTURE_DIR,
        sandbox: lua,
        blizzardTemplates: undefined,
        readFile,
        output: { info: console.info, warn: console.warn, error: console.error },
      });
      clock.advance(0.001);

      // XML-defined frame exists in Lua _G
      const frameType = await lua.doString("return type(SimpleAddonFrame)");
      expect(frameType).toBe("table");

      // XML OnLoad fired (set a global)
      const frameLoaded = await lua.doString("return SimpleAddonFrameLoaded");
      expect(frameLoaded).toBe(true);

      // Lua code was able to access and modify the XML frame
      const luaModified = await lua.doString("return SimpleAddonLuaModifiedFrame");
      expect(luaModified).toBe(true);
    } finally {
      lua.global.close();
    }
    void registry;
  });

  test("XML frame appears in registry serialize()", async () => {
    const { lua, registry, clock } = await setup();
    const tocContent = fs.readFileSync(path.join(FIXTURE_DIR, "SimpleAddon.toc"), "utf-8");
    const toc = parseToc(tocContent, path.join(FIXTURE_DIR, "SimpleAddon.toc"));

    try {
      await runTocAddon({
        toc,
        addonDir: FIXTURE_DIR,
        sandbox: lua,
        blizzardTemplates: undefined,
        readFile,
        output: { info: console.info, warn: console.warn, error: console.error },
      });
      clock.advance(0.001);
    } finally {
      lua.global.close();
    }

    const frames = registry.serialize();
    // SimpleAddonFrame + SimpleAddonLuaFrame + WorldFrame (child of UIParent)
    const names = frames.map((f) => f.name ?? "<anon>");
    expect(names).toContain("SimpleAddonFrame");
    expect(names).toContain("SimpleAddonLuaFrame");
  });

  test("ADDON_LOADED event dispatched to registered frames", async () => {
    const { lua, registry, clock } = await setup();
    const tocContent = fs.readFileSync(path.join(FIXTURE_DIR, "SimpleAddon.toc"), "utf-8");
    const toc = parseToc(tocContent, path.join(FIXTURE_DIR, "SimpleAddon.toc"));

    try {
      await runTocAddon({
        toc,
        addonDir: FIXTURE_DIR,
        sandbox: lua,
        blizzardTemplates: undefined,
        readFile,
        output: { info: console.info, warn: console.warn, error: console.error },
      });
      clock.advance(0.001);

      // XML OnEvent received ADDON_LOADED
      const xmlEvent = await lua.doString("return SimpleAddonLoadedEvent");
      expect(xmlEvent).toBe(true);

      // Lua OnEvent received ADDON_LOADED
      const luaEvent = await lua.doString("return SimpleAddonLuaEventFired");
      expect(luaEvent).toBe(true);
    } finally {
      lua.global.close();
    }
    void registry;
  });

  test("PLAYER_LOGIN event dispatched", async () => {
    const { lua, registry, clock } = await setup();
    const tocContent = fs.readFileSync(path.join(FIXTURE_DIR, "SimpleAddon.toc"), "utf-8");
    const toc = parseToc(tocContent, path.join(FIXTURE_DIR, "SimpleAddon.toc"));

    try {
      await runTocAddon({
        toc,
        addonDir: FIXTURE_DIR,
        sandbox: lua,
        blizzardTemplates: undefined,
        readFile,
        output: { info: console.info, warn: console.warn, error: console.error },
      });
      clock.advance(0.001);

      const loginEvent = await lua.doString("return SimpleAddonLoginEvent");
      expect(loginEvent).toBe(true);
    } finally {
      lua.global.close();
    }
    void registry;
  });

  test("missing TOC file is warned and skipped", async () => {
    const { lua, registry, clock } = await setup();
    const toc = parseToc(
      "## Interface: 110002\n## Title: Ghost\nGhost.lua\n",
      "/fake/Ghost/Ghost.toc",
    );

    const warnings: string[] = [];
    try {
      await runTocAddon({
        toc,
        addonDir: "/fake/Ghost",
        sandbox: lua,
        blizzardTemplates: undefined,
        readFile: async () => {
          throw new Error("ENOENT");
        },
        output: {
          info: () => {},
          warn: (m) => warnings.push(m),
          error: console.error,
        },
      });
      clock.advance(0.001);
    } finally {
      lua.global.close();
    }

    expect(warnings.some((w) => w.includes("Ghost.lua"))).toBe(true);
    void registry;
  });
});
