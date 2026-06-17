# ADR 014 — SQLite Library Choices (Node and Rust)

**Status:** Accepted  
**Date:** 2026-06-17

## Context

The listfile fast index feature requires a write-once, read-many SQLite database mapping FileDataIDs to
paths. Two integration points need a SQLite library: the Node.js extension host (builds and queries the
index) and the Rust asset server (may query the index during extraction). Full benchmark data lives in
[docs/measurements-sql.md](../measurements-sql.md).

The options were evaluated along two dimensions:

- **Build cost** — time to load 169K pre-filtered rows from `listfile-templates.csv` into a SQLite DB
- **Lookup cost** — point-query latency for `SELECT path FROM listfile WHERE id = ?`

A separate question: whether to ship a standalone `sqlite3` CLI binary (another per-platform artifact,
similar to the Rust asset server) instead of linking SQLite into each integration point.

## Options Considered

### Node.js side

**`node:sqlite`** (built-in since Node 22.5, SQLite 3.53.0) — `DatabaseSync` synchronous API. No install,
no native build step, no production dependency. Build cost 253 ms with `vsv.so` INSERT SELECT
(1.2× vs best overall). Lookup: 0.011 ms/query (16K-query batch, prepared statement).

**`better-sqlite3`** (native C++ binding, SQLite 3.53.1) — fastest build option overall (210 ms with `vsv.so`
INSERT SELECT). Lookup: 0.011 ms/query — statistically tied with `node:sqlite`. Requires a native binding
as a production dependency and an `onlyBuiltDependencies` / `ignoredBuiltDependencies` entry in `package.json`.

**`@libsql/client`** (Turso embedded SQLite, async HTTP-style API) — definitively ruled out: 36× slower
on build (7,604 ms), 2.7× slower on lookups. Designed for Turso cloud, not local bulk operations.

**`sqlite-xsv`** (loadable extension for CSV virtual tables, npm devDep) — useful as a build accelerator
(keeps the CSV parse in C), but only if paired with `node:sqlite` or `better-sqlite3`. Not a standalone
choice; bundled in `node_modules` as a devDep for bench use.

### Rust side

**`rusqlite` with `features = ["bundled"]`** — standard Rust SQLite binding. Statically links SQLite
into the binary; no separate runtime artifact. Already present in `scryer-asset-server` Cargo.toml
without the `bundled` feature (which caused a system SQLite dependency). `bundled` makes it self-contained.

**Standalone `sqlite3` CLI** — ship a per-platform binary alongside the Rust server. Benchmark for the
169K pre-filtered file: 369 ms (subprocess included) vs 253 ms for in-process `node:sqlite + vsv.so`.
Subprocess overhead dominates at small input sizes; the CLI was only competitive at the full 2.17M row
file where the per-row cost dominated. Adds a third per-platform artifact with no performance upside.

## Decision

**Node side:** `node:sqlite` (built-in) + `vsv.so` (`external/sqlean/`) for the build step. Prepared
statements via `node:sqlite` for lookups. No new production dependencies.

**Rust side:** `rusqlite` with `features = ["bundled"]` — SQLite statically linked into the asset server
binary. No separate sqlite3 CLI to ship or maintain.

**Standalone sqlite3 CLI:** Rejected. Slower than in-process for the 169K file, adds distribution
complexity, and both integration points already have a self-contained SQLite via `node:sqlite` (built-in)
and `rusqlite bundled` (static link).

## Removed Dependencies

The following packages were installed during benchmarking and are removed now that the decision is made:

| Package                 | Reason removed                                                                 |
| ----------------------- | ------------------------------------------------------------------------------ |
| `better-sqlite3`        | 43 ms build advantage not worth native prod dep; `node:sqlite` tied on lookups |
| `@types/better-sqlite3` | Types for removed package                                                      |
| `@libsql/client`        | 36× build, 2.7× lookup — definitively uncompetitive                            |
| `sqlite-xsv`            | Bench-only; `vsv.so` (sqlean) chosen over it for the build step                |

`better-sqlite3` is also removed from `pnpm.ignoredBuiltDependencies`.

## Consequences

- `vsv.so` from `external/sqlean/` must be present at runtime for the index build step. It is already
  in `external/` (gitignored, manually downloaded — see Tool Inventory in `docs/measurements-sql.md`).
  Absent at build time, the build step falls back to the row-by-row JS INSERT path (~410 ms vs 253 ms).
- `rusqlite bundled` compiles SQLite from source during `cargo build`. This adds a few seconds to
  cold Rust builds. Release builds are unaffected after the first compile (Cargo cache).
- `node:sqlite` requires Node ≥ 22.5. `package.json` already pins `"node": ">=24"`, so this is satisfied.

## References

- [docs/measurements-sql.md](../measurements-sql.md) — full benchmark data (Q1b filtering, Q1c index build + lookup)
- [plan/todo.md — Listfile fast index](../plan/todo.md#listfile-fast-index-in-process--post-rustydemon-era)
