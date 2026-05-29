# Milestone 12 — Automated Addon Test Suite (Stretch)

## Goal

Run addon tests headlessly (no VSCode UI, no webview) against the same Lua runtime and WoW API mocks as M5–M9, with CI-friendly output and integration into the VSCode Test Explorer.

## Approach

1. Ship a small Lua test library (`describe`/`it`/`expect`) that addons can require.
2. A Node headless runner boots the M4 runtime (no webview), loads the addon + test files, runs them, and collects results.
3. Emit TAP or JSON; integrate with VSCode `TestController` API.

## Test Framework Design (Lua)

A thin Lua module (`wowtest.lua`) shipped with the extension and injectable into the sandbox:

```lua
local T = require("wowtest")

T.describe("Inventory", function()
  T.beforeEach(function()
    -- reset state
  end)

  T.it("counts items correctly", function()
    local n = MyAddon:CountItems()
    T.expect(n).toBe(3)
  end)

  T.it("handles empty bag", function()
    T.expect(MyAddon:CountItems()).toBeNil()
  end)
end)
```

**Matchers:**

- `toBe(value)` — strict equality (`==`)
- `toEqual(value)` — deep equality (table comparison)
- `toBeNil()` — is nil
- `toBeTruthy()` / `toBeFalsy()`
- `toBeGreaterThan(n)` / `toBeLessThan(n)`
- `toThrow([msgPattern])` — callable raises an error
- `toContain(item)` — table contains item

**Lifecycle hooks:** `beforeEach`, `afterEach`, `beforeAll`, `afterAll`.

**Event helpers (built on M4 dispatcher):**

```lua
T.fireEvent("PLAYER_LOGIN")
T.fireEvent("BAG_UPDATE", 0)
T.advanceTime(1.5)          -- advance virtual clock by 1.5 seconds
T.clickFrame("MyAddonButton")
```

**Typed event payloads (M12 concern, not M9):** `_reference/vscode-wow-api/src/data/event.ts` defines 1739 typed WoW events with their argument signatures (7648 lines). A typed TypeScript `fireEvent` helper (validated against these signatures at build time) is useful for the host-side test runner — mismatched argument counts surface immediately. This is an M7 enhancement; the Lua-side `T.fireEvent` in M4 is untyped.

## Headless Runner

Pure Node process (no VSCode, no webview):

```
node dist/runner.js --toc path/to/MyAddon.toc --target retail
```

1. Loads wasmoon + sandbox + API profile (M10) without the renderer.
2. Frame object model works but produces no visual output (all `Set*` calls are no-ops or recorded).
3. Parses `.toc` (M4 TOC parser + M1 XML parser), runs files in order.
4. Discovers test files by convention:
   - `Tests/**/*.test.lua` relative to the addon root, OR
   - `## X-Tests: Tests\Suite.test.lua` directive in the TOC.
5. Executes `wowtest` runner, collects `describe`/`it` results.
6. Exits with code 0 (all pass) or 1 (any failure) for CI.

## WoW API Mock Completeness

Headless mode requires the same stubs as M4, minus rendering. Additional requirements for testability:

- **Deterministic time:** `GetTime()` returns controlled virtual time; `C_Timer.After` callbacks execute when you call `T.advanceTime()`.
- **Event injection:** `T.fireEvent(name, ...)` dispatches to all registered handlers.
- **Frame queries:** `GetFrame("name")` returns the frame object so tests can inspect state.
- **SavedVariables:** pre-populate with test fixtures via `T.setGlobal("MyAddonDB", {...})`.
- **Hermetic per-test sandbox:** option to reset globals between tests (slow but isolated) vs shared sandbox (fast, less isolated).

## Reporter

**Default: TAP (Test Anything Protocol)**

```
TAP version 13
1..3
ok 1 - Inventory: counts items correctly
ok 2 - Inventory: handles empty bag
not ok 3 - Combat: fires PLAYER_REGEN_DISABLED
  ---
  message: Expected true, got false
  at: Tests/Combat.test.lua:12
  ...
```

**Optional: JSON** (structured, for the VSCode Test Explorer):

```json
{
  "suites": [
    {
      "name": "Inventory",
      "tests": [
        { "name": "counts items correctly", "status": "pass", "duration": 0.002 },
        {
          "name": "handles empty bag",
          "status": "fail",
          "message": "...",
          "file": "Tests/Inventory.test.lua",
          "line": 8
        }
      ]
    }
  ]
}
```

## VSCode Test Explorer Integration

Use the `vscode.TestController` API:

- Discover tests by scanning for `## X-Tests` TOC directives and `Tests/*.test.lua` conventions.
- Run/debug individual tests or entire suites from the Test Explorer tree.
- Display pass/fail gutters inline in the Lua test files.
- Stream results via JSON reporter; update tree incrementally as tests complete.

## Example Addon Test Structure

```
MyAddon/
  MyAddon.toc            ← add: ## X-Tests: Tests\Suite.test.lua
  Core/
    Logic.lua
  Tests/
    Suite.test.lua
    Helpers.lua           ← shared test utilities
```

The `## X-Tests` directive keeps test files out of the shipping TOC (they aren't loaded in real WoW — or add them under `## OptionalDeps: wowtest`).

## Key Technical Decisions

- **One runtime, two front-ends** — headless runner and webview renderer share the M5–M9 sandbox (no code duplication).
- **TAP primary** (portable, works with any CI runner) + **JSON** for the editor.
- **Hermetic per-suite sandbox reset** by default; opt-in shared sandbox for performance.

## Foreseen Hurdles

- **API mock gaps surface fastest here** — the test suite becomes a forcing function for M4 API coverage. Expect to discover and stub 20–30 additional functions during the first real addon test run.
- **Deterministic time ordering** — `C_Timer` callbacks must fire in insertion order at the correct virtual time; test this carefully.
- **Global state isolation** — Lua globals are mutable; without per-test reset, one test can poison another. Full reset is slower but safe.
- **Test file discovery in large addons** — some addons (e.g. DBM with 20+ modules) have complex structure; the `## X-Tests` directive gives authors explicit control.

## Dependencies

**M9** (script events — Lua runtime complete); benefits from **M10** (API profiles for multi-version testing).

## Rough Effort

**M** — 1–2 weeks.
