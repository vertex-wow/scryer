import * as path from "path";
import { createSandbox, doStringWithTimeout, isLuaTimeout } from "../../../src/lua/sandbox";

const WASM_PATH = path.join(__dirname, "../../../node_modules/wasmoon/dist/glue.wasm");

async function lua(script: string): Promise<unknown> {
  const sandbox = await createSandbox(WASM_PATH);
  try {
    return await sandbox.doString(script);
  } finally {
    sandbox.global.close();
  }
}

// ─── Execution timeout ───────────────────────────────────────────────────────
describe("execution timeout", () => {
  test("doStringWithTimeout kills infinite loop", async () => {
    const sandbox = await createSandbox(WASM_PATH);
    try {
      const error = await doStringWithTimeout(sandbox, "while true do end", 200).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(Error);
      expect(isLuaTimeout(error)).toBe(true);
    } finally {
      sandbox.global.close();
    }
  }, 10000);

  test("doStringWithTimeout completes normally for fast scripts", async () => {
    const sandbox = await createSandbox(WASM_PATH);
    try {
      await expect(doStringWithTimeout(sandbox, "return 1 + 1", 5000)).resolves.toBeUndefined();
    } finally {
      sandbox.global.close();
    }
  });
});

// ─── Dangerous globals removed ───────────────────────────────────────────────
describe("dangerous globals removed", () => {
  test("io is nil", async () => {
    expect(await lua("return io")).toBeNull();
  });

  test("os is nil", async () => {
    expect(await lua("return os")).toBeNull();
  });

  test("package is nil", async () => {
    expect(await lua("return package")).toBeNull();
  });

  test("loadfile is nil", async () => {
    expect(await lua("return loadfile")).toBeNull();
  });

  test("dofile is nil", async () => {
    expect(await lua("return dofile")).toBeNull();
  });

  test("debug.sethook is absent", async () => {
    expect(await lua("return debug.sethook")).toBeNull();
  });

  test("debug.getupvalue is present", async () => {
    expect(await lua("return type(debug.getupvalue)")).toBe("function");
  });
});

// ─── setfenv / getfenv ───────────────────────────────────────────────────────
describe("setfenv / getfenv", () => {
  test("setfenv redirects global writes", async () => {
    // Use load() so the chunk gets its own _ENV, independent of the outer script.
    const result = await lua(`
            local env = {}
            local f = load("x = 42")
            setfenv(f, env)
            f()
            return env.x
        `);
    expect(result).toBe(42);
  });

  test("getfenv returns _ENV of a function that uses globals", async () => {
    // load() gives the chunk its own _ENV upvalue; setfenv/getfenv round-trip.
    const result = await lua(`
            local env = {}
            local f = load("return _G")
            setfenv(f, env)
            return getfenv(f) == env
        `);
    expect(result).toBe(true);
  });

  test("getfenv(0) returns _G", async () => {
    expect(await lua("return getfenv(0) == _G")).toBe(true);
  });
});

// ─── Degree trig ─────────────────────────────────────────────────────────────
describe("degree trig aliases", () => {
  test("sin(90) == 1", async () => {
    expect(await lua("return sin(90)")).toBeCloseTo(1.0, 10);
  });

  test("cos(0) == 1", async () => {
    expect(await lua("return cos(0)")).toBeCloseTo(1.0, 10);
  });

  test("acos(1) == 0", async () => {
    expect(await lua("return acos(1)")).toBeCloseTo(0.0, 10);
  });

  test("asin(1) == 90", async () => {
    expect(await lua("return asin(1)")).toBeCloseTo(90.0, 10);
  });

  test("atan(1) == 45", async () => {
    expect(await lua("return atan(1)")).toBeCloseTo(45.0, 10);
  });

  test("atan2(1,1) == 45", async () => {
    expect(await lua("return atan2(1,1)")).toBeCloseTo(45.0, 10);
  });
});

// ─── Table aliases ───────────────────────────────────────────────────────────
describe("table aliases", () => {
  test("tinsert / tremove work", async () => {
    expect(
      await lua(`
            local t = {1,2,3}
            tinsert(t, 4)
            tremove(t, 1)
            return t[1]
        `),
    ).toBe(2);
  });

  test("wipe clears table", async () => {
    expect(
      await lua(`
            local t = {a=1, b=2}
            wipe(t)
            return next(t)
        `),
    ).toBeNull();
  });

  test("sort works", async () => {
    expect(
      await lua(`
            local t = {3,1,2}
            sort(t)
            return t[1]
        `),
    ).toBe(1);
  });

  test("getn / table.getn returns length", async () => {
    expect(await lua("return getn({10,20,30})")).toBe(3);
  });

  test("table.maxn returns max numeric key", async () => {
    expect(await lua("return table.maxn({[1]=1,[5]=5,[3]=3})")).toBe(5);
  });

  test("foreach iterates all keys", async () => {
    expect(
      await lua(`
            local count = 0
            foreach({a=1,b=2,c=3}, function() count = count + 1 end)
            return count
        `),
    ).toBe(3);
  });

  test("foreachi iterates sequence", async () => {
    expect(
      await lua(`
            local sum = 0
            foreachi({10,20,30}, function(i,v) sum = sum + v end)
            return sum
        `),
    ).toBe(60);
  });
});

// ─── String aliases & extensions ─────────────────────────────────────────────
describe("string aliases and extensions", () => {
  test("strlen returns length", async () => {
    expect(await lua(`return strlen("hello")`)).toBe(5);
  });

  test("strlower / strupper", async () => {
    expect(await lua(`return strlower("ABC")`)).toBe("abc");
    expect(await lua(`return strupper("abc")`)).toBe("ABC");
  });

  test("strtrim strips whitespace", async () => {
    expect(await lua(`return strtrim("  hi  ")`)).toBe("hi");
  });

  test("strsplit splits on delimiter", async () => {
    expect(
      await lua(`
            local a, b, c = strsplit(",", "x,y,z")
            return a .. b .. c
        `),
    ).toBe("xyz");
  });

  test("strsplit respects pieces limit", async () => {
    expect(
      await lua(`
            local a, b = strsplit(",", "x,y,z", 2)
            return a .. "|" .. b
        `),
    ).toBe("x|y,z");
  });

  test("strjoin joins with delimiter", async () => {
    expect(await lua(`return strjoin("-", "a", "b", "c")`)).toBe("a-b-c");
  });

  test("strconcat concatenates strings", async () => {
    expect(await lua(`return strconcat("foo", "bar")`)).toBe("foobar");
  });

  test("format works", async () => {
    expect(await lua(`return format("%d", 42)`)).toBe("42");
  });
});

// ─── bit library ─────────────────────────────────────────────────────────────
describe("bit library", () => {
  test("bit.band(3, 1) == 1", async () => {
    expect(await lua("return bit.band(3, 1)")).toBe(1);
  });

  test("bit.bor(1, 2) == 3", async () => {
    expect(await lua("return bit.bor(1, 2)")).toBe(3);
  });

  test("bit.bxor(3, 1) == 2", async () => {
    expect(await lua("return bit.bxor(3, 1)")).toBe(2);
  });

  test("bit.bnot(0) == -1", async () => {
    expect(await lua("return bit.bnot(0)")).toBe(-1);
  });

  test("bit.lshift(1, 4) == 16", async () => {
    expect(await lua("return bit.lshift(1, 4)")).toBe(16);
  });

  test("bit.rshift(16, 4) == 1", async () => {
    expect(await lua("return bit.rshift(16, 4)")).toBe(1);
  });

  test("bit.arshift(-1, 1) == -1 (sign extends)", async () => {
    expect(await lua("return bit.arshift(-1, 1)")).toBe(-1);
  });

  test("bit.mod(7, 3) == 1", async () => {
    expect(await lua("return bit.mod(7, 3)")).toBe(1);
  });

  test("multi-arg band", async () => {
    expect(await lua("return bit.band(0xFF, 0x0F, 0x07)")).toBe(7);
  });
});

// ─── GlobalStrings ────────────────────────────────────────────────────────────
describe("GlobalStrings", () => {
  test("OKAY is populated in _G", async () => {
    expect(await lua("return OKAY")).toBe("Okay");
  });

  test("CLOSE is populated in _G", async () => {
    expect(await lua("return CLOSE")).toBe("Close");
  });

  test("CANCEL is populated in _G", async () => {
    expect(await lua("return CANCEL")).toBe("Cancel");
  });

  test("unknown global is nil", async () => {
    expect(await lua("return SCRYER_NONEXISTENT_XYZ")).toBeNull();
  });
});

// ─── 5.1 global gaps ─────────────────────────────────────────────────────────
describe("Lua 5.1 global gaps", () => {
  test("unpack works", async () => {
    expect(await lua("return unpack({10, 20, 30})")).toBe(10);
  });

  test("loadstring executes code", async () => {
    expect(await lua(`return loadstring("return 1+1")()`)).toBe(2);
  });

  test("_VERSION is 'Lua 5.1'", async () => {
    expect(await lua("return _VERSION")).toBe("Lua 5.1");
  });
});
