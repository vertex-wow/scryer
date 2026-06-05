import * as fs from "fs";
import * as path from "path";
import { createSandbox } from "../../../src/lua/sandbox";
import { registerWowApi, VirtualClock } from "../../../src/lua/wow-api";
import type { LuaEngine } from "wasmoon";

const WASM_PATH = path.join(__dirname, "../../../node_modules/wasmoon/dist/glue.wasm");
const CALLBACK_HANDLER_PATH = path.join(__dirname, "../../fixtures/libs/CallbackHandler-1.0.lua");

async function make(
  opts: { printed?: string[] } = {},
): Promise<{ lua: LuaEngine; clock: VirtualClock }> {
  const lua = await createSandbox(WASM_PATH);
  const clock = new VirtualClock();
  await registerWowApi(lua, {
    clock,
    print: opts.printed ? (s) => opts.printed!.push(s) : undefined,
  });
  return { lua, clock };
}

async function run(script: string, opts: { printed?: string[] } = {}): Promise<unknown> {
  const { lua, clock: _clock } = await make(opts);
  try {
    return await lua.doString(script);
  } finally {
    lua.global.close();
  }
}

// ─── C_* namespace stubs ──────────────────────────────────────────────────────
describe("C_* namespace stubs", () => {
  test("C_Item exists as a table", async () => {
    expect(await run("return type(C_Item)")).toBe("table");
  });

  test("void stubs return nil without error", async () => {
    expect(await run("return C_UnitAuras.AddBlockedAura() == nil")).toBe(true);
  });

  test("typed scalar stubs return default values", async () => {
    // number-returning stub → 0
    expect(await run("return C_Item.GetItemInfoInstant(1)")).toBe(0);
    // boolean-returning stub → false
    expect(await run("return C_AccountInfo.IsGUIDBattleNetAccountType('x')")).toBe(false);
    // string-returning stub → ''
    expect(await run("return C_Item.GetItemInfo(1)")).toBe("");
  });

  test("first and last namespace exist", async () => {
    expect(await run("return type(C_AccountInfo)")).toBe("table");
    expect(await run("return type(C_ZoneAbility)")).toBe("table");
  });

  test("every namespace is a table (spot-check 5)", async () => {
    const result = await run(`
      local ok = true
      local names = { "C_AuctionHouse", "C_Garrison", "C_Map", "C_Spell", "C_Timer" }
      for _, name in ipairs(names) do
        if type(_G[name]) ~= "table" then ok = false end
      end
      return ok
    `);
    expect(result).toBe(true);
  });

  test("C_Timer is a table (real impl, not stub)", async () => {
    expect(await run("return type(C_Timer)")).toBe("table");
  });
});

// ─── GetTime ──────────────────────────────────────────────────────────────────
describe("GetTime", () => {
  test("returns 0 on fresh clock", async () => {
    expect(await run("return GetTime()")).toBe(0);
  });

  test("reflects clock advances", async () => {
    const { lua, clock } = await make();
    try {
      clock.advance(1.5);
      const t = await lua.doString("return GetTime()");
      expect(t).toBeCloseTo(1.5);
    } finally {
      lua.global.close();
    }
  });
});

// ─── print / DEFAULT_CHAT_FRAME ───────────────────────────────────────────────
describe("print and DEFAULT_CHAT_FRAME", () => {
  test("print captures output", async () => {
    const printed: string[] = [];
    await run('print("hello", "world")', { printed });
    expect(printed).toEqual(["hello\tworld"]);
  });

  test("print nil shows 'nil'", async () => {
    const printed: string[] = [];
    await run("print(nil)", { printed });
    expect(printed).toEqual(["nil"]);
  });

  test("DEFAULT_CHAT_FRAME:AddMessage routes to print", async () => {
    const printed: string[] = [];
    await run('DEFAULT_CHAT_FRAME:AddMessage("chat msg")', { printed });
    expect(printed).toEqual(["chat msg"]);
  });
});

// ─── date ─────────────────────────────────────────────────────────────────────
describe("date", () => {
  test("date('*t') returns a table with year/month/day", async () => {
    // doString returns only the first of multiple values, so return the whole table
    const result = (await run("return date('*t')")) as Record<string, number>;
    expect(result.year).toBeGreaterThan(2000);
    expect(result.month).toBeGreaterThanOrEqual(1);
    expect(result.month).toBeLessThanOrEqual(12);
    expect(result.day).toBeGreaterThanOrEqual(1);
    expect(result.day).toBeLessThanOrEqual(31);
  });

  test("date('%Y') returns a 4-digit year string", async () => {
    const result = (await run("return date('%Y')")) as string;
    expect(result).toMatch(/^\d{4}$/);
    expect(parseInt(result)).toBeGreaterThan(2020);
  });

  test("date('!*t') returns UTC values", async () => {
    const result = (await run("local t = date('!*t') return type(t.year)")) as string;
    expect(result).toBe("number");
  });

  test("date with explicit timestamp", async () => {
    // Unix epoch: 1970-01-01
    const result = (await run("return date('!*t', 0)")) as Record<string, number>;
    expect(result.year).toBe(1970);
    expect(result.month).toBe(1);
    expect(result.day).toBe(1);
  });
});

// ─── IsAddOnLoaded / GetAddOnMetadata ─────────────────────────────────────────
describe("addon query stubs", () => {
  test("IsAddOnLoaded returns true by default", async () => {
    expect(await run("return IsAddOnLoaded('AnyAddon')")).toBe(true);
  });

  test("GetAddOnMetadata returns nil by default", async () => {
    // JS returns undefined → Lua nil → doString returns undefined
    expect(await run("return GetAddOnMetadata('Foo', 'Version')")).toBeUndefined();
  });

  test("isAddonLoaded callback is used", async () => {
    const { lua } = await make();
    const clock = new VirtualClock();
    const lua2 = await createSandbox(WASM_PATH);
    await registerWowApi(lua2, {
      clock,
      isAddonLoaded: (name) => name === "MyAddon",
    });
    try {
      expect(await lua2.doString("return IsAddOnLoaded('MyAddon')")).toBe(true);
      expect(await lua2.doString("return IsAddOnLoaded('Other')")).toBe(false);
    } finally {
      lua2.global.close();
      lua.global.close();
    }
  });
});

// ─── LibStub ──────────────────────────────────────────────────────────────────
describe("LibStub", () => {
  test("LibStub is a table", async () => {
    expect(await run("return type(LibStub)")).toBe("table");
  });

  test("NewLibrary registers and returns a library table", async () => {
    const result = await run(`
      local lib = LibStub:NewLibrary("TestLib-1.0", 1)
      return type(lib)
    `);
    expect(result).toBe("table");
  });

  test("GetLibrary retrieves a registered library", async () => {
    const result = await run(`
      local lib = LibStub:NewLibrary("TestLib-1.0", 1)
      lib.answer = 42
      local got = LibStub:GetLibrary("TestLib-1.0")
      return got.answer
    `);
    expect(result).toBe(42);
  });

  test("upgrading with same or lower minor returns nil", async () => {
    const result = await run(`
      LibStub:NewLibrary("VersionLib-1.0", 5)
      local lib2 = LibStub:NewLibrary("VersionLib-1.0", 5)
      return lib2
    `);
    expect(result).toBeNull();
  });

  test("upgrading with higher minor returns new table", async () => {
    const result = await run(`
      LibStub:NewLibrary("UpgradeLib-1.0", 1)
      local newer = LibStub:NewLibrary("UpgradeLib-1.0", 2)
      return type(newer)
    `);
    expect(result).toBe("table");
  });

  test("callable as a function (metatable __call)", async () => {
    const result = await run(`
      local lib = LibStub:NewLibrary("CallableLib-1.0", 1)
      lib.val = 99
      local got = LibStub("CallableLib-1.0")
      return got.val
    `);
    expect(result).toBe(99);
  });

  test("IterateLibraries returns all registered libraries", async () => {
    const result = await run(`
      LibStub:NewLibrary("IterA-1.0", 1)
      LibStub:NewLibrary("IterB-1.0", 1)
      local count = 0
      for _ in LibStub:IterateLibraries() do count = count + 1 end
      return count >= 2
    `);
    expect(result).toBe(true);
  });

  test("CallbackHandler-1.0 self-registers without error", async () => {
    const src = fs.readFileSync(CALLBACK_HANDLER_PATH, "utf8");
    const result = await run(`
      ${src}
      local lib = LibStub:GetLibrary("CallbackHandler-1.0", true)
      return lib ~= nil
    `);
    expect(result).toBe(true);
  });
});

// ─── C_Timer ─────────────────────────────────────────────────────────────────
describe("C_Timer", () => {
  test("After fires callback when clock advances past scheduled time", async () => {
    const { lua, clock } = await make();
    try {
      await lua.doString(`
        fired = false
        C_Timer.After(1, function() fired = true end)
      `);
      clock.advance(0.5);
      expect(await lua.doString("return fired")).toBe(false);
      clock.advance(0.6);
      expect(await lua.doString("return fired")).toBe(true);
    } finally {
      lua.global.close();
    }
  });

  test("After(0, fn) fires on the next advance", async () => {
    const { lua, clock } = await make();
    try {
      await lua.doString(`
        fired = false
        C_Timer.After(0, function() fired = true end)
      `);
      clock.advance(0);
      expect(await lua.doString("return fired")).toBe(true);
    } finally {
      lua.global.close();
    }
  });

  test("FunctionContainer:Cancel() prevents the callback", async () => {
    const { lua, clock } = await make();
    try {
      await lua.doString(`
        fired = false
        local handle = C_Timer.After(1, function() fired = true end)
        handle:Cancel()
      `);
      clock.advance(2);
      expect(await lua.doString("return fired")).toBe(false);
    } finally {
      lua.global.close();
    }
  });

  test("FunctionContainer:IsCancelled() reflects cancel state", async () => {
    // doString returns only the first of multiple values; test in two steps
    const { lua } = await make();
    try {
      await lua.doString("_h = C_Timer.After(1, function() end)");
      expect(await lua.doString("return _h:IsCancelled()")).toBe(false);
      await lua.doString("_h:Cancel()");
      expect(await lua.doString("return _h:IsCancelled()")).toBe(true);
    } finally {
      lua.global.close();
    }
  });

  test("NewTicker fires repeatedly until iteration limit", async () => {
    const { lua, clock } = await make();
    try {
      await lua.doString("count = 0\nC_Timer.NewTicker(0.1, function() count = count + 1 end, 3)");
      clock.advance(0.1);
      clock.advance(0.1);
      clock.advance(0.1);
      clock.advance(0.1);
      expect(await lua.doString("return count")).toBe(3);
    } finally {
      lua.global.close();
    }
  });

  test("NewTicker:Cancel() stops future fires", async () => {
    const { lua, clock } = await make();
    try {
      await lua.doString(`
        count = 0
        ticker = C_Timer.NewTicker(0.1, function() count = count + 1 end, 10)
        ticker:Cancel()
      `);
      clock.advance(1);
      expect(await lua.doString("return count")).toBe(0);
    } finally {
      lua.global.close();
    }
  });
});

// ─── VirtualClock ─────────────────────────────────────────────────────────────
describe("VirtualClock", () => {
  test("starts at 0", () => {
    expect(new VirtualClock().now()).toBe(0);
  });

  test("advance increments time", () => {
    const c = new VirtualClock();
    c.advance(2.5);
    expect(c.now()).toBe(2.5);
  });

  test("one-shot fires once then self-removes", () => {
    const c = new VirtualClock();
    let calls = 0;
    c.schedule(1, () => calls++);
    c.advance(2);
    c.advance(2);
    expect(calls).toBe(1);
  });

  test("repeating fires correct number of times", () => {
    const c = new VirtualClock();
    let calls = 0;
    c.schedule(0.5, () => calls++, { interval: 0.5, maxIter: 4 });
    c.advance(3);
    expect(calls).toBe(4);
  });
});
