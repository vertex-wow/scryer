# ADR 001 — Language Stack

**Status:** Accepted  
**Date:** 2026-05-24

## Context

We needed to choose the primary implementation language for the VSCode extension. The hard constraints were:

- VSCode extensions **must** have a TypeScript/JavaScript entry point — the extension host API is TS-first
- The webview is always HTML/CSS/JS (Chromium)
- The heaviest work is: XML parsing, Lua 5.1 execution, BLP/TGA asset decoding, hot-reload
- Primary contributor is vibe-coding (AI writes most code, human directs and troubleshoots)
- Supply chain attack concern: npm and PyPI both have known poisoning histories

## Options Considered

### Pure TypeScript (in-process extension host)

Everything runs in the extension host Node process. No separate subprocess.

### TypeScript shell + Go subprocess (standalone CLI)

Extension host is a thin TypeScript wrapper; a Go binary handles parsing, Lua execution, and asset decoding over a JSON-RPC stdio channel.

### TypeScript shell + Python subprocess

Same split as Go, but Python handles the heavy lifting.

### Lua as host language

Build the runtime engine in Lua, leveraging WoW addon authors' familiarity with the language.

## Decision

**Pure TypeScript, in-process extension host.**

Python was eliminated early: worse supply chain than npm, no Lua 5.1 advantage, and BLP is proprietary so Pillow doesn't help with the primary asset format.

Go was seriously considered, primarily because `gopher-lua` is a native Lua 5.1 implementation (WoW uses Lua 5.1, and all JS options are 5.3/5.4). However, several factors shifted the decision back to TypeScript:

1. **The `vscode-wow-api` annotation corpus (519 files, 9,132 function definitions) bounds the Lua 5.1 shim problem.** What appeared to be an open-ended risk ("API surface effectively unbounded") is a finite, machine-readable checklist. The shim for `setfenv`/`getfenv` and the `bit` library is enumerable, not exploratory.

2. **Hot-reload performance is not the binding constraint.** The preview tool is batch, single-addon, save-triggered — not a continuous, whole-workspace, always-on service like an LSP. The largest addon in the corpus (DBM-Core) is 2.4 MB of Lua. A realistic reload cycle (100–150 ms debounce + parse + Lua init + render diff) lands at 200–400 ms either way — already 5–25× faster than WoW's `/reload` floor of 2–5 s. Go's speed advantage is real but immaterial for this specific workload.

3. **A Go CLI subprocess adds per-reload IPC latency** via the stdio process boundary — a direct cost to the headline feature.

4. **True cross-compilation with CGo (needed to bind PUC-Rio Lua 5.1 C) is expensive:** four per-platform binaries, a C toolchain per OS, macOS notarization. Disproportionate for a dev tool. `gopher-lua` (pure Go, no CGo) avoids this but is a tree-walking interpreter — not materially faster than wasmoon for this workload.

5. **TypeScript matches the user's existing knowledge**, the VSCode-native model, and the existing scaffold. Two-language debug (can't single-step from TS into Go) is an ongoing friction cost for a vibe-coding workflow.

Lua as a host language was rejected because WoW addon authors know the _WoW sandbox_ (CreateFrame, events, mixins), not general-purpose Lua tooling (LuaRocks, LuaSocket, image decode). The host ecosystem is weak, especially for BLP decoding. The contributor-accessibility goal is better served by the Neovim model (see below).

## Architecture Adopted

**TypeScript in-process extension host + Neovim model for API stubs:**

- Extension host (TypeScript): VSCode API, commands, webview lifecycle, file watching, settings, XML/TOC parsing, asset decoding, hot-reload orchestration
- Lua VM (fengari or wasmoon + finite 5.1 shim): runs in the extension host Node process — no subprocess boundary
- **WoW API stubs authored in Lua**, loaded into the sandbox at startup — addon authors contribute API coverage in the exact dialect they know, without touching host code
- Webview (HTML/CSS/JS): pure DOM renderer fed JSON from the host

## Consequences

- Must implement a Lua 5.1 compatibility shim for `setfenv`/`getfenv`, `unpack`, `bit` library, and numeric edge cases. The `vscode-wow-api` annotation corpus (`compat.lua`, `bit.lua`, `basic.lua`) defines exactly what is needed — it is finite and enumerable. `setfenv`/`getfenv` are **known work with a known solution** (debug library shim) — see [ADR 008](008_lua_interpreter.md).
- **CRITICAL — degree-based trig:** WoW's `cos`/`sin`/`atan2` global aliases take **degrees**, not radians. `compat.lua` wraps standard math functions with `* math.pi / 180` conversions. Providing standard radian trig under these names causes silent rendering errors. This must be part of the shim, not an afterthought.
- Only the `Core/` annotation tree from `vscode-wow-api` is in scope (`Core/Lua/`, `Core/Widget/`, `Core/Events/`). `FrameXML/` contains stubs for Blizzard's own addon code (UIParent, ActionBars, etc.) — out of scope for our runtime.
- **Lua VM choice resolved: wasmoon.** See [ADR 008](008_lua_interpreter.md) for the full decision including the fallback ladder (Fengari → self-compiled Lua 5.1 WASM) and the rationale for why the 5.3 vs 5.4 version delta is irrelevant for WoW addon compatibility.
- If profiling ever reveals a genuine bottleneck, the surgical fix is moving that one hot path to a Node worker thread or WASM module — not rewriting in Go.
- CGo/PUC-Rio Lua 5.1 binding remains an option if all JS-based interpreter options hit unresolvable 5.1 compat roadblocks, but the cross-platform binary distribution cost must be weighed against the marginal fidelity gain.

## References

- [plan/000_overview.md](../plan/000_overview.md)
- [plan/004_lua_runtime.md](../plan/004_lua_runtime.md)
- [reference/wow_xml_schema.md](../reference/wow_xml_schema.md)
- `_reference/vscode-wow-api/` (MIT, 519 annotation files)
