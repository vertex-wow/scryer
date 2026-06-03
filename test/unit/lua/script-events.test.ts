import * as path from "path";
import { createSandbox } from "../../../src/lua/sandbox";
import { registerWowApi, VirtualClock } from "../../../src/lua/wow-api";
import { registerFrameModel } from "../../../src/lua/createframe";
import { FrameRegistry } from "../../../src/lua/frame-registry";
import type { LuaEngine } from "wasmoon";

const WASM_PATH = path.join(__dirname, "../../../node_modules/wasmoon/dist/glue.wasm");

async function setup(
  uiW = 1024,
  uiH = 768,
): Promise<{
  lua: LuaEngine;
  registry: FrameRegistry;
  clock: VirtualClock;
}> {
  const registry = new FrameRegistry(uiW, uiH);
  const clock = new VirtualClock();
  const lua = await createSandbox(WASM_PATH);
  await registerWowApi(lua, { clock });
  await registerFrameModel(lua, registry);
  return { lua, registry, clock };
}

// ─── SetScript / GetScript ────────────────────────────────────────────────────

describe("SetScript / GetScript", () => {
  test("SetScript stores the primary handler; GetScript retrieves it", async () => {
    const { lua, registry } = await setup();
    try {
      await lua.doString(`
        local f = CreateFrame("Frame", "SF1")
        f:SetScript("OnShow", function(self) end)
      `);
      const result = await lua.doString(`return type(SF1:GetScript("OnShow"))`);
      expect(result).toBe("function");
    } finally {
      lua.global.close();
    }
    void registry;
  });

  test("SetScript(event, nil) clears the handler", async () => {
    const { lua, registry } = await setup();
    try {
      await lua.doString(`
        local f = CreateFrame("Frame", "SF2")
        f:SetScript("OnShow", function(self) end)
        f:SetScript("OnShow", nil)
      `);
      const result = await lua.doString(`return SF2:GetScript("OnShow")`);
      expect(result).toBeNull();
    } finally {
      lua.global.close();
    }
    void registry;
  });
});

// ─── HookScript chain ─────────────────────────────────────────────────────────

describe("HookScript chain", () => {
  test("both original and hook fire in order", async () => {
    const { lua, registry } = await setup();
    try {
      await lua.doString(`
        _G.hookOrder = {}
        local f = CreateFrame("Frame", "HF1")
        f:SetScript("OnShow", function(self) table.insert(_G.hookOrder, "original") end)
        f:HookScript("OnShow", function(self) table.insert(_G.hookOrder, "hook") end)
        f:Show()
      `);
      const joined = await lua.doString(`return table.concat(_G.hookOrder, ",")`);
      expect(joined).toBe("original,hook");
    } finally {
      lua.global.close();
    }
    void registry;
  });

  test("HookScript with no prior SetScript still fires", async () => {
    const { lua, registry } = await setup();
    try {
      await lua.doString(`
        _G.hookFired = false
        local f = CreateFrame("Frame", "HF2")
        f:HookScript("OnHide", function(self) _G.hookFired = true end)
        f:Hide()
      `);
      const fired = await lua.doString(`return _G.hookFired`);
      expect(fired).toBe(true);
    } finally {
      lua.global.close();
    }
    void registry;
  });

  test("GetScript returns the primary (first) handler", async () => {
    const { lua, registry } = await setup();
    try {
      await lua.doString(`
        local f = CreateFrame("Frame", "HF3")
        _G.primaryFn = function(self) end
        f:SetScript("OnShow", _G.primaryFn)
        f:HookScript("OnShow", function(self) end)
      `);
      const isSame = await lua.doString(`return HF3:GetScript("OnShow") == _G.primaryFn`);
      expect(isSame).toBe(true);
    } finally {
      lua.global.close();
    }
    void registry;
  });
});

// ─── OnShow / OnHide ──────────────────────────────────────────────────────────

describe("OnShow / OnHide", () => {
  test("OnShow fires when Show() is called", async () => {
    const { lua, registry } = await setup();
    try {
      await lua.doString(`
        _G.showCount = 0
        local f = CreateFrame("Frame", "SF3")
        f:SetScript("OnShow", function(self) _G.showCount = _G.showCount + 1 end)
        f:Show()
        f:Show()
      `);
      const count = await lua.doString(`return _G.showCount`);
      expect(count).toBe(2);
    } finally {
      lua.global.close();
    }
    void registry;
  });

  test("OnHide fires when Hide() is called", async () => {
    const { lua, registry } = await setup();
    try {
      await lua.doString(`
        _G.hideCount = 0
        local f = CreateFrame("Frame", "HF4")
        f:SetScript("OnHide", function(self) _G.hideCount = _G.hideCount + 1 end)
        f:Hide()
      `);
      const count = await lua.doString(`return _G.hideCount`);
      expect(count).toBe(1);
    } finally {
      lua.global.close();
    }
    void registry;
  });

  test("self passed to OnShow handler is the frame", async () => {
    const { lua, registry } = await setup();
    try {
      await lua.doString(`
        _G.selfName = nil
        local f = CreateFrame("Frame", "SF4")
        f:SetScript("OnShow", function(self) _G.selfName = self:GetName() end)
        f:Show()
      `);
      const name = await lua.doString(`return _G.selfName`);
      expect(name).toBe("SF4");
    } finally {
      lua.global.close();
    }
    void registry;
  });
});

// ─── OnSizeChanged ────────────────────────────────────────────────────────────

describe("OnSizeChanged", () => {
  test("fires with width and height when SetSize is called", async () => {
    const { lua, registry } = await setup();
    try {
      await lua.doString(`
        _G.sizeW, _G.sizeH = 0, 0
        local f = CreateFrame("Frame", "SC1")
        f:SetScript("OnSizeChanged", function(self, w, h) _G.sizeW = w; _G.sizeH = h end)
        f:SetSize(200, 100)
      `);
      const w = await lua.doString(`return _G.sizeW`);
      const h = await lua.doString(`return _G.sizeH`);
      expect(w).toBe(200);
      expect(h).toBe(100);
    } finally {
      lua.global.close();
    }
    void registry;
  });

  test("fires when SetWidth is called", async () => {
    const { lua, registry } = await setup();
    try {
      await lua.doString(`
        _G.gotWidth = false
        local f = CreateFrame("Frame", "SC2")
        f:SetScript("OnSizeChanged", function(self, w, h) _G.gotWidth = (w == 300) end)
        f:SetWidth(300)
      `);
      const ok = await lua.doString(`return _G.gotWidth`);
      expect(ok).toBe(true);
    } finally {
      lua.global.close();
    }
    void registry;
  });
});

// ─── OnValueChanged (StatusBar) ───────────────────────────────────────────────

describe("OnValueChanged", () => {
  test("fires when StatusBar:SetValue is called", async () => {
    const { lua, registry } = await setup();
    try {
      await lua.doString(`
        _G.barValue = nil
        local f = CreateFrame("StatusBar", "SB1")
        f:SetMinMaxValues(0, 100)
        f:SetScript("OnValueChanged", function(self, v) _G.barValue = v end)
        f:SetValue(75)
      `);
      const val = await lua.doString(`return _G.barValue`);
      expect(val).toBe(75);
    } finally {
      lua.global.close();
    }
    void registry;
  });
});

// ─── RegisterEvent / OnEvent ──────────────────────────────────────────────────

describe("RegisterEvent / OnEvent via __scryer_fire_event", () => {
  test("registered frame receives OnEvent when event is fired", async () => {
    const { lua, registry } = await setup();
    try {
      await lua.doString(`
        _G.lastEvent = nil
        local f = CreateFrame("Frame", "EV1")
        f:RegisterEvent("BAG_UPDATE")
        f:SetScript("OnEvent", function(self, event, ...) _G.lastEvent = event end)
        __scryer_fire_event("BAG_UPDATE", 0)
      `);
      const ev = await lua.doString(`return _G.lastEvent`);
      expect(ev).toBe("BAG_UPDATE");
    } finally {
      lua.global.close();
    }
    void registry;
  });

  test("unregistered frame no longer receives events", async () => {
    const { lua, registry } = await setup();
    try {
      await lua.doString(`
        _G.gotEvent = false
        local f = CreateFrame("Frame", "EV2")
        f:RegisterEvent("ZONE_CHANGED")
        f:SetScript("OnEvent", function(self, event) _G.gotEvent = true end)
        f:UnregisterEvent("ZONE_CHANGED")
        __scryer_fire_event("ZONE_CHANGED")
      `);
      const got = await lua.doString(`return _G.gotEvent`);
      expect(got).toBe(false);
    } finally {
      lua.global.close();
    }
    void registry;
  });

  test("event args are forwarded to OnEvent handler", async () => {
    const { lua, registry } = await setup();
    try {
      await lua.doString(`
        _G.arg1 = nil
        local f = CreateFrame("Frame", "EV3")
        f:RegisterEvent("CHAT_MSG_SAY")
        f:SetScript("OnEvent", function(self, event, msg) _G.arg1 = msg end)
        __scryer_fire_event("CHAT_MSG_SAY", "hello")
      `);
      const msg = await lua.doString(`return _G.arg1`);
      expect(msg).toBe("hello");
    } finally {
      lua.global.close();
    }
    void registry;
  });
});

// ─── OnUpdate tick ────────────────────────────────────────────────────────────

describe("OnUpdate / __scryer_tick", () => {
  test("OnUpdate handler fires on each __scryer_tick call", async () => {
    const { lua, registry } = await setup();
    try {
      await lua.doString(`
        _G.tickCount = 0
        local f = CreateFrame("Frame", "UPD1")
        f:SetScript("OnUpdate", function(self, elapsed) _G.tickCount = _G.tickCount + 1 end)
        __scryer_tick(0.016)
        __scryer_tick(0.016)
        __scryer_tick(0.016)
      `);
      const count = await lua.doString(`return _G.tickCount`);
      expect(count).toBe(3);
    } finally {
      lua.global.close();
    }
    void registry;
  });

  test("elapsed value is passed to OnUpdate handler", async () => {
    const { lua, registry } = await setup();
    try {
      await lua.doString(`
        _G.lastElapsed = 0
        local f = CreateFrame("Frame", "UPD2")
        f:SetScript("OnUpdate", function(self, elapsed) _G.lastElapsed = elapsed end)
        __scryer_tick(0.033)
      `);
      const elapsed = await lua.doString(`return _G.lastElapsed`);
      expect(typeof elapsed).toBe("number");
      expect(elapsed as number).toBeCloseTo(0.033, 5);
    } finally {
      lua.global.close();
    }
    void registry;
  });

  test("SetScript('OnUpdate', nil) stops the frame from receiving ticks", async () => {
    const { lua, registry } = await setup();
    try {
      await lua.doString(`
        _G.updateCount = 0
        local f = CreateFrame("Frame", "UPD3")
        f:SetScript("OnUpdate", function(self, elapsed) _G.updateCount = _G.updateCount + 1 end)
        __scryer_tick(0.016)
        f:SetScript("OnUpdate", nil)
        __scryer_tick(0.016)
        __scryer_tick(0.016)
      `);
      const count = await lua.doString(`return _G.updateCount`);
      expect(count).toBe(1);
    } finally {
      lua.global.close();
    }
    void registry;
  });

  test("multiple frames each receive OnUpdate ticks", async () => {
    const { lua, registry } = await setup();
    try {
      await lua.doString(`
        _G.counts = { 0, 0 }
        local a = CreateFrame("Frame", "UPD4a")
        local b = CreateFrame("Frame", "UPD4b")
        a:SetScript("OnUpdate", function() _G.counts[1] = _G.counts[1] + 1 end)
        b:SetScript("OnUpdate", function() _G.counts[2] = _G.counts[2] + 1 end)
        __scryer_tick(0.016)
        __scryer_tick(0.016)
      `);
      const c1 = await lua.doString(`return _G.counts[1]`);
      const c2 = await lua.doString(`return _G.counts[2]`);
      expect(c1).toBe(2);
      expect(c2).toBe(2);
    } finally {
      lua.global.close();
    }
    void registry;
  });
});

// ─── __scryer_dispatch_script (webview frameEvent bridge) ────────────────────

describe("__scryer_dispatch_script", () => {
  test("dispatches OnClick to the correct frame by ID", async () => {
    const { lua, registry } = await setup();
    try {
      await lua.doString(`
        _G.clickBtn = nil
        local f = CreateFrame("Button", "DS1")
        f:SetScript("OnClick", function(self, btn) _G.clickBtn = btn end)
        __scryer_dispatch_script(DS1.__id, "OnClick", "RightButton", true)
      `);
      const btn = await lua.doString(`return _G.clickBtn`);
      expect(btn).toBe("RightButton");
    } finally {
      lua.global.close();
    }
    void registry;
  });

  test("does nothing for unknown frame ID", async () => {
    const { lua, registry } = await setup();
    try {
      await lua.doString(`
        _G.badDispatch = false
        __scryer_dispatch_script(99999, "OnClick")
      `);
      const bad = await lua.doString(`return _G.badDispatch`);
      expect(bad).toBe(false);
    } finally {
      lua.global.close();
    }
    void registry;
  });

  test("dispatches OnEnter and OnLeave", async () => {
    const { lua, registry } = await setup();
    try {
      await lua.doString(`
        _G.entered = false; _G.left = false
        local f = CreateFrame("Frame", "DS2")
        f:SetScript("OnEnter", function(self) _G.entered = true end)
        f:SetScript("OnLeave", function(self) _G.left = true end)
        __scryer_dispatch_script(DS2.__id, "OnEnter")
        __scryer_dispatch_script(DS2.__id, "OnLeave")
      `);
      const entered = await lua.doString(`return _G.entered`);
      const left = await lua.doString(`return _G.left`);
      expect(entered).toBe(true);
      expect(left).toBe(true);
    } finally {
      lua.global.close();
    }
    void registry;
  });
});

// ─── Button:Click() ───────────────────────────────────────────────────────────

describe("Button:Click()", () => {
  test("Click() fires OnClick with LeftButton", async () => {
    const { lua, registry } = await setup();
    try {
      await lua.doString(`
        _G.clicked = nil
        local f = CreateFrame("Button", "BC1")
        f:SetScript("OnClick", function(self, btn) _G.clicked = btn end)
        f:Click()
      `);
      const btn = await lua.doString(`return _G.clicked`);
      expect(btn).toBe("LeftButton");
    } finally {
      lua.global.close();
    }
    void registry;
  });
});

// ─── Interactive frame serialization ─────────────────────────────────────────

describe("interactive frame serialization", () => {
  test("frame with OnClick handler is marked interactive with runtimeId", async () => {
    const { lua, registry } = await setup();
    try {
      await lua.doString(`
        local f = CreateFrame("Button", "INT1")
        f:SetScript("OnClick", function(self) end)
      `);
    } finally {
      lua.global.close();
    }
    const frames = registry.serialize();
    const f = frames.find((fr) => fr.name === "INT1");
    expect(f).toBeDefined();
    expect(f!.interactive).toBe(true);
    expect(typeof f!.runtimeId).toBe("number");
  });

  test("frame with only OnUpdate is not interactive (no mouse events)", async () => {
    const { lua, registry } = await setup();
    try {
      await lua.doString(`
        local f = CreateFrame("Frame", "NOINT1")
        f:SetScript("OnUpdate", function(self) end)
      `);
    } finally {
      lua.global.close();
    }
    const frames = registry.serialize();
    const f = frames.find((fr) => fr.name === "NOINT1");
    expect(f).toBeDefined();
    expect(f!.interactive).toBeUndefined();
    expect(f!.runtimeId).toBeUndefined();
  });

  test("frame with OnEnter/OnLeave is interactive", async () => {
    const { lua, registry } = await setup();
    try {
      await lua.doString(`
        local f = CreateFrame("Frame", "INT2")
        f:SetScript("OnEnter", function(self) end)
        f:SetScript("OnLeave", function(self) end)
      `);
    } finally {
      lua.global.close();
    }
    const frames = registry.serialize();
    const f = frames.find((fr) => fr.name === "INT2");
    expect(f).toBeDefined();
    expect(f!.interactive).toBe(true);
  });
});
