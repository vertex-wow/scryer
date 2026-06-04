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

// ─── CreateTexture from OnLoad ────────────────────────────────────────────────

const CREATE_TEXTURE_FIXTURE_DIR = path.join(__dirname, "../../fixtures/CreateTextureAddon");

describe("CreateTexture from OnLoad", () => {
  async function runCreateTextureAddon(): Promise<{ registry: FrameRegistry }> {
    const { lua, registry, clock } = await setup();
    const tocContent = fs.readFileSync(
      path.join(CREATE_TEXTURE_FIXTURE_DIR, "CreateTextureAddon.toc"),
      "utf-8",
    );
    const toc = parseToc(
      tocContent,
      path.join(CREATE_TEXTURE_FIXTURE_DIR, "CreateTextureAddon.toc"),
    );
    try {
      await runTocAddon({
        toc,
        addonDir: CREATE_TEXTURE_FIXTURE_DIR,
        sandbox: lua,
        blizzardTemplates: undefined,
        readFile,
        output: { info: console.info, warn: console.warn, error: console.error },
      });
      clock.advance(0.001);
    } finally {
      lua.global.close();
    }
    return { registry };
  }

  test("OnLoad-created textures appear in registry", async () => {
    const { registry } = await runCreateTextureAddon();
    const node = registry.getFrameByName("DynTexFrame")!;
    expect(node).toBeDefined();
    expect(node.textures).toHaveLength(2);
  });

  test("SetAtlas name stored on dynamically-created texture", async () => {
    const { registry } = await runCreateTextureAddon();
    const textures = registry.getFrameByName("DynTexFrame")!.textures;
    expect(textures[0].atlas).toBe("mock-corner-tl");
    expect(textures[1].atlas).toBe("mock-corner-tr");
  });

  test("useAtlasSize stored correctly per texture", async () => {
    const { registry } = await runCreateTextureAddon();
    const textures = registry.getFrameByName("DynTexFrame")!.textures;
    expect(textures[0].useAtlasSize).toBe(false);
    expect(textures[1].useAtlasSize).toBe(true);
  });

  test("SetSize stored on dynamically-created textures", async () => {
    const { registry } = await runCreateTextureAddon();
    const textures = registry.getFrameByName("DynTexFrame")!.textures;
    expect(textures[0].size?.x).toBe(32);
    expect(textures[0].size?.y).toBe(32);
    expect(textures[1].size?.x).toBe(48);
    expect(textures[1].size?.y).toBe(48);
  });

  test("SetPoint anchor stored on dynamically-created textures", async () => {
    const { registry } = await runCreateTextureAddon();
    const textures = registry.getFrameByName("DynTexFrame")!.textures;
    expect(textures[0].anchors[0].point).toBe("TOPLEFT");
    expect(textures[1].anchors[0].point).toBe("TOPRIGHT");
  });

  test("DynTexFrame appears in registry serialize()", async () => {
    const { registry } = await runCreateTextureAddon();
    const names = registry.serialize().map((f) => f.name ?? "<anon>");
    expect(names).toContain("DynTexFrame");
  });
});

// ─── Mixin via TOC ────────────────────────────────────────────────────────────

const MIXIN_FIXTURE_DIR = path.join(__dirname, "../../fixtures/MixinAddon");

describe("Mixin via TOC", () => {
  async function runMixinAddon(): Promise<{ registry: FrameRegistry }> {
    const { lua, registry, clock } = await setup();
    const tocContent = fs.readFileSync(path.join(MIXIN_FIXTURE_DIR, "MixinAddon.toc"), "utf-8");
    const toc = parseToc(tocContent, path.join(MIXIN_FIXTURE_DIR, "MixinAddon.toc"));
    try {
      await runTocAddon({
        toc,
        addonDir: MIXIN_FIXTURE_DIR,
        sandbox: lua,
        blizzardTemplates: undefined,
        readFile,
        output: { info: console.info, warn: console.warn, error: console.error },
      });
      clock.advance(0.001);
    } finally {
      lua.global.close();
    }
    return { registry };
  }

  test("MixinExampleFrame appears in registry", async () => {
    const { registry } = await runMixinAddon();
    const node = registry.getFrameByName("MixinExampleFrame");
    expect(node).toBeDefined();
  });

  test("OnLoad mixin sets text via parentKey — sentinel replaced", async () => {
    // The XML default text is "(mixin not applied)". The Lua OnLoad applies
    // MixinExampleFrameMixin and calls self:OnLoad(), which calls
    // self.TitleText:SetText("Hello from Mixin!"). If parentKey wiring or
    // Mixin() breaks, the sentinel text survives.
    const { registry } = await runMixinAddon();
    const fs = registry.getFrameByName("MixinExampleFrame")!.fontStrings[0];
    expect(fs.text).toBe("Hello from Mixin!");
  });

  test("OnLoad mixin applies SetTextColor via parentKey", async () => {
    const { registry } = await runMixinAddon();
    const fs = registry.getFrameByName("MixinExampleFrame")!.fontStrings[0];
    expect(fs.color?.r).toBeCloseTo(1);
    expect(fs.color?.g).toBeCloseTo(0.82);
    expect(fs.color?.b).toBeCloseTo(0);
  });
});
