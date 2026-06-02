# Backlog — Outstanding Tasks Without a Milestone

Cross-cutting items deferred from completed milestones, or tooling debt that doesn't fit a feature milestone. Review this file at the start of each milestone to see if anything should be scheduled.

Completed items are in [backlog-archive.md](backlog-archive.md).

---

## TGA texture decode (deferred from M3)

**Problem:** TGA (Targa) textures are used by many addon-bundled images. M3 logs a warning and shows a labeled placeholder for `.tga` files; it does not decode them.

**Plan:**

1. Pick a pure-JS TGA decoder (e.g. `tga-js` on npm, or a small custom reader — the format is simple: uncompressed or RLE-compressed, fixed header).
2. Decode TGA → RGBA buffer, then encode to PNG via `pngjs` (same pipeline as BLP).
3. **Critical:** respect the TGA image-origin descriptor byte (bit 5 of byte 17). If set, the image data is top-to-bottom; if clear, it is bottom-to-top. `dev/assets.sh` stores TGAs with the flip applied and the bit set correctly — the decoder must read it to avoid upside-down textures.
4. Cache in `<cacheRoot>/derived/textures/` using the same SHA1 key scheme as BLP.
5. Add tests against a small known-good TGA fixture (bottom-to-top + top-to-bottom variants).

**Effort:** S — ~2–4 hours once a TGA library is selected.

---

## In-process JavaScript CASC reader (replace extract.sh + rustydemon-cli)

**Problem:** The on-demand extraction flow (see above) depends on `rustydemon-cli` being installed and `dev/config.local.sh` being configured. This is a friction point for end users of the extension — they are addon developers, not tool installers. The extension should be able to read textures directly from the WoW install without any external binary.

**Goal:** Replace the `extractMissing(paths)` internals with a pure-JS CASC reader that reads directly from `scryer.installDir`. The function signature stays identical — only its implementation changes (this is exactly why the function boundary was designed the way it was). End result: install the extension, point `scryer.installDir` at your WoW folder, open an XML file, textures load. No shell script, no rustydemon-cli, no listfile download.

**What changes:**

- `AssetService.extractMissing(paths)` is reimplemented without spawning a subprocess. Given a list of WoW-relative texture paths, it opens the CASC storage at `scryer.installDir`, reads the requested files, writes them into `<cacheRoot>/source/`, and returns.
- `scryer.extractScriptPath` and `scryer.flavor` configs become unnecessary (flavor can be auto-detected from the install's `.build.info`).
- `dev/extract.sh` and `dev/config.local.sh` remain as developer/contributor tooling but the extension no longer requires them.
- The community listfile is no longer needed — CASC file lookup by virtual path is handled internally via the TVFS manifest and encoding tables.

**Reference implementations (all MIT, listed in NOTICE):**

Full source for all of the following is checked into `_reference/` (read-only):

- **wow.export** (Kruithne) — JavaScript GUI that reads WoW CASC archives directly in Node/Electron. Primary reference: same author as `js-blp` (which we already use), so the JS idioms will be familiar. Start here. The MIT license covers direct code integration; the developer has also given their personal blessing, which is a welcome bonus (see [`docs/reference/wow.extract_code_permission_kruithne_discord_2026-05-25.png`](../reference/wow.extract_code_permission_kruithne_discord_2026-05-25.png)).
- **CascLib** (Ladislav Zezula) — C reference implementation; useful for cross-checking edge cases in encoding/index parsing.
- **SereniaBLPLib** (Xalcon) — C# BLP texture parser; useful reference for DXT decompression edge cases (though js-blp already handles BLP).
- **TACTLib** (Overtools) — C# implementation with good TVFS and static-container coverage.
- **casc-extractor** (Xerrion) — Rust CLI and library; additional reference for archive index and BLTE handling.
- **wowdev.wiki/CASC** — format documentation for CASC, TACT, BLTE, encoding, and TVFS manifest structures.

**Key CASC concepts to implement (in rough dependency order):**

1. Parse `.build.info` / `.product.db` to locate the active build config.
2. Read the build config and CDN config to find the encoding manifest and archive indices.
3. Parse the encoding table (content hash → encoded hash lookup).
4. Parse the root file (TVFS or legacy flat root) to map virtual paths (e.g. `Interface/Buttons/UI-CheckBox-Check.blp`) → content hash.
5. Given a content hash, locate the data in local archive indices and read the BLTE-encoded block.
6. Decompress BLTE (zlib or none) to recover the raw file bytes (BLP in this case).

Retail uses TVFS (introduced in 8.2); Classic uses the older flat-root format. Both must be supported if we want to cover all three flavor targets.

**Effort:** L — CASC is a multi-layer format (build info → encoding → root → index → BLTE). wow.export is a strong prior art reference that de-risks most of the format work, but this is still the largest single item on the backlog.

---

## Listfile fast index (in-process / post-rustydemon era)

**Status: 📋 Pending**

**Prerequisite:** [In-process CASC reader](#in-process-javascript-casc-reader-replace-extractsh--rustydemon-cli) (or at minimum, a Node.js-native extraction path that doesn't call `rustydemon-cli`).

**Problem:** Once `rustydemon-cli` is gone, the community listfile is only needed by `atlas-gen.ts` (FileDataID → `Interface/` path join for the atlas manifest). That consumer reads the entire CSV as a full linear scan — currently ~837 ms in-process for 169 K pre-filtered rows, or several seconds for the full 2.17 M row file. This is acceptable today (atlas gen runs rarely), but becomes a regression if the manifest needs regenerating after every game patch.

**Goal:** Convert the CSV to a binary index on first use — either SQLite or a lightweight flat binary format — so that FileDataID lookups are sub-millisecond point queries rather than a full scan.

**Options to evaluate:**

1. **SQLite** (`better-sqlite3` or the built-in `node:sqlite` module added in Node 22.5) — `SELECT path FROM listfile WHERE id = ?` is sub-millisecond after the first open. Widely understood, easy to inspect. Adds a native or pure-JS dependency.
2. **Flat binary hash map** — sorted `(u32 id, u32 offset)` index + packed string table. Pure JS, zero deps, ~5–10 ms read overhead. More implementation work than SQLite.

**Scope note:** The listfile becomes fully unnecessary once [Atlas manifest from DB2](#atlas-manifest-from-db2-replace-wagotools) lands (DB2 files carry FileDataIDs natively). If that item lands before this one, skip this entirely.

See [measurements.md Q1b](../measurements.md#q1b-how-fast-can-we-pre-filter-listfilecsv-to-interface-only-entries) for the full benchmark that covers SQLite virtual table extensions (sqlite-xsv, sqlean vsv), INSERT+SELECT approaches (node:sqlite, better-sqlite3, @libsql/client), and the baseline Node.js stream approach — these are the starting points for evaluating the write-once/point-lookup pattern.

**Effort:** S (SQLite); M (custom binary format).

---

## Standardize on lowercase extraction paths

**Status:** 📋 Pending

**Problem:** `community-listfile-withcapitalization.csv` is preferred but some releases don't ship it, forcing a fallback to the lowercase `community-listfile.csv`. When the fallback is used, rustydemon-cli extracts files to lowercase paths (e.g. `interface/addons/...`). Any code that constructs or compares paths using the mixed-case form (`Interface/AddOns/...`) then fails to find the files on a case-sensitive filesystem (Linux, WSL `/tmp`). Today we work around this in `gen-api-stubs.ts` with a `findDirCaseInsensitive` helper, but every extraction consumer has the same latent bug.

**Why:** WoW's virtual filesystem is case-insensitive. All paths in CASC are stored lowercase internally. The capitalized listfile is a community convenience artifact, not authoritative. Standardizing on lowercase removes the dependency on that artifact and eliminates a whole class of case-mismatch bugs.

**Plan:**

1. **Flip listfile priority** in `extract-core.ts`: try `community-listfile.csv` (plain, always lowercase) first; try `-withcapitalization` as the opt-in if explicitly requested or if the user somehow needs mixed-case paths for non-WoW tooling.
2. **Post-extraction normalize** in `extractRetailPaths` / `extractLoosePaths`: after rustydemon or loose-file copy completes, walk the output subtree and rename any directory or file whose name is not already lowercase. One-time pass, idempotent on repeat runs.
3. **Update all path constants** (`TEXTURE_GLOBS`, `INTERFACE_GLOBS`, `API_DOC_GLOB`, cache lookup keys) to use lowercase. All internal path construction uses `.toLowerCase()` at the boundary where paths enter the system (user input, CASC output).
4. **Remove `findDirCaseInsensitive`** from `gen-api-stubs.ts` once the normalization step above is in place.

**Why:** Fixes fallback-listfile extraction silently landing files at wrong case paths. Immune to Blizzard renaming folders between patches. One fewer exception to reason about across the whole pipeline.

**Effort:** S

---

## Direct proprietary texture serving in the webview (BLP/TGA decode bypass)

**Status: Pending exploration**

**Context:** All textures currently go through a conversion pipeline (BLP→PNG or TGA→PNG) in the extension host before being served to the webview as `asset://` URIs. The benchmark showed that PNG _compression_ of large textures dominates decode cost (~4 s for a 1024×1024 DXT texture). This raises the question: could WoW's proprietary formats be served to the webview more directly, bypassing or deferring the compression step?

**Hypothesis:** Browsers have no native BLP support, so serving `.blp` files directly to an `<img>` tag is not possible. The real question is whether we can avoid PNG _compression_ specifically — not whether we can avoid decoding. Several approaches are worth evaluating before assuming the current pipeline is optimal:

1. **Raw RGBA transfer via message** — decode BLP/TGA to a raw RGBA buffer in the extension host (already done internally by `js-blp`) but send the buffer as a `Uint8Array` message instead of compressing to PNG. The webview reconstructs an `ImageData` and blits it to a `<canvas>` element. Eliminates `PNG.sync.write` entirely. Tradeoff: canvas elements instead of `<img>` tags; layout changes needed.

2. **ImageBitmap from ArrayBuffer** — variant of (1) using `createImageBitmap(new ImageData(...))` in the webview for hardware-decoded compositing. Potentially faster than canvas blit; same architectural change required.

3. **WASM BLP decoder in the webview** — bundle a WASM BLP decoder inside the webview bundle; send raw `.blp` bytes from the extension host (no decode, no PNG), let the webview decode locally. Avoids the extension host decode entirely. Likely blocked by VSCode's webview CSP restrictions (`'unsafe-eval'` / `wasm-unsafe-eval` may not be grantable).

4. **Compressed GPU texture formats (DXT/BCn via WebGL)** — BLP already stores many textures as DXT1/DXT3/DXT5 blocks internally. A WebGL renderer could upload these blocks directly as `COMPRESSED_RGBA_S3TC_DXT*` textures, skipping decode entirely. High complexity; requires moving from DOM to a WebGL renderer; a later-milestone concern (see Canvas/WebGL in Stretch Goals).

**Recommendation:** Approach (1) is the lowest-risk change and directly attacks the measured bottleneck (PNG compression). Approach (3) is the most architecturally clean but needs a quick CSP feasibility check before any code is written. Approaches (2) and (4) are refinements or longer-term ideas.

**Scope of this item:** Research and feasibility only. Prove out whether VSCode's webview CSP permits the required capabilities for each approach, estimate the layout changes needed for canvas-based rendering, and decide whether any approach clears the bar to justify a follow-up implementation task. Do not implement without a separate backlog item.

**Effort:** XS (research/feasibility); S–M for any approach taken to implementation.

---

## Atlas manifest from DB2 (replace wago.tools)

**Status: 📋 Pending**

`dev/gen-atlas.mjs` currently generates the atlas manifest by downloading `UiTextureAtlas` and `UiTextureAtlasMember` CSV table exports from wago.tools. This works but has two problems: it makes an outbound HTTP request to a third-party service at extension startup (whenever the manifest is absent), and it silently produces a stale manifest when the user is offline or when wago.tools lags behind a patch.

**Goal:** Replace the CSV download with direct parsing of the DB2 binary files extracted from the user's WoW installation. No outbound HTTP. The manifest is generated from the same build as the user's game data.

**Rough plan:**

1. **Extract the DB2 files** — extend `dev/extract.sh --type atlas` (or the on-demand extractor) to pull `dbfilesclient/uitextureatlas.db2` and `dbfilesclient/uitextureatlasmember.db2` from CASC via rustydemon-cli, writing them to `<sourceDir>/dbfilesclient/`.

2. **Parse the DB2 binary format** — write a minimal WDC4 parser in `dev/parse-db2.mjs` (or inline in `gen-atlas.mjs`) covering only the two table schemas needed. The WDC4 format is documented; the field layouts for these two tables are fixed and small. Key reference: `_reference/wow.export/src/js/db/WDCReader.js`. The main complexity is bitpacked fields and the string table; both tables use simple non-packed integer and string fields so a hand-rolled subset parser is feasible without pulling in the full WDCReader infrastructure.

   Alternatively, use an npm DB2 parser such as `@wowserhq/db2` if one becomes available with a compatible license.

3. **FileDataID → path join** — unchanged: still uses the community listfile (now at `<cacheRoot>/downloads/listfile.csv`) to resolve FileDataIDs to `Interface/...` paths.

4. **Wire into `ensureAtlasManifest()`** — `AssetService.ensureAtlasManifest()` currently calls `shellGenAtlas` which spawns `gen-atlas.mjs`. After this change, `gen-atlas.mjs` falls back to the wago.tools download only when the DB2 files are absent (first run before any extraction), and prefers the local files when they exist.

**Depends on:** Having a WoW install configured (`scryer.installDir`) so the DB2 files can be extracted. Falls back to wago.tools download if not.

**Effort:** M (WDC4 parser for two specific schemas: S; DB2 extraction plumbing + fallback logic: S; testing across retail/classic builds: S).

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

## Preview background philosophy

**Status:** 📋 Pending

Scryer is an addon development tool — not a game emulator, not an alternative WoW client. The preview viewport intentionally omits game world graphics (terrain, character models, sky, particles). Only addon UI frames are rendered.

This matters because it is easy to drift: as fidelity improves, requests will come in for "why doesn't the world show behind the frames?" The answer is that rendering game geometry is out of scope by design, and there is real value in the current approach — a clean, distraction-free canvas makes frame layout and texture debugging much easier than it would be against a real game background.

**What this item covers:**

1. **Write ADR** — document the decision with context, the out-of-scope boundary ("no game world graphics"), and why that boundary is correct. Record what Scryer _is_: a UI frame preview and execution sandbox, not a visual WoW emulator.
2. **Improve placeholder fidelity** — the colored placeholder tiles are currently functional but not beautiful. Evaluate: should missing textures use a subtle checkerboard or the current hue-based solid color? Should textures that _have_ a resolved file but failed to decode show differently from ones that were never extracted?
3. **Viewport background** — the dark checker pattern is configurable (already in `defaults.json`). Confirm the defaults are a good "neutral canvas" for addon work, not something that implies a game world.
4. **No out-of-scope creep** — explicitly note in the ADR that requests for terrain, sky, or character rendering should be closed as out-of-scope.

**Effort:** XS (ADR + minor placeholder polish).

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

Once the full runtime (M8+M9) is running, the preview webview becomes an interactive WoW-like surface. WoW addons register keyboard handlers, open/close frames on key presses, and rely on the default WoW keybindings (e.g. ESC closes the topmost open frame). The webview's default key behavior will conflict with this.

**Questions to resolve before implementing:**

1. **ESC key** — In VS Code's webview, ESC closes the panel or blurs the editor. In WoW, ESC closes the topmost open full-screen frame (the "UISpecialFrames" stack). These two behaviors conflict. Options: (a) intercept ESC in the webview and synthesize a WoW `ESCAPE_PRESSED` event, letting VS Code's ESC only fire if no WoW frame consumes it; (b) provide a toggle to "capture keyboard input" that swallows ESC; (c) document the conflict and let addon authors work around it.

2. **WoW default keybindings** — WoW has a large default keybinding table (movement, targeting, action bars, etc.). Most are irrelevant to UI addon development. The preview only needs to emulate bindings that addons are likely to test: ESC, Enter, Tab, and any custom bindings an addon registers via `SetBinding`/`SetBindingClick`.

3. **Input capture toggle** — A panel control (button or checkbox: "Capture keyboard") that, when active, routes all keystrokes through the Lua event bridge (`KeyDown`, `KeyUp` events) rather than letting them bubble to VS Code. Pressing the toggle again (or pressing a configurable release chord like Ctrl+ESC) releases capture.

4. **Virtual gamepad / binding emulation** — Out of scope for now, but note it for the future: addons that use controller input will need a different strategy.

**Approach:**

- Phase 1 (this item): resolve questions 1–3, write an ADR on the keyboard capture strategy, and implement input capture toggle + ESC routing in the webview.
- Phase 2 (deferred): full binding table emulation if real addons require it.

**Effort:** S–M — the design question is the hard part; once the strategy is decided, webview event listener setup + Lua event dispatch is ~4–8 hours.

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

## StatusBar fill texture rendering (deferred from M7)

**Status:** 📋 Pending

**Problem:** `StatusBar` frames created via `CreateFrame("StatusBar", ...)` render as plain frames — no fill bar is visible. `SetValue(75)` / `SetMinMaxValues(0, 100)` sets internal state but produces no visual output.

**Plan:** In `frameNodeToIR` (or `statusBarNodeToIR`), when `statusBarValue` is set and the frame has an explicit width, synthesise a fill texture in the ARTWORK layer with width proportional to `(value - min) / (max - min)`. Apply `statusBarColor` or `statusBarTexturePath` as the fill appearance. For the case where width is not yet known at serialization time, add a `data-*` attribute to the rendered DOM element and let the webview apply the fill percentage via CSS after layout.

**Effort:** S — the serialization-time approach is straightforward; the post-layout percentage approach requires a small webview-side addition.

**Depends on:** M7 (done).

---

## NineSlice border rendering fidelity (DiamondMetal)

**Status:** 📋 Pending

**Reference resources:** [`docs/reference/border-rendering/`](../reference/border-rendering/) — full session notes, in-game reference screenshot, and two Scryer screenshots showing intermediate states.

### Problem

`ExampleFrameModalDialog` uses `DialogBorderTemplate`, which applies a NineSlice with DiamondMetal corner and edge art. Two rendering defects remain after the fixes shipped in 2026-06:

1. **Edge tiling stride is wrong.** The horizontal edge sprites (`_UI-Frame-DiamondMetal-EdgeTop`, `_UI-Frame-DiamondMetal-EdgeBottom`) are 64px wide but live in a 128px-wide sheet (right half transparent). CSS `background-repeat` strides at `sheetW = 128px`, producing a 64px-metal / 64px-gap alternating pattern. The border edges look broken or absent. Vertical edges are fine — their sheet height equals sprite height.

2. **Border protrusion is minimal.** With the `overflow:visible` fix in place, diamond corners do visually extend past the dark background. But the effect is subtle (only the 7px Bg inset gap). Compared to the in-game reference at 3440×1440, the border looks thin. This may be a visual scale difference between the in-game capture and Scryer's `frameScale`, not a real rendering error — needs evaluation after fix #1 lands.

### What is confirmed correct (don't re-investigate)

- `Dialog` NineSlice layout has **no x/y offsets** — corners are placed at (0,0) of the border frame by design. The "floating" effect comes from artwork geometry + the 7px Bg inset, not a layout offset.
- `overflow:visible` on `useParentLevel` frames (`renderer.ts:198`) — shipped, correct. Lets corners extend past frame bounds.
- Corner sizing: resolves to 64×64 logical via `-2x` ÷ 2. Correct.
- Bg inset: 7px resolves correctly via `layoutByTwoAnchors`. Correct.
- `SetHorizTile(true)` is captured correctly all the way to `tilesH: true` in `applyAsset`. The tiling flag is right; only the stride is wrong.

### Atlas sheet layout (confirmed by inspecting the PNG)

Sheet `uiframediamondmetal2x.blp` (128×512 logical):

- Edge sprites at x=0, w=64 — occupy **left half only**. Right half (x=64..128) is transparent.
- Corner sprites below, also left-half.

Sheet `uiframediamondmetalvertical2x.blp` (256×64 logical):

- Left edge at x=0.5, right edge at x=65.5 — each 64px wide. Sheet height = 64 = sprite height. **No stride problem for vertical edges.**

### Fix plan: canvas-based sprite extraction for horizontal edges

CSS `background-repeat` cannot tile a sub-region of a sprite sheet — the stride always equals `background-size`. The only correct approach is to extract the sprite region to an offscreen canvas and use the canvas data URL as the background tile.

**Approach:**

```typescript
// In src/webview/main.ts, applyAsset
// Trigger condition: crop.tilesH && crop.sheetW > crop.width
const physicalScale = img.naturalWidth / crop.sheetW; // computed from loaded image
const canvas = document.createElement("canvas");
canvas.width = crop.width;
canvas.height = crop.height;
ctx.drawImage(
  img,
  Math.round(crop.x * physicalScale),
  Math.round(crop.y * physicalScale),
  Math.round(crop.width * physicalScale),
  Math.round(crop.height * physicalScale),
  0,
  0,
  crop.width,
  crop.height,
);
// Apply: background-size: crop.width × crop.height; background-repeat: repeat-x
```

`physicalScale` is computed dynamically from `img.naturalWidth / crop.sheetW` — no upstream IR or atlas-manifest changes needed.

**Why the first canvas attempt failed (2026-06-02):**

The implementation applied the canvas result asynchronously (`Promise.then`), but also ran the CSS placeholder path synchronously first. The two writes raced and/or caused layout artifacts. The correct approach is to NOT fall through to the CSS path for tiling sprites that need canvas — either skip the CSS path entirely for those elements, or set a `data-pending-tile` attribute and apply only after the canvas resolves.

**Implementation steps:**

1. Add `loadImage(uri)` → `Promise<HTMLImageElement>` with a `Map` cache (keyed by URI).
2. Add `extractSpriteDataUrl(uri, crop)` → `Promise<string>` with a result cache (keyed by `uri:x,y,w,h`).
3. In `applyAsset`, when `needsCanvasH || needsCanvasV`:
   - Skip the CSS placeholder path for the tiling axes.
   - Call `extractSpriteDataUrl` and apply only after resolution.
   - Set a placeholder background (solid or the non-tiling CSS) until the promise resolves.
4. Vertical edges (`crop.tilesV && crop.sheetH > crop.height`): same treatment, but in practice the current vertical DiamondMetal sheets don't need it (sheetH = crop.height). Handle generically anyway.

**Effort:** S — the logic is understood; the first attempt failed on async ordering. ~2–4 hours to implement correctly.

---

## API stub autogeneration (`gen-api-stubs.ts`)

**Status:** ⬜ Pending (M13)

**Problem:** Hand-maintaining WoW API stubs in `wow-api.ts` doesn't scale. There are 329 `Blizzard_APIDocumentationGenerated` files covering 5000+ functions. Currently only two functions are hand-patched to return non-nil (the ones that crash Lua on nil). All other C\_\* calls return nil via a metatable fallback — correct for now, but as more Blizzard Lua loads, more functions will need correct return shapes.

**Plan:** `dev/gen-api-stubs.ts` script:

1. Extracts `Interface/AddOns/Blizzard_APIDocumentationGenerated/*.lua` from the game via cascTool (same pattern as `dev/extract.ts`, reusing `extractPaths` from `src/assets/extract-core.ts`)
2. Parses each file by executing it in a wasmoon sandbox with a stub `APIDocumentation:AddDocumentationTable` collector (no regex)
3. Generates `src/lua/api-stubs/base/<Namespace>.ts` from retail (one file per namespace, named by namespace not section name)
4. Generates `src/lua/api-stubs/<flavor>/<Namespace>.ts` delta files for classic/classic_era — only when a namespace is absent from base or has a different return shape
5. Return-shape-aware zero values: `IsArray` return → `[]`, non-nilable Structure return → `{}`, else → `undefined`
6. File-level change detection via `// @gen-hash: sha256:<lua-bytes>` header — skip write if unchanged; stubs accumulate and are never deleted
7. Per-flavor manifests (`manifest.<flavor>.ts`) list exactly which functions exist in that flavor — drive registration, act as the filter at runtime
8. Generates `src/lua/api-stubs/index.ts` with `registerStubs(lua, flavor)`
9. Manual overrides live in `src/lua/api/base/` and `src/lua/api/<flavor>/` — imported after stubs, last writer wins; override files use `import type` from stub for compile-time orphan detection

See `docs/plan/013_api_stub_autogen.md` for full architecture.

**Effort:** M

---

## WoW type system generation

**Status:** ⬜ Deferred (after M13)

**Problem:** Generated stubs use `unknown` for all params and returns. Custom implementations in `src/lua/api/` have no type guidance for what shapes to return. A TypeScript interface per Blizzard Structure table would give implementors correct field names and catch shape errors at compile time.

**Plan:** Extend `gen-api-stubs.ts` to also emit `src/lua/api-stubs/types.ts` with a TypeScript interface per `Type = "Structure"` table. Upgrade stub param/return types from `unknown` to the generated types. Structs referencing other structs get proper imports.

**Effort:** M

---

## Event name constants generation

**Status:** ⬜ Deferred (after M13)

**Problem:** Event name strings (e.g. `"TEXTURE_ATLASES_UPDATED"`) are scattered as literals through Lua and TypeScript. Documentation files include typed event definitions. A generated constants file would catch typos and enable IDE autocomplete.

**Plan:** Extend `gen-api-stubs.ts` to emit `src/lua/api-stubs/_Events.ts` with a typed const object mapping event name to its literal string type (or a union of all known event names). Currently events are emitted as comments in namespace files only.

**Effort:** S

---

## Enum stub generation

**Status:** ⬜ Deferred (after M13)

**Problem:** The global `Enum` table (`Enum.TitleIconVersion`, `Enum.AddOnEnableState`, etc.) is populated by the C layer. Currently `Enum = {}` is empty. When Blizzard Lua compares against `Enum.X` constants it gets nil — usually harmless but can cause wrong-branch execution.

**Plan:** Extend `gen-api-stubs.ts` to parse `Type = "Enumeration"` tables in the Documentation files and emit `src/lua/api-stubs/_Enum.ts` with numeric constant stubs. Register via `registerStubs` alongside the function stubs.

**Effort:** S
