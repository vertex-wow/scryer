# Scryer — Project Overview

## Vision and End State

A VSCode extension that renders WoW addon UI frames (`.xml` + `.lua`) directly in the editor, evolving from a static frame previewer into a full interactive addon development runtime — a headless WoW UI sandbox with hot-reload and automated testing that real WoW cannot offer.

End state: open any addon folder, pick a version target (Mainline/MoP Classic/Classic Era), get a live webview of the addon's frames driven by actual Lua execution of its code, reloading on save, with a headless test runner for CI.

## Milestone Table

| #   | Name                   | Status                   | Description                                             | Effort | Depends on |
| --- | ---------------------- | ------------------------ | ------------------------------------------------------- | ------ | ---------- |
| 1   | WoW XML Parser         | ✅ Complete (2026-05-24) | Parse `.xml` → typed IR; resolve templates/inheritance  | M      | —          |
| 2   | Static XML Preview     | ⬜ Next                  | Render IR in a DOM webview with WoW anchor layout       | M      | 1          |
| 3   | Asset Pipeline         | ⬜ Pending               | BLP→PNG conversion, path/atlas resolution, cache        | M      | 2          |
| 4   | Lua Shim Runtime       | ⬜ Pending               | Sandboxed Lua exec + WoW API stubs + frame object model | M      | 1, 2       |
| 5   | Multi-Version Targets  | ⬜ Pending               | Selectable Classic/Cata/Retail API profiles             | S–M    | 4          |
| 6   | Hot Reload _(stretch)_ | ⬜ Pending               | Re-parse/re-run on save with minimal repaint            | M      | 2, 4       |
| 7   | Test Suite _(stretch)_ | ⬜ Pending               | Headless addon test runner + reporter                   | M      | 4          |

## Recommended Tech Stack

| Layer           | Choice                   | Rationale                                                      |
| --------------- | ------------------------ | -------------------------------------------------------------- |
| Language        | TypeScript               | VSCode extension API is TS-first; existing repo tooling intent |
| Bundler         | esbuild                  | Fast; two-entry build (host + webview)                         |
| XML parser      | fast-xml-parser          | Zero native deps; preserves attribute order; configurable      |
| Lua interpreter | wasmoon (primary)        | WASM Lua 5.4; good Node perf; + 5.1 compat shim                |
| Lua fallback    | fengari                  | Pure JS Lua 5.3; runs in webview sandbox if needed             |
| UI renderer     | DOM (M2), Canvas (later) | DOM = easy debug/inspect; Canvas = atlas slicing fidelity      |
| BLP decoder     | node-blp (pure JS)       | Zero external binary; CLI blp2png as optional fallback         |

**Lua version note:** WoW uses Lua 5.1 internally (confirmed by `.vscode/extensions.json` pinning `ketho.wow-api` + workspace `Lua.runtime.version: "Lua 5.1"`). Neither wasmoon (5.4) nor fengari (5.3) is a perfect match. A 5.1 compatibility shim (`unpack`, `setfenv`/`getfenv`, `math.mod`, etc.) is required.

## Architecture (ASCII)

```
        VSCode Extension Host (Node)                        Webview (sandboxed)
  +----------------------------------------+          +-----------------------------+
  |  Activation / Commands                 |          |  Renderer (DOM divs)        |
  |  Workspace + target config (M5)        |          |   - anchor/layout engine    |
  |                                        |          |   - strata/layer z-order    |
  |  Parser (M1) -----> IR/AST             | <=msg=>  |   - placeholder textures    |
  |  Include/TOC resolver                  |  JSON    |   - FontString (webfonts)   |
  |                                        |          |                             |
  |  Lua Runtime (M4)                      |          |  Input -> events (OnClick)  |
  |   - wasmoon / fengari                  |          +-----------------------------+
  |   - WoW API sandbox + frame model      |                      ^
  |   - mixins, C_Timer, events            |           asset:// (PNG from cache)
  |                                        |                      |
  |  Asset Pipeline (M3)                   |          +-----------------------------+
  |   - BLP->PNG, atlas, cache             | -------> |  .scryer-cache/ (PNG)       |
  +----------------------------------------+          +-----------------------------+
              |                  ^
    reads (read-only)          file save -> Hot Reload (M6)
              v                  |
    WOW_DIR install / _live/Addons    Headless runner (M7, no webview)
```

## Cross-Cutting Concerns

- **Multi-version runtime (M5):** single IR format with a swappable API profile per target version; TOC interface-version field validates against the selected target.
- **Asset pipeline (M3):** BLP is proprietary; conversion and caching are shared by both the webview renderer and the headless test runner.
- **Security sandbox:** webview CSP locks origins; Lua sandbox removes `io`/`os.execute`; all filesystem reads restricted to user-configured `WOW_DIR` and workspace paths; no network requests.
- **Relationship to `ketho.wow-api`:** `ketho.wow-api` (already recommended in `.vscode/extensions.json`) is an _editor-time_ extension (LuaLS completions). We are a _runtime_ extension (execution + preview). The two are complementary — recommend installing both via an `extensionPack` entry. We reuse ketho's _data corpus_ (not its live LuaLS settings): `flavor.ts` for per-flavor API availability, `event.ts` for typed event payloads, `globalapi.ts` for the C\_\* namespace list, and `compat.lua`/`bit.lua`/`basic.lua` as the canonical WoW Lua shim spec. Only the `Core/` annotation tree is in scope — `FrameXML/` Blizzard addon stubs are not needed.

## Stretch Goals

- **Hot reload (M6):** the headline DX win — live-reload on save is impossible in real WoW.
- **Test suite (M7):** headless, CI-friendly addon testing from within VSCode Test Explorer.
- Future: Canvas/WebGL renderer, animation groups, SavedVariables emulation, frame inspector/devtools, multi-monitor UI simulation.

## Known Risks and Open Questions

| Risk                                                 | Severity   | Mitigation                                                                                                                              |
| ---------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Lua 5.1 vs 5.3/5.4 semantic gaps                     | Medium     | Mirror `compat.lua`/`bit.lua`/`basic.lua` shim from ketho (finite, enumerated); residual risk isolated to `setfenv`/`getfenv` emulation |
| BLP decoding coverage in JS                          | Medium     | Pure-JS primary; CLI blp2png fallback; log unsupported variants                                                                         |
| Retail assets live in CASC (not loose files)         | Medium     | Target an extracted-assets dir; document WoW.export/CASCExplorer                                                                        |
| WoW API surface gaps                                 | Low–Medium | `flavor.ts` (7218 entries) + `globalapi.ts` (261 C\_\* namespaces) bound the surface; safe-default nil-return stubs for the rest        |
| Blizzard template corpus (DefaultPanelTemplate etc.) | Medium     | Lazy-load from `_reference/wow-ui-source`; warn when missing                                                                            |
| Atlas manifest acquisition per game build            | Medium     | JSON manifest generated from extracted data; version-tag it                                                                             |
| Rotating Classic-progression flavor                  | Low        | Pin a versioned copy of `flavor.ts`; update when Classic season advances                                                                |

**Open questions:**

- Custom editor provider vs side WebviewPanel — which gives better UX first?
