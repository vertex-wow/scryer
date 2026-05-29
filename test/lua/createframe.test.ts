import * as path from "path";
import { createSandbox } from "../../src/lua/sandbox";
import { registerWowApi, VirtualClock } from "../../src/lua/wow-api";
import { registerFrameModel } from "../../src/lua/createframe";
import { FrameRegistry } from "../../src/lua/frame-registry";
import type { FrameIR } from "../../src/parser/ir";
import type { LuaEngine } from "wasmoon";

const WASM_PATH = path.join(__dirname, "../../node_modules/wasmoon/dist/glue.wasm");

async function setup(uiW = 1024, uiH = 768): Promise<{ lua: LuaEngine; registry: FrameRegistry }> {
  const registry = new FrameRegistry(uiW, uiH);
  const clock = new VirtualClock();
  const lua = await createSandbox(WASM_PATH);
  await registerWowApi(lua, { clock });
  await registerFrameModel(lua, registry);
  return { lua, registry };
}

async function run(script: string, uiW = 1024, uiH = 768): Promise<{ registry: FrameRegistry }> {
  const { lua, registry } = await setup(uiW, uiH);
  try {
    await lua.doString(script);
  } finally {
    lua.global.close();
  }
  return { registry };
}

// ─── CreateFrame ──────────────────────────────────────────────────────────────

describe("CreateFrame", () => {
  test("creates a frame under UIParent by default", async () => {
    const { registry } = await run(`CreateFrame("Frame", "MyFrame")`);
    const node = registry.getFrameByName("MyFrame");
    expect(node).toBeDefined();
    expect(node!.frameType).toBe("Frame");
    expect(node!.parentId).toBe(registry.uiParentId);
  });

  test("frame registered in Lua _G", async () => {
    const { lua, registry } = await setup();
    try {
      await lua.doString(`CreateFrame("Frame", "GlobalFrame")`);
      const result = await lua.doString(`return type(GlobalFrame)`);
      expect(result).toBe("table");
    } finally {
      lua.global.close();
    }
    void registry;
  });

  test("unnamed frame is not in Lua _G by key", async () => {
    const { lua, registry } = await setup();
    try {
      await lua.doString(`local f = CreateFrame("Frame")`);
      // No global was set
      const result = await lua.doString(`return type(SomeUndefinedFrame)`);
      expect(result).toBe("nil");
    } finally {
      lua.global.close();
    }
    void registry;
  });

  test("returns a table with __id", async () => {
    const { lua, registry } = await setup();
    try {
      await lua.doString(`local f = CreateFrame("Frame", "IdFrame")`);
      const id = await lua.doString(`return IdFrame.__id`);
      expect(typeof id).toBe("number");
      expect(id).toBeGreaterThan(0);
    } finally {
      lua.global.close();
    }
    void registry;
  });

  test("Button/CheckButton/StatusBar types work", async () => {
    const { registry } = await run(`
      CreateFrame("Button", "B1")
      CreateFrame("CheckButton", "CB1")
      CreateFrame("StatusBar", "SB1")
    `);
    expect(registry.getFrameByName("B1")?.frameType).toBe("Button");
    expect(registry.getFrameByName("CB1")?.frameType).toBe("CheckButton");
    expect(registry.getFrameByName("SB1")?.frameType).toBe("StatusBar");
  });
});

// ─── UIParent / WorldFrame ────────────────────────────────────────────────────

describe("UIParent / WorldFrame", () => {
  test("UIParent is accessible in Lua", async () => {
    const { lua, registry } = await setup();
    try {
      const result = await lua.doString(`return type(UIParent)`);
      expect(result).toBe("table");
    } finally {
      lua.global.close();
    }
    void registry;
  });

  test("UIParent size matches viewport", async () => {
    const { lua, registry } = await setup(800, 600);
    try {
      const w = await lua.doString(`return UIParent:GetWidth()`);
      const h = await lua.doString(`return UIParent:GetHeight()`);
      expect(w).toBe(800);
      expect(h).toBe(600);
    } finally {
      lua.global.close();
    }
    void registry;
  });
});

// ─── SetPoint / ClearAllPoints / SetAllPoints ─────────────────────────────────

describe("anchor methods", () => {
  test("SetPoint accumulates anchors", async () => {
    const { registry } = await run(`
      local f = CreateFrame("Frame", "AnchorFrame")
      f:SetPoint("TOPLEFT", UIParent, "TOPLEFT", 10, -10)
    `);
    const node = registry.getFrameByName("AnchorFrame")!;
    expect(node.anchors).toHaveLength(1);
    expect(node.anchors[0].point).toBe("TOPLEFT");
    expect(node.anchors[0].relativeTo).toBe("UIParent");
    expect(node.anchors[0].x).toBe(10);
    expect(node.anchors[0].y).toBe(-10);
  });

  test("ClearAllPoints removes anchors", async () => {
    const { registry } = await run(`
      local f = CreateFrame("Frame", "ClearFrame")
      f:SetPoint("CENTER", UIParent, "CENTER")
      f:ClearAllPoints()
    `);
    const node = registry.getFrameByName("ClearFrame")!;
    expect(node.anchors).toHaveLength(0);
  });

  test("SetAllPoints sets two anchors", async () => {
    const { registry } = await run(`
      local f = CreateFrame("Frame", "AllPtFrame")
      f:SetAllPoints(UIParent)
    `);
    const node = registry.getFrameByName("AllPtFrame")!;
    expect(node.setAllPoints).toBe(true);
    expect(node.anchors).toHaveLength(2);
  });

  test("SetPoint with string relTo", async () => {
    const { registry } = await run(`
      local a = CreateFrame("Frame", "RelToFrame")
      local b = CreateFrame("Frame", "RelFromFrame")
      b:SetPoint("LEFT", "RelToFrame", "RIGHT", 5, 0)
    `);
    const b = registry.getFrameByName("RelFromFrame")!;
    expect(b.anchors[0].relativeTo).toBe("RelToFrame");
  });

  test("SetPoint with frame table relTo", async () => {
    const { registry } = await run(`
      local a = CreateFrame("Frame", "TableRelTo")
      local b = CreateFrame("Frame", "TableRelFrom")
      b:SetPoint("LEFT", a, "RIGHT", 5, 0)
    `);
    const b = registry.getFrameByName("TableRelFrom")!;
    expect(b.anchors[0].relativeTo).toBe("TableRelTo");
  });
});

// ─── SetSize / Show / Hide ────────────────────────────────────────────────────

describe("size and visibility", () => {
  test("SetSize updates width and height", async () => {
    const { registry } = await run(`
      local f = CreateFrame("Frame", "SizedFrame")
      f:SetSize(200, 150)
    `);
    const node = registry.getFrameByName("SizedFrame")!;
    expect(node.width).toBe(200);
    expect(node.height).toBe(150);
  });

  test("SetWidth / SetHeight work independently", async () => {
    const { registry } = await run(`
      local f = CreateFrame("Frame", "WHFrame")
      f:SetWidth(300)
      f:SetHeight(100)
    `);
    const node = registry.getFrameByName("WHFrame")!;
    expect(node.width).toBe(300);
    expect(node.height).toBe(100);
  });

  test("Show and Hide update shown flag", async () => {
    const { registry } = await run(`
      local f = CreateFrame("Frame", "ShowHide")
      f:Hide()
    `);
    expect(registry.getFrameByName("ShowHide")!.shown).toBe(false);
  });

  test("IsShown returns correct boolean", async () => {
    const { lua, registry } = await setup();
    try {
      await lua.doString(`local f = CreateFrame("Frame", "IsShownTest")`);
      expect(await lua.doString(`return IsShownTest:IsShown()`)).toBe(true);
      await lua.doString(`IsShownTest:Hide()`);
      expect(await lua.doString(`return IsShownTest:IsShown()`)).toBe(false);
    } finally {
      lua.global.close();
    }
    void registry;
  });
});

// ─── Alpha and Scale ─────────────────────────────────────────────────────────

describe("alpha and scale", () => {
  test("SetAlpha stores clamped value", async () => {
    const { registry } = await run(`
      local f = CreateFrame("Frame", "AlphaFrame")
      f:SetAlpha(0.5)
    `);
    expect(registry.getFrameByName("AlphaFrame")!.alpha).toBeCloseTo(0.5);
  });

  test("GetAlpha returns stored value", async () => {
    const { lua, registry } = await setup();
    try {
      await lua.doString(`local f = CreateFrame("Frame", "GetAlphaFrame"); f:SetAlpha(0.75)`);
      const result = await lua.doString(`return GetAlphaFrame:GetAlpha()`);
      expect(result).toBeCloseTo(0.75);
    } finally {
      lua.global.close();
    }
    void registry;
  });

  test("SetScale stores value", async () => {
    const { registry } = await run(`
      local f = CreateFrame("Frame", "ScaleFrame")
      f:SetScale(1.5)
    `);
    expect(registry.getFrameByName("ScaleFrame")!.scale).toBeCloseTo(1.5);
  });
});

// ─── CreateTexture / CreateFontString ─────────────────────────────────────────

describe("CreateTexture / CreateFontString", () => {
  test("CreateTexture returns a texture table", async () => {
    const { lua, registry } = await setup();
    try {
      await lua.doString(`local f = CreateFrame("Frame", "TexOwner"); local t = f:CreateTexture()`);
      const node = registry.getFrameByName("TexOwner")!;
      expect(node.textures).toHaveLength(1);
    } finally {
      lua.global.close();
    }
    void registry;
  });

  test("SetTexture path is stored", async () => {
    const { registry } = await run(`
      local f = CreateFrame("Frame", "TexFile")
      local t = f:CreateTexture()
      t:SetTexture("Interface/Icons/spell_fire.blp")
    `);
    const node = registry.getFrameByName("TexFile")!;
    expect(node.textures[0].file).toBe("Interface/Icons/spell_fire.blp");
  });

  test("SetColorTexture stores color", async () => {
    const { registry } = await run(`
      local f = CreateFrame("Frame", "ColorTex")
      local t = f:CreateTexture()
      t:SetColorTexture(1, 0, 0, 1)
    `);
    const node = registry.getFrameByName("ColorTex")!;
    expect(node.textures[0].color).toEqual({ r: 1, g: 0, b: 0, a: 1 });
  });

  test("CreateFontString returns a fontstring table", async () => {
    const { registry } = await run(`
      local f = CreateFrame("Frame", "FSOwner")
      local fs = f:CreateFontString()
      fs:SetText("Hello")
    `);
    const node = registry.getFrameByName("FSOwner")!;
    expect(node.fontStrings).toHaveLength(1);
    expect(node.fontStrings[0].text).toBe("Hello");
  });

  test("SetTextColor stores color", async () => {
    const { registry } = await run(`
      local f = CreateFrame("Frame", "ColorFS")
      local fs = f:CreateFontString()
      fs:SetTextColor(1, 1, 0, 1)
    `);
    const node = registry.getFrameByName("ColorFS")!;
    expect(node.fontStrings[0].color).toEqual({ r: 1, g: 1, b: 0, a: 1 });
  });
});

// ─── GetObjectType / IsObjectType ─────────────────────────────────────────────

describe("GetObjectType / IsObjectType", () => {
  test("Frame returns Frame", async () => {
    const { lua, registry } = await setup();
    try {
      await lua.doString(`local f = CreateFrame("Frame", "ObjTypeFrame")`);
      expect(await lua.doString(`return ObjTypeFrame:GetObjectType()`)).toBe("Frame");
      expect(await lua.doString(`return ObjTypeFrame:IsObjectType("Frame")`)).toBe(true);
    } finally {
      lua.global.close();
    }
    void registry;
  });

  test("Button IsObjectType accepts Frame and ScriptObject", async () => {
    const { lua, registry } = await setup();
    try {
      await lua.doString(`local b = CreateFrame("Button", "ObjTypeBtn")`);
      expect(await lua.doString(`return ObjTypeBtn:GetObjectType()`)).toBe("Button");
      expect(await lua.doString(`return ObjTypeBtn:IsObjectType("Frame")`)).toBe(true);
      expect(await lua.doString(`return ObjTypeBtn:IsObjectType("ScriptObject")`)).toBe(true);
    } finally {
      lua.global.close();
    }
    void registry;
  });
});

// ─── GetParent / GetChildren ──────────────────────────────────────────────────

describe("GetParent / GetChildren", () => {
  test("GetParent returns parent table", async () => {
    const { lua, registry } = await setup();
    try {
      await lua.doString(`
        local p = CreateFrame("Frame", "ParentP")
        local c = CreateFrame("Frame", "ChildC", p)
      `);
      const result = await lua.doString(`return ChildC:GetParent() == ParentP`);
      expect(result).toBe(true);
    } finally {
      lua.global.close();
    }
    void registry;
  });

  test("GetNumChildren returns count", async () => {
    const { lua, registry } = await setup();
    try {
      await lua.doString(`
        local p = CreateFrame("Frame", "ParentNumCh")
        CreateFrame("Frame", "Ch1", p)
        CreateFrame("Frame", "Ch2", p)
      `);
      expect(await lua.doString(`return ParentNumCh:GetNumChildren()`)).toBe(2);
    } finally {
      lua.global.close();
    }
    void registry;
  });
});

// ─── Scripts ──────────────────────────────────────────────────────────────────

describe("SetScript / GetScript", () => {
  test("SetScript stores handler, GetScript retrieves it", async () => {
    const { lua, registry } = await setup();
    try {
      await lua.doString(`
        local f = CreateFrame("Frame", "ScriptFrame")
        local called = false
        f:SetScript("OnLoad", function() called = true end)
      `);
      const result = await lua.doString(`return type(ScriptFrame:GetScript("OnLoad"))`);
      expect(result).toBe("function");
    } finally {
      lua.global.close();
    }
    void registry;
  });

  test("GetScript returns nil for unset event", async () => {
    const { lua, registry } = await setup();
    try {
      await lua.doString(`local f = CreateFrame("Frame", "NoScript")`);
      // Lua nil → null in JavaScript (GetScript returns nil from pure-Lua _scripts table)
      expect(await lua.doString(`return NoScript:GetScript("OnLoad")`)).toBeNull();
    } finally {
      lua.global.close();
    }
    void registry;
  });
});

// ─── Mixin helpers ────────────────────────────────────────────────────────────

describe("Mixin / CreateFromMixins", () => {
  test("Mixin copies fields onto object", async () => {
    const { lua, registry } = await setup();
    try {
      await lua.doString(`
        local MyMixin = { value = 42 }
        local obj = {}
        Mixin(obj, MyMixin)
      `);
      expect(
        await lua.doString(`
        local MyMixin = { value = 42 }
        local obj = {}
        Mixin(obj, MyMixin)
        return obj.value
      `),
      ).toBe(42);
    } finally {
      lua.global.close();
    }
    void registry;
  });

  test("CreateFromMixins produces a new table", async () => {
    const { lua, registry } = await setup();
    try {
      expect(
        await lua.doString(`
        local A = { x = 1 }
        local B = { y = 2 }
        local obj = CreateFromMixins(A, B)
        return obj.x + obj.y
      `),
      ).toBe(3);
    } finally {
      lua.global.close();
    }
    void registry;
  });
});

// ─── StatusBar ────────────────────────────────────────────────────────────────

describe("StatusBar", () => {
  test("SetMinMaxValues / GetMinMaxValues round-trip", async () => {
    const { registry } = await run(`
      local sb = CreateFrame("StatusBar", "MySB")
      sb:SetMinMaxValues(0, 100)
      sb:SetValue(75)
    `);
    const node = registry.getFrameByName("MySB")!;
    expect(node.statusBarMinValue).toBe(0);
    expect(node.statusBarMaxValue).toBe(100);
    expect(node.statusBarValue).toBe(75);
  });
});

// ─── FrameStrata / FrameLevel ─────────────────────────────────────────────────

describe("FrameStrata / FrameLevel", () => {
  test("SetFrameStrata stored", async () => {
    const { registry } = await run(`
      local f = CreateFrame("Frame", "StrataFrame")
      f:SetFrameStrata("HIGH")
    `);
    expect(registry.getFrameByName("StrataFrame")!.frameStrata).toBe("HIGH");
  });

  test("SetFrameLevel stored", async () => {
    const { registry } = await run(`
      local f = CreateFrame("Frame", "LevelFrame")
      f:SetFrameLevel(5)
    `);
    expect(registry.getFrameByName("LevelFrame")!.frameLevel).toBe(5);
  });
});

// ─── serialize → FrameIR ──────────────────────────────────────────────────────

describe("serialize integration", () => {
  test("frame tree serializes to valid FrameIR", async () => {
    const { registry } = await run(`
      local f = CreateFrame("Frame", "SerFrame")
      f:SetSize(100, 50)
      f:SetPoint("CENTER", UIParent, "CENTER", 0, 0)
      local tex = f:CreateTexture()
      tex:SetColorTexture(1, 0, 0, 1)
    `);
    const irs = registry.serialize();
    const ir = irs.find((f) => f.name === "SerFrame");
    expect(ir).toBeDefined();
    expect(ir!.size).toEqual({ x: 100, y: 50 });
    expect(ir!.anchors[0].point).toBe("CENTER");
    expect(ir!.layers).toHaveLength(1);
    expect(ir!.layers[0].objects[0]).toMatchObject({ kind: "Texture", color: { r: 1, g: 0 } });
  });

  test("helper globals are cleaned up after bootstrap", async () => {
    const { lua, registry } = await setup();
    try {
      expect(await lua.doString(`return __scryer_frame_new`)).toBeNull();
      expect(await lua.doString(`return __scryer_tex_set_texture`)).toBeNull();
    } finally {
      lua.global.close();
    }
    void registry;
  });
});

// ─── Template application ─────────────────────────────────────────────────────

function makeBlizzardTemplates(...entries: [string, Partial<FrameIR>][]): Map<string, FrameIR> {
  const base: FrameIR = {
    kind: "Frame",
    inherits: [],
    mixin: [],
    virtual: true,
    sourceFile: "__test__",
    anchors: [],
    keyValues: [],
    layers: [],
    children: [],
    scripts: [],
    templateChain: [],
  };
  return new Map(entries.map(([name, partial]) => [name, { ...base, ...partial, name }]));
}

async function setupWithTemplates(
  templates: Map<string, FrameIR>,
  uiW = 1024,
  uiH = 768,
): Promise<{ lua: LuaEngine; registry: FrameRegistry }> {
  const registry = new FrameRegistry(uiW, uiH);
  const clock = new VirtualClock();
  const lua = await createSandbox(WASM_PATH);
  await registerWowApi(lua, { clock });
  await registerFrameModel(lua, registry, templates);
  return { lua, registry };
}

describe("template application via CreateFrame 4th arg", () => {
  test("unknown template is a no-op (no error)", async () => {
    const templates = makeBlizzardTemplates();
    const { lua, registry } = await setupWithTemplates(templates);
    try {
      await expect(
        lua.doString(`CreateFrame("Button", "NoTplBtn", UIParent, "UnknownTemplate")`),
      ).resolves.not.toThrow();
      const node = registry.getFrameByName("NoTplBtn");
      expect(node).toBeDefined();
      expect(node!.textures).toHaveLength(0);
    } finally {
      lua.global.close();
    }
  });

  test("template texture is applied to frame", async () => {
    const templates = makeBlizzardTemplates([
      "MyBtnTemplate",
      {
        layers: [
          {
            level: "ARTWORK",
            subLevel: 0,
            objects: [
              {
                kind: "Texture",
                name: "BG",
                inherits: [],
                mixin: [],
                virtual: false,
                sourceFile: "__test__",
                anchors: [],
                keyValues: [],
                file: "Interface\\Buttons\\UI-Panel-Button-Up",
              },
            ],
          },
        ],
      },
    ]);
    const { lua, registry } = await setupWithTemplates(templates);
    try {
      await lua.doString(`CreateFrame("Button", "TplBtn", UIParent, "MyBtnTemplate")`);
      const node = registry.getFrameByName("TplBtn");
      expect(node).toBeDefined();
      expect(node!.textures).toHaveLength(1);
      expect(node!.textures[0].file).toBe("Interface\\Buttons\\UI-Panel-Button-Up");
    } finally {
      lua.global.close();
    }
  });

  test("template size is applied to frame", async () => {
    const templates = makeBlizzardTemplates(["SizedTemplate", { size: { x: 120, y: 22 } }]);
    const { lua, registry } = await setupWithTemplates(templates);
    try {
      await lua.doString(`CreateFrame("Frame", "SizedFrame", UIParent, "SizedTemplate")`);
      const node = registry.getFrameByName("SizedFrame");
      expect(node).toBeDefined();
      expect(node!.width).toBe(120);
      expect(node!.height).toBe(22);
    } finally {
      lua.global.close();
    }
  });

  test("template fontstring is applied to frame", async () => {
    const templates = makeBlizzardTemplates([
      "LabelTemplate",
      {
        layers: [
          {
            level: "OVERLAY",
            subLevel: 0,
            objects: [
              {
                kind: "FontString",
                name: "LabelText",
                inherits: [],
                mixin: [],
                virtual: false,
                sourceFile: "__test__",
                anchors: [],
                keyValues: [],
                text: "Hello",
                fontSize: 12,
              },
            ],
          },
        ],
      },
    ]);
    const { lua, registry } = await setupWithTemplates(templates);
    try {
      await lua.doString(`CreateFrame("Frame", "LabelFrame", UIParent, "LabelTemplate")`);
      const node = registry.getFrameByName("LabelFrame");
      expect(node).toBeDefined();
      expect(node!.fontStrings).toHaveLength(1);
      expect(node!.fontStrings[0].text).toBe("Hello");
    } finally {
      lua.global.close();
    }
  });

  test("function-reference script is registered on frame", async () => {
    const templates = makeBlizzardTemplates([
      "ScriptTemplate",
      {
        scripts: [{ event: "OnEnter", function: "GenericOnEnter" }],
      },
    ]);
    const { lua, registry } = await setupWithTemplates(templates);
    try {
      await lua.doString(`
        GenericOnEnter = function() end
        CreateFrame("Frame", "ScriptedFrame", UIParent, "ScriptTemplate")
      `);
      const result = await lua.doString(`return ScriptedFrame:GetScript("OnEnter") ~= nil`);
      expect(result).toBe(true);
    } finally {
      lua.global.close();
    }
  });

  test("multiple comma-separated templates merged", async () => {
    const templates = makeBlizzardTemplates(
      [
        "TemplateA",
        {
          layers: [
            {
              level: "ARTWORK",
              subLevel: 0,
              objects: [
                {
                  kind: "Texture",
                  name: "TexA",
                  inherits: [],
                  mixin: [],
                  virtual: false,
                  sourceFile: "__test__",
                  anchors: [],
                  keyValues: [],
                },
              ],
            },
          ],
        },
      ],
      [
        "TemplateB",
        {
          layers: [
            {
              level: "OVERLAY",
              subLevel: 0,
              objects: [
                {
                  kind: "FontString",
                  name: "FsB",
                  inherits: [],
                  mixin: [],
                  virtual: false,
                  sourceFile: "__test__",
                  anchors: [],
                  keyValues: [],
                },
              ],
            },
          ],
        },
      ],
    );
    const { lua, registry } = await setupWithTemplates(templates);
    try {
      await lua.doString(`CreateFrame("Button", "MultiTplBtn", UIParent, "TemplateA, TemplateB")`);
      const node = registry.getFrameByName("MultiTplBtn");
      expect(node).toBeDefined();
      expect(node!.textures).toHaveLength(1);
      expect(node!.fontStrings).toHaveLength(1);
    } finally {
      lua.global.close();
    }
  });

  test("__scryer_apply_template global is cleared after bootstrap", async () => {
    const templates = makeBlizzardTemplates();
    const { lua, registry } = await setupWithTemplates(templates);
    try {
      const v = await lua.doString(`return __scryer_apply_template`);
      expect(v).toBeNull();
    } finally {
      lua.global.close();
    }
    void registry;
  });
});
