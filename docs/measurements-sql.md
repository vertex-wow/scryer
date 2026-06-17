# CSV/SQLite Benchmark Reference

Covers all measurements related to the community listfile, CSV filtering, and
SQLite index construction. Two benchmark questions are documented here:

- **Q1b** — How fast can we filter `listfile.csv` to Interface-only entries? (2026-05-28)
- **Q1c** — How fast can we build a SQLite point-lookup index from the pre-filtered file? (2026-06-17)

Q1b results informed the `grep -F` decision for `ensureFilteredListfile()`. Q1c results
inform the [Listfile fast index](plan/todo.md#listfile-fast-index-in-process--post-rustydemon-era)
implementation choice.

---

## Tool Inventory

All tools tested, with versions, sources, and how they were obtained.

### System tools (pre-installed)

| Tool             | Version | Notes                                                                                                                      |
| ---------------- | ------- | -------------------------------------------------------------------------------------------------------------------------- |
| `grep` (`ugrep`) | 7.5.0   | Ubuntu 24.04 system grep is `ugrep`; `-F` fixed-string flag behaves identically                                            |
| `sed`            | system  | GNU sed; not competitive for this workload                                                                                 |
| `awk`            | system  | GNU awk; always the slowest option — avoid                                                                                 |
| `sqlite3` CLI    | 3.45.1  | Ubuntu 24.04 system SQLite. Does **not** include CSV virtual table extension (requires custom build from `ext/misc/csv.c`) |

### Node.js packages (devDependencies)

All installed via `pnpm add -D`. Production deps: none — all of these are dev/bench-only.

| Package          | Version        | Install                                            | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------- | -------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node:sqlite`    | built-in       | Node ≥ 22.5                                        | `DatabaseSync` (synchronous API). No install. SQLite 3.53.0. Requires `{ allowExtension: true }` constructor option to load `.so` extensions.                                                                                                                                                                                                                                                                                                                           |
| `better-sqlite3` | 12.10.0        | `pnpm add -D better-sqlite3 @types/better-sqlite3` | Native binding (C++). Add `"better-sqlite3"` to `pnpm.onlyBuiltDependencies` in `package.json`. SQLite 3.53.1. After install, rebuild with Node 24: `node /path/to/node-gyp/bin/node-gyp.js rebuild` from the package dir if version mismatch occurs — the default `node-gyp` shim may use a different Node version.                                                                                                                                                    |
| `@libsql/client` | 0.17.3         | `pnpm add -D @libsql/client`                       | Turso embedded SQLite, async HTTP-style API. Significantly slower for local bulk ops. No native binding, no `onlyBuiltDependencies` entry needed.                                                                                                                                                                                                                                                                                                                       |
| `sqlite-xsv`     | 0.2.1-alpha.13 | `pnpm add -D sqlite-xsv`                           | SQLite loadable extension for reading CSV files as virtual tables. Source: [asg017/sqlite-xsv](https://github.com/asg017/sqlite-xsv). The platform-specific `.so` is at `node_modules/.pnpm/sqlite-xsv-linux-x64@0.2.1-alpha.13/node_modules/sqlite-xsv-linux-x64/xsv0.so`. The `xsv_reader` table-valued function panics in this version; use only the virtual table module (`CREATE VIRTUAL TABLE … USING xsv(…)`). Columns: `c1` (id), `c2` (path) with `header=no`. |

### External binaries (`external/` directory)

Files in `external/` are **manually downloaded and manually extracted** — they are not
managed by pnpm or cargo. They are gitignored. Re-download from the URLs below if missing.

#### `external/sqlean/` — sqlean SQLite extensions

Downloaded from: [github.com/nalgeon/sqlean/releases](https://github.com/nalgeon/sqlean/releases)

Filename: `sqlean-linux-x64.zip` (downloaded 2026-06-17; no version number in zip name —
check the release tag on the GitHub releases page to pin a version).

To install:

1. Download `sqlean-linux-x64.zip` from the Releases page.
2. Extract to `external/sqlean/`: `unzip sqlean-linux-x64.zip -d external/sqlean/`

Extension used in benchmarks:

| File     | Purpose                                                  | Virtual table syntax                                                                                    |
| -------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `vsv.so` | Reads delimiter-separated files as SQLite virtual tables | `CREATE VIRTUAL TABLE t USING vsv(filename='…', fsep=';', header=no)` — columns: `c0` (id), `c1` (path) |

Other extensions in the zip (`crypto.so`, `regexp.so`, etc.) are unused in this project.

#### `external/qsv/` — qsv CSV toolkit

Downloaded from: [qsv.dathere.com](https://qsv.dathere.com) → GitHub releases at
[github.com/dathere/qsv/releases](https://github.com/dathere/qsv/releases)

Version: **21.1.0** — `qsv-21.1.0-x86_64-unknown-linux-gnu.zip` (prebuilt PGO binary)

To install:

1. Download `qsv-*-x86_64-unknown-linux-gnu.zip` from the Releases page.
2. Extract to `external/qsv/`: `unzip qsv-21.1.0-x86_64-unknown-linux-gnu.zip -d external/qsv/`
3. The `qsv` binary is at `external/qsv/qsv`.

Key subcommand: `qsv to sqlite <db> <csv>` — reads CSV (auto-detects semicolon delimiter),
writes directly to SQLite. Requires a header row in the CSV. Names the table after the
input filename. Does **not** create an index — add one separately via `node:sqlite` or CLI.

#### `external/qsv/qsvdp`, `qsvlite`, etc.

The zip includes multiple variants: `qsvdp` (datapusher+), `qsvlite` (no heavy features),
`qsvp` (with polars), etc. Use `qsv` (the full build) for benchmarking.

### Cargo-installed CLI tools

| Tool  | Version | Install                      | Notes                                                                                                                                                                                                                                                                                 |
| ----- | ------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `xan` | 0.59.0  | `cargo install xan --locked` | Installed to `~/.cargo/bin/xan`. medialab CSV toolkit. **No native SQLite output** — `xan to` supports html/json/xlsx/ndjson/npy/txt but not sqlite. Useful for CSV filtering/transformation, not for index build. Source: [github.com/medialab/xan](https://github.com/medialab/xan) |

### Deprecated tools (tested in Q1b, no longer recommended)

| Tool               | Status                                     | Successor                                |
| ------------------ | ------------------------------------------ | ---------------------------------------- |
| `xsv` (BurntSushi) | Deprecated — maintainer recommends qsv/xan | `qsv` (dathere fork) or `xan` (medialab) |

---

## Q1b — Listfile filtering speed (2026-05-28)

**Question:** How fast can we filter `listfile.csv` (2.17M rows, 140 MB) to Interface-only entries?

**Answer:** `grep -F` (subprocess from Node) wins at ~110–118 ms. SQLite extension approaches land at ~790–930 ms — 7–9× behind grep. `awk` is always the wrong choice.

**Context:** The full community listfile has 2,172,924 entries. Only 169,862 (7.8%) start with
`interface/`. This is a one-time filter run on download; result cached as `listfile-templates.csv`.

**Environment:** AMD Ryzen 5 3600X (12 cores), WSL2, Node v24.16.0. Warm OS page cache.
2 warmup + 5 measured runs. All approaches measured from within a running Node.js process
(subprocess spawn cost included).

**Script:** `dev/bench-listfile-filter.mjs` — run with:

```bash
node dev/bench-listfile-filter.mjs \
  .wow-cache/retail/source/.casc-meta/listfile.csv
```

### Stream/shell approaches (no SQLite)

| Approach                                      | Mean       | ±Stddev | vs fastest |
| --------------------------------------------- | ---------- | ------- | ---------- |
| `grep -F` (subprocess)                        | **110 ms** | ±2 ms   | 1.00×      |
| `grep` (subprocess)                           | 118 ms     | ±4 ms   | 1.08×      |
| `sed` (subprocess)                            | 290 ms     | ±5 ms   | 2.64×      |
| Node.js stream + byte scan (1BRC-style)       | 547 ms     | ±22 ms  | 4.98×      |
| Node.js worker threads (1BRC-style, 12 cores) | 599 ms     | ±49 ms  | 5.45×      |
| Node.js Buffer scan (in-process)              | 1 022 ms   | ±39 ms  | 9.30×      |
| Node.js `readFileSync` + split (in-process)   | 1 038 ms   | ±89 ms  | 9.44×      |
| Node.js readline stream (in-process)          | 1 050 ms   | ±26 ms  | 9.55×      |
| `awk` (subprocess)                            | 3 219 ms   | ±160 ms | 29.29×     |

### SQLite INSERT+SELECT approaches (full 2.17M row input)

Note: all Node SQLite approaches below received the **unfiltered** 2.17M row file, while the
`sqlite3 CLI` approach used a `grep` pipe. This is a methodology gap — see Q1c for the
apples-to-apples comparison on the 169K pre-filtered file.

| Approach                                              | Mean       | ±Stddev | vs `grep -F` | Notes                                            |
| ----------------------------------------------------- | ---------- | ------- | ------------ | ------------------------------------------------ |
| `sqlite3 CLI` `.import "\|grep pipe"` + SELECT        | **244 ms** | ±4 ms   | 2.22×        | grep does filtering; SQLite structures output    |
| `node:sqlite` stream+bytes + tx INSERT + SELECT       | 903 ms     | ±37 ms  | 8.21×        | built-in, no deps, manual BEGIN/COMMIT           |
| `better-sqlite3` stream+bytes + tx INSERT + SELECT    | 926 ms     | ±35 ms  | 8.42×        | native binding, `.transaction()` helper          |
| `node:sqlite` readFileSync + tx INSERT + SELECT       | 971 ms     | ±39 ms  | 8.83×        |                                                  |
| `better-sqlite3` readFileSync + tx INSERT + SELECT    | 1 037 ms   | ±71 ms  | 9.43×        |                                                  |
| `sqlite3 CLI` `.import` all 2.17M rows + SELECT WHERE | 2 272 ms   | ±158 ms | 20.66×       | pays full import cost before filtering           |
| `@libsql/client` stream+bytes + batch + SELECT        | 4 665 ms   | ±290 ms | 42.41×       | async HTTP-like API; poor fit for local bulk ops |

### SQLite CSV extension approaches (virtual table over full 2.17M row file)

| Approach                                            | Mean     | ±Stddev | vs `grep -F` | Notes                           |
| --------------------------------------------------- | -------- | ------- | ------------ | ------------------------------- |
| `sqlite-xsv` + node:sqlite — file direct, LIKE      | 790 ms   | ±30 ms  | 7.5×         |                                 |
| `sqlean vsv` + better-sqlite3 — file direct, LIKE   | 795 ms   | ±18 ms  | 7.6×         |                                 |
| `sqlean vsv` + node:sqlite — file direct, LIKE      | 811 ms   | ±41 ms  | 7.7×         |                                 |
| `sqlean vsv` + node:sqlite — file direct, substr    | 863 ms   | ±10 ms  | 8.2×         |                                 |
| `sqlite-xsv` + node:sqlite — file direct, substr    | 885 ms   | ±12 ms  | 8.4×         |                                 |
| `sqlite-xsv` + node:sqlite — Node reads, INSERT     | 896 ms   | ±35 ms  | 8.5×         | stream+bytes filter then INSERT |
| `sqlean vsv` + better-sqlite3 — file direct, substr | 923 ms   | ±22 ms  | 8.8×         |                                 |
| `sqlite-xsv` + better-sqlite3 — file direct, LIKE   | 929 ms   | ±75 ms  | 8.8×         |                                 |
| `sqlite-xsv` + better-sqlite3 — file direct, substr | 948 ms   | ±58 ms  | 9.0×         |                                 |
| `sqlite-xsv` + better-sqlite3 — Node reads, INSERT  | 1 086 ms | ±40 ms  | 10.3×        |                                 |

### CSV-aware CLI tools (spawned from Node)

| Approach                        | Mean   | ±Stddev | vs `grep -F` | Notes                              |
| ------------------------------- | ------ | ------- | ------------ | ---------------------------------- |
| `grep -F` (reference)           | 118 ms | ±17 ms  | 1.00×        | row-level, preserves `;` delimiter |
| `xan search -s 1 '^interface/'` | 152 ms | ±6 ms   | 1.28×        | cell-aware, comma output ⚠         |
| `xan grep ';interface/'`        | 166 ms | ±7 ms   | 1.40×        | row-level, preserves `;` delimiter |
| `xsv search -s 2 '^interface/'` | 257 ms | ±13 ms  | 2.17×        | cell-aware, comma output ⚠         |
| `qsv search -s 2 '^interface/'` | 312 ms | ±13 ms  | 2.63×        | cell-aware, comma output ⚠         |

⚠ Cell-aware tools (`xan search`, `xsv`, `qsv search`) normalize output to
comma-delimited regardless of input — not directly usable for our `;`-delimited format
without post-processing. Row-level scanners (`xan grep`, `grep`) preserve the original
delimiter.

### Notes

- **1BRC-style stream + byte scan** (raw `Buffer.indexOf`, no `readline`/`String.split`) is
  the fastest pure-Node in-process approach. Worker threads do not help — the bottleneck is
  I/O, not CPU; 12-core parallelism is eaten by spawn and concatenation overhead.
- **SQLite CSV virtual table** (`CREATE VIRTUAL TABLE t USING csv(…)`) is not compiled into
  the Ubuntu system `sqlite3` 3.45.1, `node:sqlite` (3.53.0), `better-sqlite3` (3.49.2),
  `node-sqlite3-wasm` (3.53.1), or `@libsql/client`. Requires a custom SQLite build from
  `ext/misc/csv.c`. The `sqlite-xsv` and `sqlean vsv` loadable extensions fill this gap.
- **SQLite adds overhead for one-shot filter** because every approach pays both read/parse
  cost and INSERT cost. SQLite is the right choice for the point-lookup index use case
  (Q1c) — a completely different access pattern.
- **`@libsql/client`** is designed for the Turso cloud product; its async batch API has
  significant overhead for local bulk operations. Not competitive for this workload.
- **Decision:** Use `grep -F` (subprocess) in `ensureFilteredListfile()`. When only
  `atlas-gen.ts` consumes the listfile (post-rustydemon-cli), 1BRC-style stream+bytes
  is the zero-subprocess alternative.

---

## Q1c — Listfile SQLite index: build cost + lookup (2026-06-17)

**Question:** What is the fastest way to (a) build a write-once SQLite index from
`listfile-templates.csv` (169K pre-filtered rows), and (b) do point lookups by FileDataID?

**Context:** The Q1b SQLite approaches all received the full 2.17M row file, while
`sqlite3 CLI` used a grep pipe. This made the Node SQLite libraries look ~4× slower than
they actually are. This benchmark repeats Phase 1 with all libraries receiving the same
pre-filtered 169K row input for a fair comparison. Phase 2 measures point lookup speed —
never previously benchmarked.

**Environment:** AMD Ryzen 5 3600X (12 cores), WSL2, Node v24.16.0. Warm OS page cache.
2 warmup + 5 measured runs.

**Script:** `dev/bench-listfile-index.mjs` — run with:

```bash
node dev/bench-listfile-index.mjs \
  .wow-cache/retail/source/.casc-meta/listfile-templates.csv
```

`listfile-templates.csv` must already exist (pre-filtered from the full listfile). If
absent, generate it first:

```bash
grep -F -i ";interface/" \
  .wow-cache/retail/source/.casc-meta/listfile.csv \
  > .wow-cache/retail/source/.casc-meta/listfile-templates.csv
```

### Phase 1 — build cost (write-once, 169K rows)

All approaches receive `listfile-templates.csv` as input. DB written to `/tmp/listfile-bench.db`,
deleted and recreated between runs.

**JS row-by-row INSERT approaches** — CSV parsed in JS, rows inserted via prepared statement:

| Approach                           | Mean     | ±Stddev | vs fastest |
| ---------------------------------- | -------- | ------- | ---------- |
| `node:sqlite` readFileSync + tx    | 409 ms   | ±15 ms  | 1.94×      |
| `node:sqlite` stream + tx          | 537 ms   | ±23 ms  | 2.55×      |
| `better-sqlite3` readFileSync + tx | 458 ms   | ±5 ms   | 2.18×      |
| `better-sqlite3` stream + tx       | 527 ms   | ±12 ms  | 2.50×      |
| `@libsql/client` batch (1K chunks) | 7 604 ms | ±530 ms | 36.14×     |

**Native CSV extension approaches** — CSV read entirely in C via loadable extension, single
`INSERT INTO listfile SELECT … FROM vtable` with no JS row iteration:

| Approach                                          | Mean       | ±Stddev   | vs fastest |
| ------------------------------------------------- | ---------- | --------- | ---------- |
| **`better-sqlite3` + `sqlean vsv` INSERT SELECT** | **210 ms** | **±3 ms** | **1.00×**  |
| `better-sqlite3` + `sqlite-xsv` INSERT SELECT     | 225 ms     | ±6 ms     | 1.07×      |
| `node:sqlite` + `sqlean vsv` INSERT SELECT        | 253 ms     | ±19 ms    | 1.20×      |
| `node:sqlite` + `sqlite-xsv` INSERT SELECT        | 266 ms     | ±22 ms    | 1.26×      |

**CLI subprocess approaches:**

| Approach                | Mean   | ±Stddev | vs fastest | Notes                                                    |
| ----------------------- | ------ | ------- | ---------- | -------------------------------------------------------- |
| `sqlite3 CLI` `.import` | 369 ms | ±5 ms   | 1.75×      | Subprocess spawn included                                |
| `qsv to sqlite`         | 385 ms | ±22 ms  | 1.83×      | Subprocess spawn included; requires header row prepended |

**Key finding:** Native CSV extension approaches are ~2× faster than row-by-row JS INSERT.
The `sqlite3 CLI` and `qsv` CLI approaches are no longer the fastest — subprocess overhead
dominates when the input is already small (169K rows vs 2.17M).

### Phase 2 — point lookup speed (16K FileDataID queries, warm DB)

DB built once from Phase 1 with `node:sqlite` + readFileSync + tx. Sample of 16,000
FileDataIDs drawn evenly from the input file. All lookups via prepared statement
`SELECT path FROM listfile WHERE id = ?`.

| Approach                           | Mean       | ±Stddev   | vs fastest | Per lookup   |
| ---------------------------------- | ---------- | --------- | ---------- | ------------ |
| **`better-sqlite3` prepared ×16K** | **168 ms** | **±5 ms** | **1.00×**  | **0.011 ms** |
| `node:sqlite` prepared ×16K        | 175 ms     | ±12 ms    | 1.04×      | 0.011 ms     |
| `@libsql/client` batch ×16K        | 451 ms     | ±10 ms    | 2.69×      | 0.028 ms     |

`better-sqlite3` and `node:sqlite` are statistically tied at 0.011 ms/lookup.
`@libsql/client` batch (all 16K in one round-trip) is 2.7× slower.

### Notes

- **Extension approaches require the `.so` to be present at runtime.** `sqlite-xsv` is in
  `node_modules` (npm devDep). `vsv.so` is in `external/sqlean/` (manually downloaded — see
  Tool Inventory above). Both are skipped gracefully if absent.
- **`qsv to sqlite` requires a header row.** The script creates `/tmp/listfile-bench-input.csv`
  by prepending `id;path` to the input file. This cost is outside the timed loop.
- **`xan` has no SQLite output.** `xan to` supports html/json/xlsx but not sqlite. Excluded
  from the benchmark — it has no native path and would only be useful as a preprocessor piped
  into `sqlite3 CLI`, adding subprocess overhead with no benefit over `grep -F | sqlite3`.
- **`@libsql/client` is definitively out** for both build (36×) and lookup (2.7×).
- **Implementation recommendation:** Use `node:sqlite` + `vsv.so` `INSERT SELECT` for the
  build step — 253 ms (1.2× vs best), zero new npm production deps, `vsv.so` already in
  `external/sqlean/`. For lookups, `node:sqlite` prepared statement is statistically tied
  with `better-sqlite3` (0.011 ms/lookup). No new production dependency needed.

---

## Benchmark script reference

### `dev/bench-listfile-filter.mjs` (Q1b — filtering)

```bash
node dev/bench-listfile-filter.mjs \
  .wow-cache/retail/source/.casc-meta/listfile.csv \
  [runs] [warmup]
# defaults: 5 runs, 2 warmup
```

Covers: `grep -F`, `grep`, `node stream+bytes (1BRC-style)`, `node readFileSync+split`,
`node readline`. SQLite approaches from Q1b were a one-off session (not committed as a
permanent script); results are recorded in the tables above.

### `dev/bench-listfile-index.mjs` (Q1c — index build + lookup)

```bash
node dev/bench-listfile-index.mjs \
  .wow-cache/retail/source/.casc-meta/listfile-templates.csv \
  [runs] [warmup]
# defaults: 5 runs, 2 warmup
```

Covers all Phase 1 and Phase 2 approaches. Requires `node_modules` installed
(`pnpm install`) and `external/sqlean/vsv.so` present for the vsv approaches.
`qsv` at `external/qsv/qsv` is used if present; missing tools are skipped with a notice.

Outputs Phase 1 and Phase 2 tables to stdout. No output file — re-run to reproduce.
