# Todo — Outstanding Tasks Without a Milestone

Cross-cutting items deferred from completed milestones, or tooling debt that doesn't fit a feature milestone. Review this file at the start of each milestone to see if anything should be scheduled.

Completed items are in [todo-archive.md](todo-archive.md).

---

## Listfile fast index (in-process / post-rustydemon era)

**Status: 📋 Pending**

**Prerequisite:** [M15 — CASC Asset Service](015_casc_asset_service.md) (or at minimum, a Node.js-native extraction path that doesn't call `rustydemon-cli`).

**Problem:** Once `rustydemon-cli` is gone, the community listfile is only needed by `atlas-gen.ts` (FileDataID → `Interface/` path join for the atlas manifest). That consumer reads the entire CSV as a full linear scan — currently ~837 ms in-process for 169 K pre-filtered rows, or several seconds for the full 2.17 M row file. This is acceptable today (atlas gen runs rarely), but becomes a regression if the manifest needs regenerating after every game patch.

**Goal:** Convert the CSV to a binary index on first use — either SQLite or a lightweight flat binary format — so that FileDataID lookups are sub-millisecond point queries rather than a full scan.

**Options to evaluate:**

1. **SQLite** (`better-sqlite3` or the built-in `node:sqlite` module added in Node 22.5) — `SELECT path FROM listfile WHERE id = ?` is sub-millisecond after the first open. Widely understood, easy to inspect. Adds a native or pure-JS dependency.
2. **Flat binary hash map** — sorted `(u32 id, u32 offset)` index + packed string table. Pure JS, zero deps, ~5–10 ms read overhead. More implementation work than SQLite.

**Scope note:** The listfile becomes fully unnecessary once [Atlas manifest from DB2](#atlas-manifest-from-db2-replace-wagotools) lands (DB2 files carry FileDataIDs natively). If that item lands before this one, skip this entirely.

See [measurements.md Q1b](../measurements.md#q1b-how-fast-can-we-pre-filter-listfilecsv-to-interface-only-entries) for the full benchmark that covers SQLite virtual table extensions (sqlite-xsv, sqlean vsv), INSERT+SELECT approaches (node:sqlite, better-sqlite3, @libsql/client), and the baseline Node.js stream approach — these are the starting points for evaluating the write-once/point-lookup pattern.

**Effort:** S (SQLite); M (custom binary format).

---

## Replace pngjs encoder with fast-png (BLP→PNG speedup) {#replace-pngjs-encoder-with-fast-png}

**Status: ❌ Cancelled — benchmarked, no improvement**

**Finding (2026-06-16):** Benchmarked against 112 BLP fixtures from the retail CASC corpus using `dev/bench-encoder-comparison.mjs`. fast-png and pngjs are statistically indistinguishable: median speedup 1.0×, weighted by BLP file size. For the largest textures (512×512–2048×1024) fast-png is sometimes slower (e.g. `uicampcollection.blp`: 113 ms vs 76 ms, 1.5× slower; `auctionhouse.blp`: 99 ms vs 79 ms, 1.3× slower).

The original hypothesis that "pngjs uses pure-JS zlib" was wrong: pngjs delegates to Node's built-in `zlib` (native C), not a JS implementation. That is why it performs identically to fast-png.

The encode step is not the bottleneck regardless — it costs 2–5% of total per-file time. The decode (`js-blp` `getPixels`) is 10–44× more expensive. See [measurements.md Q5b](../measurements.md#q5b-fast-png-vs-pngjs) for the full data.

fast-png was never added to package.json (the benchmark confirmed no benefit before it was committed). No cleanup needed.

---

## Atlas manifest from DB2 (replace wago.tools)

**Status: 📋 Pending**

`dev/gen-atlas.mjs` currently generates the atlas manifest by downloading `UiTextureAtlas` and `UiTextureAtlasMember` CSV table exports from wago.tools. This works but has two problems: it makes an outbound HTTP request to a third-party service at extension startup (whenever the manifest is absent), and it silently produces a stale manifest when the user is offline or when wago.tools lags behind a patch.

**Goal:** Replace the CSV download with direct parsing of the DB2 binary files extracted from the user's WoW installation. No outbound HTTP. The manifest is generated from the same build as the user's game data.

**Rough plan:**

1. **Read the DB2 files in-memory** — call `AssetService.readCascFile("dbfilesclient/uitextureatlas.db2")` and `readCascFile("dbfilesclient/uitextureatlasmember.db2")`. No disk extraction step needed: the asset server returns raw bytes directly. ~~rustydemon-cli~~ no longer involved.

2. **Parse the DB2 binary format** — write a minimal WDC4 parser in `src/assets/db2-parser.ts` (or inline in a new `gen-atlas-db2.ts`) covering only the two table schemas needed. The WDC4 format is documented; the field layouts for these two tables are fixed and small. Key reference: `_reference/wow.export/src/js/db/WDCReader.js`. The main complexity is bitpacked fields and the string table; both tables use simple non-packed integer and string fields so a hand-rolled subset parser is feasible without pulling in the full WDCReader infrastructure.

   Alternatively, use an npm DB2 parser such as `@wowserhq/db2` if one becomes available with a compatible license.

3. **FileDataID → path join** — unchanged: still uses the community listfile (now at `<cacheRoot>/downloads/listfile.csv`) to resolve FileDataIDs to `Interface/...` paths.

4. **Wire into `ensureAtlasManifest()`** — replace the `shellGenAtlas` spawn path (which calls `gen-atlas.mjs` → wago.tools) with an in-process DB2 parse call. Fall back to the wago.tools download only when `installDir` is not configured or `readCascFile` returns null.

**Depends on:** `AssetService.readCascFile` (complete). Having a WoW install configured (`scryer.installDir`) so the server can reach CASC. Falls back to wago.tools download if not.

**Effort:** M (WDC4 parser for two specific schemas: S; wire into ensureAtlasManifest + fallback logic: S; testing across retail/classic builds: S).

---

## TypeScriptToLua integration investigation

**Status: 📋 Pending**

TypeScriptToLua (TSTL) compiles TypeScript to Lua 5.1 and is widely used by WoW addon authors who want TypeScript's type system and modern syntax. From Scryer's perspective the output is ordinary Lua 5.1 — TSTL is a pre-compilation step the author performs before any Lua lands in the workspace. Scryer should run TSTL-compiled addons without special handling in the common case.

However, there are a few integration questions worth answering before M8 (TOC Execution Pipeline) is in progress:

1. **TSTL runtime library (`lualib_bundle`)** — TSTL emits a small runtime library (iterators, class system, `__TS__` helpers) that must load before addon code runs. Does the Scryer sandbox's load order accommodate it, or does it need an explicit entry point? Do any `lualib` patterns conflict with the WoW 5.1 shim (e.g. custom `__index` metamethods, use of `table.unpack`)?

2. **WoW API type stubs and TSTL** — The TSTL community maintains `@warcraft/types` (WoW API TypeScript declarations). If an author uses these, the compiled output makes the same API calls our stubs must handle. No new stub surface should be needed, but it's worth confirming the call patterns match expectations.

3. **Source maps** — TSTL can emit Lua source maps. If Scryer surfaces Lua errors (stack traces, sandbox violations), could source maps be used to point errors back to the TypeScript source? This would be a significant DX improvement for TSTL-authored addons.

4. **Addon detection** — Should Scryer detect TSTL-compiled addons (e.g. presence of `lualib_bundle.lua` in the addon directory or a TSTL config file) and adjust any behavior, or is "just run the Lua" always sufficient?

**Scope of this item:** Research and feasibility only. Answer questions 1–4, note any required sandbox or load-order changes, and decide whether any of them warrant a follow-up implementation task before or during M8.

**Effort:** XS–S (research); implementation unknown until investigation is complete.

---

## Live panel frame diffing (deferred from M4)

**Status:** 📋 Pending

**Problem:** The M4 live panel sends the full frame tree to the webview on every Lua mutation. For addons with large frame hierarchies or frequent mutations (e.g. `OnUpdate` handlers updating many frames per tick), this is wasteful — most of the tree is unchanged.

**Plan:** Track a shadow copy of the last-sent frame tree in `ScryerLivePanel`. On each mutation, compute a structural diff (added/removed/changed nodes) and send only the delta. The webview renderer applies incremental patches rather than rebuilding the DOM.

**Why deferred:** Full re-render is correct, simple, and sufficient for M4's goal of "does the addon render at all." Diffing is an optimization that only matters once real addons are running and frame counts are known. Premature optimization here would complicate the initial panel architecture.

**Effort:** S–M (depends on how complex the diff format needs to be; a simple recursive object comparison may be enough for the initial version).

---

## Placeholder 3D Graphics from CASC

**Status:** 📋 Pending (Stretch Goal)

**Background & Philosophy:**
Scryer is an addon development tool focusing on pure UI interactivity. It is **not** a game emulator, not an alternative WoW client, and we should never "ship" game graphics or make it appear that we are a game using WoW graphics.

Previously, we resolved the need for "game static backgrounds" by allowing developers to set a custom workspace background picture for the webview. This provides the context some UI authors want without Scryer needing to render game terrain.

However, some addons (e.g., character model viewers, transmog frames) would genuinely benefit from really basic placeholder 3D graphics extracted directly from the user's CASC installation.

**Goal:** Provide rudimentary support for 3D graphics using local CASC assets strictly for UI context (e.g., `<PlayerModel>` or `<DressUpModel>` elements).

**What this item covers:**

1. **Investigate 3D extraction:** Explore reading `.m2` or related 3D models locally from the user's CASC directory.
2. **Minimal Renderer:** Render a basic placeholder model in the canvas without textures, or with very low fidelity, enough to prove the addon's model frame sizing and positioning works.
3. **Maintain boundaries:** Strictly ensure this does not cross into "game emulation." The environment remains a blank UI canvas; 3D models are isolated entirely to explicitly requested Model frames.

**Effort:** XL

---

## XML + Lua coupling in static preview

**Status:** 📋 Pending

The current M2 static XML preview ignores any `.lua` files referenced in the same TOC. This works for purely declarative frames, but many addons use Lua to set up templates, register scripts, or populate `FontString` text at load time. Without any Lua execution, these frames render incomplete — missing text, incorrect visibility, or referencing templates that only exist as Lua tables.

**The core design question:** how much Lua execution, if any, is appropriate in the "static" preview path? Options:

1. **None (current)** — parse and render the XML literally; Lua side-effects are absent but the preview is predictable and instant.
2. **Template-only execution** — run just enough Lua to register virtual frames and templates that XML `inherits=` attributes reference, but skip all `OnLoad`/event handlers.
3. **Run-and-freeze** — execute the full TOC load sequence (XML parse + Lua execution through `ADDON_LOADED` / `PLAYER_LOGIN`) exactly once, then tear down the Lua VM and leave the resulting frame snapshot frozen in the webview. No event loop, no `OnUpdate`, no interactivity. The panel becomes a static snapshot of what the addon looked like after load, not a live session.
4. **Full execution on preview** — the static preview becomes the live preview (M7+), removing the distinction entirely.

Option 3 is an attractive middle ground: it gives correct initial state (text populated, visibility set, templates resolved) without the overhead or complexity of a live session. The tradeoff is that anything requiring ongoing event dispatch — progress bars, conditional visibility on player state, `OnUpdate` animations — won't reflect correctly. The panel being non-interactable is intentional: no clicks, no keyboard events, no `OnEvent` callbacks fire after the initial load.

**What this item covers:**

1. **Audit real addons** — look at 5–10 popular addons in `_live/` or `_reference/wow-cookbook` and note how many XML files have meaningful Lua coupling (templates defined in Lua, text set in `OnLoad`, etc.). This determines how bad the current gap is in practice.
2. **Decide the static/live boundary** — document the decision as one of the four options above; option 3 (run-and-freeze) is the most likely candidate if any Lua execution is added to the static path.
3. **Surface the gap to users** — if a previewed XML file has a TOC with Lua entries, show a status bar note: "Lua files not executed — use _Run_ for live preview." This sets expectations without requiring a full implementation.
4. **Write ADR** if the static/live boundary changes from the current assumption.

**Effort:** S (audit + decision + status bar note). Implementing option 3 would be an additional S–M on top, gated on M8.

---

## F5 run mode

**Status:** 📋 Pending

Once M8 (TOC Execution Pipeline) and M9 (Script Events) are complete, the full addon runtime exists — but it may only be reachable via `scryer.openLive` from the command palette. Developers expect F5 (or equivalent) to mean "run this thing."

**Goal:** Make the full execution pipeline discoverable with a single keystroke. Press F5 in any `.xml`, `.lua`, or `.toc` file that belongs to a WoW addon → Scryer finds the TOC, loads the full addon, and opens (or focuses) the live preview panel.

**What this item covers:**

1. **Command:** `scryer.run` contributed in `package.json` with a keyboard shortcut (default `F5`), constrained to addon files (via `when` clause: `editorLangId in ['xml', 'lua']`). The command logic: walk up from the active file to find the nearest `.toc`, then launch `scryer.openLive` against it.
2. **Re-run on F5 in panel focus** — if the live preview panel is focused, F5 re-runs (reloads) the current addon without re-opening the panel.
3. **Stop/restart** — consider `Shift+F5` to stop execution (tear down the sandbox, clear the frame tree) without closing the panel.
4. **Status bar integration** — the existing per-panel `StatusBarItem` could show a "▶ Run" / "■ Stop" affordance when a TOC is detected.

**Scope note:** This item is purely a UX/discoverability layer on top of M8+M9. No new runtime capability is added; the command wiring and TOC discovery are the only implementation work.

**Effort:** S — the runtime is M8+M9; this is ~2–3 hours of command registration, `when` clause tuning, and TOC-finder logic.

---

## Keyboard input handling in preview

**Status:** 📋 Pending

Once the full runtime (M8+M9) is running, the preview webview becomes an interactive WoW-like surface. WoW addons register keyboard handlers, open/close frames on key presses, and rely on the default WoW keybindings (e.g. ESC closes the topmost open frame). The webview's default key behavior will conflict with this — VS Code owns most keys while the panel is not focused.

### Design: "Game Input" mode

The solution is an explicit opt-in toolbar toggle rather than any automatic capture heuristic. The toolbar shows a gamepad/controller icon button. Clicking it enters **Game Input mode**:

- The preview canvas receives a visible focus ring or overlay indicator (e.g. a subtle colored border) so the user knows input is captured.
- All keystrokes are intercepted in the webview and routed through the Lua event bridge (`KeyDown`, `KeyUp`, and synthesized WoW binding events) rather than bubbling to VS Code.
- **ESC exits Game Input mode** — it does not fire `ESCAPE_PRESSED` into the addon. This gives the user a reliable, always-available escape hatch without any chord to remember. If an addon needs to handle ESC, the user can re-enter Game Input mode and press ESC again; that second ESC press, while already in the game layer, fires `ESCAPE_PRESSED`. (This two-press pattern matches how browser fullscreen / pointer lock APIs work and sets clear expectations.)
- While Game Input mode is inactive, all keys stay with VS Code as normal — no capture, no routing, no side effects.

The toolbar icon should be a small gamepad or controller glyph (e.g. a Unicode `🎮` or an SVG controller icon from the VS Code icon set). The button toggles between an idle state (outline / dimmed) and an active state (filled / accent color) to make current mode immediately obvious.

### Implementation plan

1. **Toolbar button** — add a "Game Input" toggle button to the preview panel toolbar (alongside existing controls like the eyedropper and ruler). State: idle / active. Icon: controller or gamepad.
2. **Enter Game Input mode** — on click, the webview posts a message to itself (or handles it inline) to begin `keydown`/`keyup` interception via `addEventListener` with `{ capture: true }`. Apply a focus-indicator style to the canvas wrapper.
3. **Key routing** — intercepted keys are translated to WoW key names (e.g. `"a"` → `"A"`, `"F1"` → `"F1"`, `"ESCAPE"` → `"Escape"`) and posted to the extension host, which fires `KeyDown` / `KeyUp` script events on the focused frame (or the UIParent if no frame is focused).
4. **ESC exits** — `keydown` handler checks for `Escape` first: if Game Input mode is active, exit the mode (remove interception, clear indicator) and swallow the event. No WoW event fires on this first ESC. A subsequent ESC press while back in Game Input mode does fire `ESCAPE_PRESSED`.
5. **WoW default keybindings** — out of scope for phase 1. Only raw `KeyDown`/`KeyUp` events are dispatched. `SetBinding`/`SetBindingClick` emulation is a separate follow-up item if real addons need it.
6. **Virtual gamepad / controller input** — out of scope; noted for future consideration.

### Open questions

- Should clicking anywhere inside the canvas auto-enter Game Input mode, or must the user always click the toolbar button? (Recommendation: toolbar only — avoids accidental capture when clicking to inspect a frame.)
- Should the `StatusBarItem` also reflect Game Input mode state (e.g. show `[Game Input]` label)?

**Depends on:** M9 (Script Events) for the `KeyDown`/`KeyUp` event bridge.

**Effort:** S–M — the mode toggle and ESC escape hatch are ~2–4 hours; key-name translation and Lua event dispatch add another ~2–4 hours depending on how complete the key map needs to be.

---

## Addon state emulation

**Status:** 📋 Pending

Real WoW addons react to game state: player health drops, a new buff is applied, a quest completes, the player enters combat. Testing these reactions in the real game requires either waiting for the right game event or using test tools that exist inside the game. Neither is CI-friendly.

**Goal:** A secondary scripting layer that lets addon authors (or a test addon) drive simulated game state changes, so that a Scryer test suite can assert "when player health drops below 20%, the low-health flash frame becomes visible" without a running WoW client.

**Concept — "addons testing addons":**

An author ships a companion addon (e.g. `MyAddon_Tests`) that uses a Scryer-specific API to manipulate state:

```lua
-- hypothetical Scryer test API
ScryerTest.SetUnitHealth("player", 0.15)  -- fires UNIT_HEALTH event
ScryerTest.SimulateEvent("COMBAT_LOG_EVENT_UNFILTERED", ...)
ScryerTest.Assert(MyAddon.lowHealthFrame:IsShown(), "low health frame should be visible")
```

This is not a general WoW emulator — it only needs to cover the subset of game state that UI addons can _observe_ (unit stats, events, aura states, etc.), not the subset they _cause_ (damage dealt, movement, etc.).

**Architecture:**

- `ScryerTest` is a global table injected into the sandbox alongside the WoW API stubs (M6). It is absent from the real WoW environment (addons that accidentally ship test code get a no-op stub or an error, not a game-breaking call).
- `ScryerTest.SimulateEvent(event, ...)` — fires the named event on the frame event bus, reaching any addon that called `frame:RegisterEvent(event)`.
- `ScryerTest.SetUnitHealth` / `SetUnitAura` / etc. — update the mock state tables backing `UnitHealth`, `UnitBuff`, etc. stubs, then fire the corresponding event.
- Test results flow back via `ScryerTest.Assert` / `ScryerTest.Fail` → collected by the extension host → shown in VS Code Test Explorer (M12).

**Depends on:** M12 (Test Suite) for the runner and Test Explorer integration. M9 (Script Events) for the event bridge that `SimulateEvent` needs.

**Effort:** M–L — the state tables and `SimulateEvent` wiring are S; a comprehensive enough stub surface to cover real addon test patterns is M; a VS Code Test Explorer integration is M. Total is M–L depending on how complete the stub surface needs to be.

---

## WYSIWYG widget placement

**Status:** 📋 Pending

Addon developers often prototype frame layouts by guessing anchor values and reloading. A drag-to-place mode in the preview would let them position frames visually and get the correct anchor XML or Lua back without any trial-and-error.

**Goal:** Click a frame in the live preview, drag it to a new position, and have Scryer emit the updated `<AbsInset>` / `<Anchor>` XML fragment or Lua `SetPoint` call that reproduces that position.

**What makes this hard:**

WoW's anchor system is constraint-based — a frame's position is determined by up to two anchor points, each relative to a named frame and a point (TOPLEFT, CENTER, etc.). Inverting a rendered position back to an anchor description is ambiguous: the same pixel position can be expressed as dozens of valid anchor combinations. The tool needs a strategy for which anchor form to prefer (e.g. preserve the existing anchor type and only update the offsets, or default to `TOPLEFT` + `BOTTOMRIGHT` for two-anchor frames).

**Rough plan:**

1. **Drag affordance in webview** — in a "placement mode" (toggled via toolbar or command), frames become draggable. Mouse events update a ghost overlay; on drop, the new absolute position is reported to the extension host.
2. **Anchor inversion** — given the frame's current anchor configuration (from the IR) and its new pixel position, compute updated `x`/`y` offsets. If the frame has two anchors that fix both axes, update both offsets independently. If one anchor is `CENTER`, update to keep it centered at the new position.
3. **Output** — show a small popover or notification with the updated XML snippet. "Copy to clipboard" button. Optionally, offer to write the change back to the source file directly (this is the risky path — file writes require confirming the right source location).
4. **Resize handles** — extend drag to the frame edges/corners for resizing, which requires updating `<Size>` values and/or the second anchor's offset.

**Constraints:**

- Frames with templated anchors (where the anchor is in a Blizzard parent template) cannot be written back to the source file — only frames with anchors directly in the addon XML are candidates for in-place editing.
- This feature is UI-only (no runtime state changes); it operates on the rendered layout, not the Lua frame object.

**Depends on:** M7 (Frame Object Model) for the live panel and frame identity tracking; M9 (Script Events) for the event bridge that drag events will use.

**Effort:** L — the drag affordance and anchor inversion for simple cases are S; handling the full variety of anchor configurations (CENTER, relative-to-sibling, two-axis independence) is M; safe source-file write-back is M. Total L.

---
