# ADR 009 — Lua Version Target and Transpilation

**Status:** Accepted  
**Date:** 2026-05-29

## Context

WoW has run Lua 5.1 internally since approximately WoW version 2 and has never updated the runtime. All three live flavors (Retail, Classic, Classic Era) use the same Lua 5.1 embed. Blizzard has no documented plans to update it. For practical purposes, Lua 5.1 is the permanent, fixed target for WoW addon code.

This raises a tooling question that arose during the design of M5 (Lua Sandbox + 5.1 Shim): is a Babel-style transpiler — compiling newer Lua (5.2–5.5) down to Lua 5.1 — a worthwhile tool in the WoW addon ecosystem?

## Options Considered

### Lua 5.x → 5.1 transpiler (Babel analogue)

The idea: let addon authors write Lua 5.3 or 5.4, then transpile down to 5.1 for shipping.

**Why it doesn't work well:**

Babel succeeds because JavaScript's cross-version changes are mostly syntactic. The semantics (object model, prototype chain, closure rules) are stable. ES2022 → ES5 is a syntactic transform with well-understood edge cases.

Lua's cross-version changes are frequently _model_ changes, not syntax sugar:

- **5.2:** Removed `setfenv`/`getfenv` entirely; replaced the global environment model with an explicit `_ENV` upvalue. This cannot be backported — the semantics in 5.1 and 5.2+ are genuinely different.
- **5.3:** True integer subtype (integers and floats are distinct at runtime). Bitwise operators are syntax sugar over the integer type. Backporting the syntax is easy; backporting the integer semantics faithfully is not.
- **5.4:** `<close>` (to-be-closed variables / RAII). Cannot be transpiled without invasive wrapping of every function body.

The syntax-only pieces (`goto`, `&`/`|`/`//` operators) are transpilable but aren't ergonomic enough to justify a build step. WoW addon code already uses `bit.band()` etc. by convention; no one is waiting for native bitwise syntax.

The Babel analogy also assumes a _distribution problem_: multiple runtimes with different version support that you cannot control. WoW provides a single, known runtime. There is nothing to smooth over.

**Verdict:** Poor work-to-value ratio. Easy parts (bitwise syntax) aren't worth a pipeline. Hard parts (environment model, integers, `<close>`) cannot be transpiled correctly. No one ships this tool; the ecosystem has not tried.

### TypeScriptToLua (TSTL)

TypeScriptToLua compiles TypeScript to Lua, targeting a configurable Lua version (5.1 supported). It is actively maintained and widely used in the WoW addon community. It provides TypeScript's type system, modern syntax, and first-class IDE support, and emits standard Lua 5.1 compatible output.

This is the existing community answer to "I want modern ergonomics → WoW Lua." It solves a real problem (TypeScript DX for a dynamically typed language) rather than a theoretical one (Lua 5.4 syntax on a Lua 5.1 runtime).

**Verdict:** Out of scope for Scryer itself to ship or wrap — TSTL is a pre-compilation step the addon author performs before their Lua/XML land in the workspace. Scryer consumes the Lua output, which is standard Lua 5.1. However, TSTL integration has implications worth investigating: see [backlog entry](../plan/backlog.md#typescripttolua-integration-investigation).

## Decision

- **Lua 5.1 is the permanent target.** All sandbox shim work, API stubs, and version documentation are anchored to 5.1. Do not plan for 5.2+ features.
- **No transpiler.** Scryer does not ship or require a Lua-to-Lua transpiler. Addon authors who want modern syntax use TypeScriptToLua (a pre-compilation step external to Scryer).
- **TSTL output is standard Lua 5.1.** Scryer's sandbox should run TSTL-compiled addons without special handling. Whether there are TSTL runtime library patterns that require attention is an open investigation.

## Consequences

- The shim surface in M5 is bounded and known (see [ADR 008](008_lua_interpreter.md)). No new categories of compat work arise from newer Lua versions.
- Scryer's documentation should not suggest or describe a Lua transpilation workflow.
- If TSTL investigation (backlog) surfaces integration work, it goes into M5 or M8 scope as a separate item.

## References

- [ADR 008 — Lua Interpreter Choice](008_lua_interpreter.md)
- [ADR 001 — Language Stack](001_language_stack.md)
- [Backlog: TypeScriptToLua integration investigation](../plan/backlog.md#typescripttolua-integration-investigation)
