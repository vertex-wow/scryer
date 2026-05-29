# wasmoon Reference Notes

wasmoon@1.16.0 — compiles official Lua C source to WASM and bridges JS↔Lua via a type extension system. We use it as the Lua runtime for the sandbox (M5+).

Source: `node_modules/wasmoon` — dist is minified but readable. Key classes: `LuaEngine`, `Thread`, `LuaTypeExtension` subclasses.

---

## Type bridge overview

wasmoon converts JS values to Lua and back via a priority-ordered chain of type extensions:

| Priority | Extension               | Handles                                                        |
| -------- | ----------------------- | -------------------------------------------------------------- |
| 1        | `PromiseTypeExtension`  | JS Promises → Lua userdata with `:await()`                     |
| 1        | `NullTypeExtension`     | `null` → Lua userdata `null` (only when `injectObjects: true`) |
| 3        | `ProxyTypeExtension`    | Plain JS objects → Lua userdata proxy                          |
| 4        | `FunctionTypeExtension` | JS functions → Lua functions                                   |
| —        | `TableTypeExtension`    | JS arrays / plain objects → Lua tables (internal use)          |

The first extension that claims a value wins.

---

## Known gotchas

### 1. Returning `null` from a JS function crashes (bug in 1.16.0)

`PromiseTypeExtension.pushValue` evaluates `Promise.resolve(target) !== target` before checking `typeof target.then`. For `null`, `Promise.resolve(null)` creates a new Promise (not equal to null), so the check passes, then `typeof null.then` throws `TypeError`.

**Rule:** never `return null` from a JS function registered in wasmoon. Return `undefined` (void) to represent Lua nil.

Our code: all JS stubs in `src/lua/wow-api.ts` return `undefined` (no return statement or explicit `return`), never `null`.

```ts
// WRONG — crashes in 1.16.0
lua.global.set("stub", () => null);

// CORRECT — pushes no values → Lua nil
lua.global.set("stub", () => {});
```

### 2. `undefined` return → 0 Lua values (not 1 nil)

`FunctionTypeExtension` handles `undefined` with `return 0` (push nothing). This is important for `doString`:

- Lua `return nil` → `doString` returns **`null`** (1 explicit nil pushed)
- Lua `return jsFunc()` where jsFunc returns undefined → `doString` returns **`undefined`** (0 values returned by the chunk)

Both represent nil in Lua, but JavaScript sees different values. Tests that check for nil results from JS-backed functions must use `toBeUndefined()`, not `toBeNull()`.

```ts
// JS stub returning void
lua.global.set("getNothing", () => {});

await lua.doString("return getNothing()"); // → undefined (not null)
await lua.doString("return nil"); // → null
```

### 3. `doString` returns only the first return value

`callByteCode` (used internally by `doString`) collects all Lua return values but exposes only `getValue(top - count + 1)` — the first one. All subsequent values are silently dropped.

```ts
await lua.doString("return 1, 2, 3"); // → 1 (not [1, 2, 3])
```

**To get multiple returns:** use `lua.global.call(name, ...args)` which returns a `MultiReturn` iterable, or wrap the result in a Lua table:

```ts
// Return a table and destructure in JS
const t = (await lua.doString("return { a = 1, b = 2 }")) as Record<string, number>;
t.a; // 1
t.b; // 2

// Or use lua.global.call for a named Lua function
const [x, y] = lua.global.call("myFunc", arg1, arg2);
```

### 4. JS objects are Lua userdata — `type()` returns `"userdata"`, not `"table"`

When you `lua.global.set("obj", jsPlainObject)`, wasmoon wraps it via `ProxyTypeExtension` as a `js_proxy` userdata. Lua's `type(obj)` returns `"userdata"`.

This breaks any Lua code that does `type(x) == "table"` checks (e.g., the `C_*` namespace convention, Ace library compat checks).

**Fix:** build the object as a real Lua table using `doString`, with JS helpers captured as local upvalues:

```ts
lua.global.set("__scryer_timer_after", (s: number, fn: () => void) => clock.schedule(s, fn));
await lua.doString(`do
  local _after = __scryer_timer_after
  C_Timer = { After = function(s, fn) return _after(s, fn) end }
  __scryer_timer_after = nil  -- clean up the temp global
end`);
```

The `do...end` block is essential: the local upvalue `_after` captures the JS function value before the global is cleared, so the closure keeps working after cleanup.

### 5. Proxy method calls via `:` strip the Lua `self` argument

`ProxyTypeExtension.__index` decorates function properties with `{ self: proxyObject }`. `FunctionTypeExtension` then skips the first Lua argument if it strictly equals `options.self`. So for `proxy:Method(arg)` (which Lua expands to `proxy.Method(proxy, arg)`):

- First arg `== proxy == options.self` → **skipped**
- Second arg `arg` → becomes **first arg in JS**
- `this` in JS is set to `proxy`

**Consequence:** JS method signatures must NOT include a `self` parameter. The real first argument is the one after Lua's implicit self.

```ts
// WRONG — self is stripped, so _self receives "hello", msg is undefined
lua.global.set("obj", { Method: (_self: unknown, msg: string) => console.log(msg) });
// Lua: obj:Method("hello") → prints "undefined"

// CORRECT — wasmoon already stripped self
lua.global.set("obj", { Method: (msg: string) => console.log(msg) });
// Lua: obj:Method("hello") → prints "hello"
```

This only triggers when the first Lua arg is literally the same object reference as the proxy. Dot-notation calls (`obj.Method(other, arg)`) pass all args unmodified.

Because of gotchas 4 and 5 combined, the cleanest approach for any object whose methods get colon-called from Lua is to **build it as a real Lua table** (see gotcha 4 fix).

### 6. JS objects returned from functions also become proxies

It's not only `lua.global.set` that creates proxies — any JS object _returned_ from a registered JS function becomes a proxy in Lua too. For example, `date('*t')` returns a plain JS object `{ year, month, day, ... }`. In Lua, `type(date('*t'))` returns `"userdata"`, not `"table"`.

Field access (`t.year`, `t.month`) works fine through `__index`. But `ipairs(t)` won't work (expects integer keys), and any addon code that checks `type(t) == "table"` will fail.

For `date('*t')` this is unlikely to matter in practice. If it does, convert the proxy to a real Lua table explicitly:

```lua
local t = date('*t')
-- if you need type(t) == "table":
t = { year=t.year, month=t.month, day=t.day, hour=t.hour, min=t.min, sec=t.sec,
      wday=t.wday, yday=t.yday, isdst=t.isdst }
```

### 7. Numeric indexing on proxies is 0-based in JS, 1-based from Lua

`ProxyTypeExtension.__index` converts Lua numeric keys with `key = key - 1`. A JS array set as a global is indexed correctly from Lua with 1-based indices:

```ts
lua.global.set("arr", [10, 20, 30]);
await lua.doString("return arr[1]"); // → 10 (JS index 0)
await lua.doString("return arr[3]"); // → 30 (JS index 2)
```

### 7. `pairs()` on a proxy iterates `Object.getOwnPropertyNames`

`__pairs` on a proxy iterates all own enumerable and non-enumerable property names. This means `pairs(jsObj)` from Lua iterates every key on the JS object, including things like `constructor` if present. Prefer building real Lua tables for anything that Lua code will iterate with `pairs`.

---

## Engine options

`factory.createEngine(opts)` accepts:

| Option             | Default     | Notes                                                                                                                                     |
| ------------------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `openStandardLibs` | `true`      | Load `math`, `string`, `table`, `debug`, etc.                                                                                             |
| `injectObjects`    | `false`     | Expose JS `null` and `Error` as Lua userdata. **Do not enable** — null as userdata evaluates to `true` in Lua, breaking addon nil checks. |
| `enableProxy`      | `true`      | Enable `ProxyTypeExtension` for JS object bridging. Required for our API stub approach.                                                   |
| `traceAllocations` | `false`     | Track all allocations for leak debugging. Slow.                                                                                           |
| `functionTimeout`  | `undefined` | Millisecond timeout for JS→Lua calls. Useful for guarding against infinite loops in untrusted addon code.                                 |

We do not set `functionTimeout` today. See [backlog: Lua sandbox execution timeout](../plan/backlog.md#lua-sandbox-execution-timeout-deferred-from-m6).

---

## Promises and async

Promises returned from JS are exposed to Lua as userdata with an `:await()` method:

```lua
local result = sleep(1000):await()  -- suspends Lua coroutine until Promise resolves
```

Caveats:

- Yielding inside a JS→Lua callback is not supported (`cannot yield in callbacks from javascript` / `attempt to yield across a C-call boundary`).
- `doString` is async; Lua code that awaits Promises internally must be called via `doString`/`run`, not via `global.call` (which is synchronous).

We do not currently expose Promises to Lua. The sandbox runs synchronous Lua only.

---

## Memory management

`lua.global.close()` must be called when a sandbox is done. Our code does this in `finally` blocks in tests. In the extension host, the sandbox lifecycle is tied to the panel lifetime — ensure `close()` is called on panel disposal to avoid leaks.

---

## Web bundler notes (not currently relevant — we run Node-side)

If wasmoon is ever moved into the webview bundle, the bundler needs these modules marked as external/false:

```js
// esbuild
external: ["path", "fs", "child_process", "crypto", "url", "module"];
// or in our case, the Node extension host already has these
```

---

## Our workarounds summary

| Gotcha                   | Where we work around it                                               |
| ------------------------ | --------------------------------------------------------------------- |
| `null` crash             | `wow-api.ts` — all stubs `return` (void) instead of `return null`     |
| Method self-stripping    | `wow-api.ts` — `DEFAULT_CHAT_FRAME` and `C_Timer` built as Lua tables |
| `type() == "userdata"`   | `wow-api.ts` — `C_Timer` built as Lua table via `doString`            |
| `doString` single return | Tests use single-value returns or return a table                      |
