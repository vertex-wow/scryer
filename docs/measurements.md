# Scryer Benchmarking Guide

## Table of Contents

1. [Purpose and Scope](#1-purpose-and-scope)
2. [Cost Model — The Pipeline Stages](#2-cost-model--the-pipeline-stages)
3. [Open Questions and Decision Answers](#3-open-questions-and-decision-answers)
4. [The Benchmark Suite](#4-the-benchmark-suite)
5. [Running Reproducibly](#5-running-reproducibly)
6. [Regression Detection — Pre/Post Commit](#6-regression-detection--prepost-commit)
7. [Tooling Inventory](#7-tooling-inventory)
8. [Long-Term Roadmap](#8-long-term-roadmap)
9. [References](#9-references)

---

## 1. Purpose and Scope

Benchmarks in this project exist to answer **concrete architectural decisions**, not to pursue performance for its own sake. Each benchmark either answers a question from the list below or measures a regression against a prior answer.

### The questions we are benchmarking to answer

**Loading strategy:**

- Is "opening" CASC storage expensive? (If so: batch heavily; never make small one-off requests.)
- Is per-file extraction from CASC cheap once open? (If so: stream on demand; batch less aggressively.)
- Is extracting all Blizzard addon data upfront (XML + TOC + Lua) fast enough to do at activation?
- Should we preload assets while monitoring open editor files, or only on demand?
- Should we walk workspace files at startup to preload assets referenced in XML?
- At what texture size does eager preload become a poor trade-off vs on-demand decode?

**Optimization levers:**

- In the decode pipeline, which step dominates: BLP DXT decompression, PNG zlib compression, or disk write?
- Is the cache-hit path (serving already-decoded PNG from `.wow-cache/`) effectively free?
- Does path resolution overhead matter at scale (e.g. walking a workspace with hundreds of XML files)?
- Is there write contention in the cache dir under high concurrency?

**Long-term architectural:**

- When the in-process JS CASC reader is built, is it faster, slower, or equivalent to `rustydemon-cli`? (This becomes the evidence in that ADR.)
- If the JS reader is significantly slower, is the trade-off (no external binary, no listfile) still worth it for the target audience?

### What this is not

- Not a CI gate (yet — see §8).
- Not cross-machine comparable. Results are valid only on the machine that produced them, at the Node version and corpus size recorded in the JSON metadata.
- Not a server load test. Tools like k6 and wrk2 are irrelevant here; there is no server or request queue.

---

## 2. Cost Model — The Pipeline Stages

The table below maps each pipeline stage to its code location, cost driver, and current understanding. **Bold** rows are the ones that matter most to the decision questions in §1.

| Stage                  | Module                                | Cost driver                             | Bottleneck?                                 | Notes                                                                                                   |
| ---------------------- | ------------------------------------- | --------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **CASC open**          | `rustydemon-cli` (subprocess)         | **CPU: listfile parse (2.17M entries)** | **Yes for per-file use — batch everything** | rustydemon-cli warm: ~25–29 s. casc-extractor warm: ~15.7 s (1.84× faster). Per-file still ≥ 13 s/call. |
| CASC per-file extract  | `rustydemon-cli`                      | BLTE decompress + disk write            | No — fast once open                         | 3,650 files in 5.2 s with j=8 (0.001 s/file); 2,982 texture files in 6.1 s                              |
| Addon file read        | `fs.promises.readFile`                | Pure I/O                                | No                                          | Confirmed: 0–18 ms for N=100 files                                                                      |
| **BLP DXT decompress** | **`js-blp` `getPixels(0)`**           | **CPU: DXT block decode**               | **Yes — dominant for large textures**       | Rock (513 KB): 3 908 ms. Marble (44 KB): 79 ms. Buttons: 0.2–2.3 ms.                                    |
| PNG zlib compress      | `pngjs` `PNG.sync.write`              | CPU: zlib at default level              | Secondary                                   | Rock: 88 ms (2% of total). Marble: 6 ms. Buttons: < 1.5 ms.                                             |
| Cache write            | `writeCached`, `fs.writeFileSync`     | I/O                                     | No                                          | Rock: 1.3 ms. Trivial.                                                                                  |
| Cache hit              | `getCachedPath`, `fs.accessSync`      | I/O: single stat                        | No                                          | Confirmed: ~2 ms for 11 cached files; effectively free.                                                 |
| Path resolution        | `resolveTexturePath`, `fs.accessSync` | I/O: probes × candidates                | No                                          | Confirmed: 0.07–0.16 ms for 11 paths cold; 0.00–0.01 ms warm (14–90× memoization speedup).              |

### Initial baseline (2026-05-27, AMD Ryzen 5 3600X 12-core, 16 GB RAM, Node v24.16.0, WSL2, corpus hash `6eb95a2c`)

These numbers come from the first run of `pnpm bench`. They are the **starting baseline** for regression detection. Corpus: 11 BLP fixtures, 228 addon files.

**Texture decode + cache write (N simultaneous, `Promise.all`):**

| N        | Median   | CV   | Note                           |
| -------- | -------- | ---- | ------------------------------ |
| 1        | 5 ms     | 0.37 | Small button, fast             |
| 5        | 5 ms     | 0.09 | All buttons                    |
| 10       | 37 ms    | 0.09 | Adds `ui-background-rock.blp`  |
| 11 (all) | 4 162 ms | 0.04 | Rock dominates; corpus ceiling |

**Per-file split timers (single pass, sequential):**

| File                                  | Size   | t_read | t_decode | t_encode | t_write | Total        |
| ------------------------------------- | ------ | ------ | -------- | -------- | ------- | ------------ |
| buttons/ui-checkbox-check.blp         | 3 KB   | 0.0 ms | 0.2 ms   | 0.2 ms   | 0.1 ms  | **0.5 ms**   |
| buttons/ui-silver-button-up.blp       | 7 KB   | 0.0 ms | 1.1 ms   | 0.5 ms   | 0.1 ms  | **1.7 ms**   |
| framegeneral/ui-background-marble.blp | 44 KB  | 0.0 ms | 78.5 ms  | 6.3 ms   | 0.2 ms  | **85 ms**    |
| framegeneral/ui-background-rock.blp   | 513 KB | 0.1 ms | 3 908 ms | 88 ms    | 1.3 ms  | **3 998 ms** |

**The bottleneck is `js-blp` DXT decompression (`t_decode`), not PNG compression.** Rock's decode is 44× more expensive than its encode. Lowering PNG zlib level would save only 2% of total cost; a faster BLP decoder would save 98%.

**Addon file reads:**

| N   | Median | Note                                   |
| --- | ------ | -------------------------------------- |
| 100 | 18 ms  | 228 files available — not a bottleneck |

**Cache-hit (serve pre-decoded PNG from `.wow-cache`):**

| N (all capped at 11) | Median | Note                                                  |
| -------------------- | ------ | ----------------------------------------------------- |
| 1–100                | ~2 ms  | Effectively free; preload is "pay once, then instant" |

**Path resolution:**

| N   | Cold median | Warm median | Speedup |
| --- | ----------- | ----------- | ------- |
| 10  | 0.16 ms     | 0.01 ms     | 16×     |

Not a bottleneck at any realistic scale.

**Key implication:** Blizzard addon text files can be walked and read freely at startup. The only cost that matters is BLP decode time, and that is dominated by a handful of large background/environment textures. The preload strategy should treat button/icon textures (< 10 KB) as free to eager-load and large background textures (> 100 KB) as candidates for lazy or background-priority loading.

### Blizzard Interface texture corpus measurements (2026-05-27)

**Context:** The Blizzard registry (SharedXML + FrameXML) references textures in the main `Interface/` tree (not inside `Interface/AddOns/`). This section records what it costs to extract and convert those textures.

**Texture count (SharedXML + FrameXML registry):**

- Templates loaded: **355**
- Unique texture paths: **102** (spanning 23 distinct parent directories)
- Registry scan: 124 ms (warm cache)
- Scope: this covers _only_ the template corpus. A full-addon manifest (all 315 Blizzard addons) would require a proper parser-backed manifest generator — see [backlog: Blizzard texture manifest builder](plan/backlog.md).

**Texture extraction — batch approach (single CASC open, brace-glob, j=8):**

| Phase                          | Count                 | Time                                                 | Disk                   |
| ------------------------------ | --------------------- | ---------------------------------------------------- | ---------------------- |
| Directories extracted          | 23 dirs → 2,982 files | 6.1 s (`rustydemon-cli` internal) + ~29.8 s listfile | —                      |
| BLP files extracted            | 2,683                 | —                                                    | **451.6 MB** (raw BLP) |
| 102 referenced BLPs (of those) | 102                   | —                                                    | **2.7 MB**             |

Note: extracting 23 parent directories retrieves 2,982 files total because the tool extracts all files in each directory, not just the 102 specifically referenced. The 102 referenced BLPs themselves total 2.7 MB.

**BLP size distribution (2,683 BLPs in extracted Interface/ tree):**

| Statistic | Value    |
| --------- | -------- |
| Total     | 451.6 MB |
| Mean      | 172.4 KB |
| p50       | 22.5 KB  |
| p95       | 1,025 KB |
| Max       | ~16 MB   |

**BLP→PNG conversion (single-threaded, `js-blp` + `pngjs`):**

| Corpus                          | Files | Decode avg | Encode avg | Decode:Encode | Total single-threaded | Est. ×8 workers |
| ------------------------------- | ----- | ---------- | ---------- | ------------- | --------------------- | --------------- |
| 102 template BLPs (2.7 MB)      | 102   | 101.6 ms   | 2.8 ms     | **36×**       | ~11 s                 | ~1 s            |
| Full Interface/ tree (451.6 MB) | 2,683 | ~95–118 ms | ~6 ms      | **15–18×**    | ~270–330 s            | ~34–42 s        |

PNG output is **smaller** than the BLP input (DXT is an efficient compression): 102 BLPs → ~1.3 MB PNG (0.50× expansion); full corpus → ~90 MB PNG estimated.

**Key findings:**

- Blizzard addon DXT decompression: **36× slower than PNG encoding** for the template set (consistent with Q5)
- Extracting all 102 template textures: **~1 s with 8 workers** — cheap enough to preload at activation
- Full Interface/ tree (2,683 BLPs): ~34–42 s with 8 workers — on-demand or background only
- Per-file extraction (current `extract.sh` loop): **47 minutes** of overhead for 102 files — see Q1

---

### User addon workspace texture corpus measurements (2026-05-27)

**Context:** The `scryer.userAddonPreload` `"workspace"` tier must pre-warm textures for all WoW XML files in the active VS Code workspace. This section records the texture corpus found in a representative heavily-loaded workspace: 153 installed user addons from `_live/Addons/` (the retail WoW AddOns directory), scanned via `pnpm collect-textures`.

**Scan results:**

- Addons scanned: **153**
- Unique texture paths found: **182** (1.2 refs/addon on average)
- Scan time: **27 s** (note: slow because `_live/Addons` is a symlink to a Windows NTFS mount via WSL2; native filesystem would be much faster)

**Resolution breakdown:**

| Category           | Count   | Source                                         | Notes                                                     |
| ------------------ | ------- | ---------------------------------------------- | --------------------------------------------------------- |
| Blizzard UI BLPs   | 88      | `.wow-cache/` (previously extracted from CASC) | `Interface/Buttons/`, `Interface/AchievementFrame/`, etc. |
| Addon-bundled BLPs | 13      | Loose files in `_live/Addons/`                 | Small addon-specific graphics                             |
| Addon-bundled TGAs | 37      | Loose files in `_live/Addons/`                 | Unimplemented — would need TGA decoder                    |
| Addon-bundled PNGs | 15      | Loose files in `_live/Addons/`                 | Already web-ready; serve directly                         |
| Unavailable        | 29      | —                                              | Locale-specific files, addons not on this machine         |
| **Total resolved** | **153** |                                                |                                                           |

**Size distribution — Blizzard UI BLPs (88 files, from CASC):**

| Statistic | Value                             |
| --------- | --------------------------------- |
| Total     | 1.3 MB                            |
| Mean      | 15.3 KB                           |
| p50       | 2.5 KB                            |
| p95       | 22.5 KB                           |
| Max       | 513 KB (`ui-background-rock.blp`) |

**Size distribution — addon-bundled textures (65 files, loose):**

| Statistic | Value   |
| --------- | ------- |
| Total     | 2.0 MB  |
| Mean      | 30.8 KB |
| p50       | 6.2 KB  |
| p95       | 90.3 KB |
| Max       | 684 KB  |

**Combined (153 resolved textures):** ~3.3 MB raw total. p50 across the full set is ~3–4 KB — the corpus is overwhelmingly small icons and buttons, with a handful of medium-sized UI panels and one large background outlier.

**Extrapolated decode time (using Q5 benchmarks):**

| Scenario                        | Est. decode time | Notes                                           |
| ------------------------------- | ---------------- | ----------------------------------------------- |
| All at p50 (~3 KB)              | < 500 ms         | 153 × < 2 ms, 8 workers; icons and buttons only |
| Including p95 textures (~90 KB) | ~1–2 s           | A few larger UI panels add tens of ms each      |
| With rock.blp outlier (513 KB)  | ~5–6 s           | That one file alone is ~4 s (Q5); rest < 2 s    |
| PNGs (15 files)                 | ~0 ms            | Served directly, no decode                      |
| TGAs (37 files)                 | unimplemented    | Would add ~50–200 ms once TGA decode lands      |

**Key findings:**

- A heavily-loaded 153-addon workspace has only **~180 texture refs** — workspace scan is smaller than expected.
- The **per-addon average is ~1.2 textures**; a typical 1–5 addon developer workspace has ~5–30 refs.
- At ~5–30 refs and p50 ~3 KB each: total workspace preload is **< 100 ms** in the common case — effectively free.
- The only significant cost is outlier backgrounds (> 200 KB). One such file adds ~2–4 s.
- TGA textures (37 of 65 addon-bundled = 57%) are the largest unknown; they are currently unimplemented and would be served as placeholders.
- The 29 unavailable textures are locale-specific variants or from addons not installed locally — these will always be a small miss rate for any given machine.

---

## 3. Open Questions and Decision Answers

Each question is answered with current evidence or flagged as "pending" with the specific benchmark that will answer it.

---

### Q1: Is CASC "open" expensive? (Batching vs streaming)

**Answer: Yes — listfile parsing is CPU-bound and costs ~25–33 s per invocation. Batch everything; per-file invocation is completely impractical for any non-trivial file set.**

**Measured (2026-05-27):**

| Invocation                    | Listfile load (CPU) | `rustydemon-cli` internal | Wall clock |
| ----------------------------- | ------------------- | ------------------------- | ---------- |
| First call (cold page cache)  | 32.7 s              | —                         | ~33 s      |
| Second call (warm page cache) | 25.3 s              | —                         | ~25 s      |

The listfile CSV has **2,172,924 entries** (cached at `<cacheRoot>/downloads/listfile.csv`). Even with the file fully in OS page cache, the text parsing + in-memory hashing takes ~25 s CPU. This cost is paid on every `rustydemon-cli` process launch.

**Consequence:** Per-file extraction for 102 textures ≈ 102 × 28 s ≈ **47 minutes** of overhead alone — completely impractical. All extraction must be done in a single batched call per CASC open. The `dev/extract.sh --paths-file` loop (which spawns one process per path) must be replaced with a batch strategy.

**The fix:** Use `rustydemon-cli -p "{dir1,dir2,...}/**"` brace-glob syntax to extract multiple directories in a single CASC open. The tool supports brace expansion in the `-p` argument (confirmed); it does not support multiple `-p` flags or a `--paths-file` option.

**Implication for architecture:** Any extraction feature (on-demand or batch) must batch all its paths into a single `rustydemon-cli` call. The CASC Asset Service (see [M15](plan/015_casc_asset_service.md)) would eliminate this listfile-parse overhead entirely.

---

### Q1c: How does casc-extractor compare to rustydemon-cli?

**Answer: casc-extractor is ~1.8–2.2× faster than rustydemon-cli across all scenarios. The architectural conclusion (batch everything; never per-file) remains the same — the bottleneck is listfile parse regardless of tool.**

**Context:** `casc-extractor v0.2.0` (x86_64 Linux binary) was benchmarked head-to-head against `rustydemon-cli` using the same methodology as Q1b: all timings measured from a running Node.js process via `performance.now()`, 1 warmup + 3 measured runs, warm OS page cache.

**Script:** `dev/bench-casc-comparison.mjs` — run with `node dev/bench-casc-comparison.mjs [runs] [warmup]`.

**Key API difference:** casc-extractor's `--filter` matches against listfile paths (all lowercase), whereas rustydemon-cli's `-p` matches against the WoW install tree (mixed case). This is a source-of-truth difference: casc-extractor uses the community listfile as authoritative, so filter patterns must be lowercase to match.

**Measured (2026-05-31, AMD Ryzen 5 3600X 12-core, Node v24.16.0, WSL2, warm page cache, 1 warmup + 3 runs):**

| Scenario                                           | Tool           | Mean       | ±Stddev | CV   | vs other         |
| -------------------------------------------------- | -------------- | ---------- | ------- | ---- | ---------------- |
| CASC open (list / dry-run, no writes)              | casc-extractor | **15.7 s** | ±0.1 s  | 0.4% | **1.84× faster** |
| CASC open (list / dry-run, no writes)              | rustydemon-cli | **28.9 s** | ±0.4 s  | 1.5% | 1.84× slower     |
| Bulk extract — `Interface/AddOns/**` (8 threads)   | casc-extractor | **15.3 s** | ±0.7 s  | 4.8% | **2.13× faster** |
| Bulk extract — `Interface/AddOns/**` (8 threads)   | rustydemon-cli | **32.7 s** | ±2.4 s  | 7.5% | 2.13× slower     |
| Per-file — single file by path (listfile required) | casc-extractor | **13.5 s** | ±0.2 s  | 1.3% | **2.17× faster** |
| Per-file — single file by path (listfile required) | rustydemon-cli | **29.4 s** | ±0.2 s  | 0.7% | 2.17× slower     |

**Notes:**

- casc-extractor's bulk extract (15.3 s) is essentially the same as its open-only (15.7 s), indicating that extracting 3,650 files with 8 threads adds no measurable wall-clock cost beyond the CASC open — the I/O pipeline is fully hidden by the indexing phase. rustydemon-cli shows ~3.8 s of visible extraction overhead on top of its open cost.
- Per-file cost is still dominated entirely by CASC open. For 102 textures: casc-extractor ≈ 102 × 13.5 s ≈ **23 minutes**; rustydemon-cli ≈ 102 × 29.4 s ≈ **50 minutes**. Both are completely impractical. The batch-everything conclusion is unchanged.
- casc-extractor was not measured cold (page cache evicted) in this run. The existing cold measurement for rustydemon-cli (32.7 s) gives a reference; casc-extractor's first observed call at machine start was ~16 s, suggesting a much smaller cold-vs-warm gap, but this was not rigorously controlled.
- rustydemon-cli's higher CV on bulk extract (7.5% vs 4.8%) reflects the fact that it spends more real time writing files; I/O jitter on the WSL2 `/tmp` ext4 filesystem contributes proportionally more variance.
- **Both tools were invoked as Node.js child processes** (`child_process.spawn`), matching the real extension context. Spawn overhead (~50 ms) is included but negligible against multi-second operations.

**Critical limitation: casc-extractor does not support compound glob patterns.**

casc-extractor's `--filter` flag accepts only a single pattern per invocation. Neither `{a/**,b/**}` brace expansion nor `--filter a/** --filter b/**` (repeated flags) works — the former silently matches 0 files, the latter is rejected with an error. rustydemon-cli supports brace expansion natively.

The current `extractRetailBulk` in `src/assets/extract-core.ts` batches all globs into one brace-glob call (e.g. `{Interface/Buttons/**,Interface/Common/**,...,Fonts/**}` for `type === "all"`). A casc-extractor migration would require one subprocess per glob pattern:

| Scenario                                 | rustydemon-cli   | casc-extractor (per-glob)                |
| ---------------------------------------- | ---------------- | ---------------------------------------- |
| Single glob (e.g. `interface/addons/**`) | ~29 s            | ~15 s — faster                           |
| 10-glob batch (`type === "all"`)         | ~29 s (one call) | ~135 s (10 × ~13.5 s) — **~4.6× slower** |

**Conclusion:** casc-extractor is faster per-open but cannot compete with rustydemon-cli for multi-glob batches under the current architecture. It becomes viable only if the extension is restructured to issue a single broad glob (e.g. `interface/**` — but that extracts ~169K files vs ~3,700 needed) or if upstream adds multi-filter support.

---

### Q1b: How fast can we pre-filter listfile.csv to Interface-only entries?

**Answer: `grep -F` (subprocess from Node) wins at ~110–118 ms. Among CLI tools, `xan search` (cell-aware, comma output) is the closest Rust-native competitor at ~152 ms, followed by `xan grep` (row-level, preserves delimiter) at ~166 ms. SQLite CSV virtual table extensions (sqlite-xsv, sqlean vsv) land at ~790–930 ms — faster than the naive `@libsql/client` path but 7–9× behind grep. `awk` is always the wrong choice.**

**Context:** The community listfile has 2,172,924 entries (140 MB). Only 169,862 (7.8%) start with `interface/`. Pre-filtering at download time reduces the file `rustydemon-cli` must parse by ~12×, and eliminates parse overhead entirely for our own JS consumers (`atlas-gen.ts`). This is a one-time operation per listfile download.

**Note on CSV virtual table:** SQLite's CSV virtual table (`CREATE VIRTUAL TABLE t USING csv(...)`) would allow a single-pass filter with no intermediate INSERT step. It is not compiled into the Ubuntu system sqlite3 3.45.1, node:sqlite (3.53.0), better-sqlite3 (3.49.2), node-sqlite3-wasm (3.53.1), or @libsql/client. It requires a custom SQLite build or a loadable extension compiled from `ext/misc/csv.c`.

**Measured (2026-05-28):** All approaches measured from within a running Node.js process (subprocess approaches use `child_process.spawn`; in-process approaches run directly). Warm OS page cache, 2 warmup + 5 measured runs, output written to disk, AMD Ryzen 5 3600X (12 cores), WSL2.

**Stream/shell approaches (no SQLite):**

| Approach                                      | Mean       | Stddev  | vs fastest |
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

**SQLite/LibSQL approaches (INSERT all matching rows, then SELECT):**

| Approach                                                        | Mean       | Stddev  | vs grep -F | Notes                                                      |
| --------------------------------------------------------------- | ---------- | ------- | ---------- | ---------------------------------------------------------- |
| `sqlite3 CLI` `.import "\|grep pipe"` + SELECT                  | **244 ms** | ±4 ms   | 2.22×      | grep does the filtering; SQLite only structures output     |
| `node:sqlite` stream+bytes + tx INSERT + SELECT                 | 903 ms     | ±37 ms  | 8.21×      | built-in, no deps, manual BEGIN/COMMIT                     |
| `better-sqlite3` stream+bytes + tx INSERT + SELECT              | 926 ms     | ±35 ms  | 8.42×      | native binding, `.transaction()` helper                    |
| `node:sqlite` readFileSync + tx INSERT + SELECT                 | 971 ms     | ±39 ms  | 8.83×      |                                                            |
| `better-sqlite3` readFileSync + tx INSERT + SELECT              | 1 037 ms   | ±71 ms  | 9.43×      |                                                            |
| `sqlite3 CLI` `.import` all 2.17M rows + SELECT WHERE           | 2 272 ms   | ±158 ms | 20.66×     | pays full import cost before filtering                     |
| `@libsql/client` (Turso embedded) stream+bytes + batch + SELECT | 4 665 ms   | ±290 ms | 42.41×     | async HTTP-like client design; poor fit for local bulk ops |

**SQLite CSV extension approaches (sqlite-xsv + sqlean vsv, virtual table pointing at file on disk):**

| Approach                                                   | Mean     | Stddev | vs grep -F | Notes                           |
| ---------------------------------------------------------- | -------- | ------ | ---------- | ------------------------------- |
| `sqlite-xsv` + node:sqlite — file direct, LIKE             | 790 ms   | ±30 ms | 7.5×       |                                 |
| `sqlean vsv` + better-sqlite3 — file direct, LIKE          | 795 ms   | ±18 ms | 7.6×       |                                 |
| `sqlean vsv` + node:sqlite — file direct, LIKE             | 811 ms   | ±41 ms | 7.7×       |                                 |
| `sqlean vsv` + node:sqlite — file direct, substr           | 863 ms   | ±10 ms | 8.2×       |                                 |
| `sqlite-xsv` + node:sqlite — file direct, substr           | 885 ms   | ±12 ms | 8.4×       |                                 |
| `sqlite-xsv` + node:sqlite — Node reads, INSERT, SELECT    | 896 ms   | ±35 ms | 8.5×       | stream+bytes filter then INSERT |
| `sqlean vsv` + better-sqlite3 — file direct, substr        | 923 ms   | ±22 ms | 8.8×       |                                 |
| `sqlite-xsv` + better-sqlite3 — file direct, LIKE          | 929 ms   | ±75 ms | 8.8×       |                                 |
| `sqlite-xsv` + better-sqlite3 — file direct, substr        | 948 ms   | ±58 ms | 9.0×       |                                 |
| `sqlite-xsv` + better-sqlite3 — Node reads, INSERT, SELECT | 1 086 ms | ±40 ms | 10.3×      |                                 |

**CSV-aware CLI tools (cell-aware filtering, spawned from Node):**

| Approach                          | Mean   | Stddev | vs grep -F | Notes                              |
| --------------------------------- | ------ | ------ | ---------- | ---------------------------------- |
| `grep -F` (subprocess, reference) | 118 ms | ±17 ms | 1.00×      | row-level, preserves `;` delimiter |
| `xan search -s 1 '^interface/'`   | 152 ms | ±6 ms  | 1.28×      | cell-aware, comma output ⚠         |
| `xan grep ';interface/'`          | 166 ms | ±7 ms  | 1.40×      | row-level, preserves `;` delimiter |
| `xsv search -s 2 '^interface/'`   | 257 ms | ±13 ms | 2.17×      | cell-aware, comma output ⚠         |
| `qsv search -s 2 '^interface/'`   | 312 ms | ±13 ms | 2.63×      | cell-aware, comma output ⚠         |

**Notes:**

- All approaches produce identical output (169,862 rows). `grep`/`sed` preserve source CRLF; Node.js and SQLite approaches normalize to LF.
- The **1BRC-style stream + byte scan** (raw `Buffer.indexOf`, no `readline`/`String.split`) is the fastest pure-Node in-process approach — see `dev/bench-listfile-filter.mjs` for the preserved reference implementation. Worker threads do not help — the bottleneck is I/O, not CPU; 12-core parallelism is eaten by spawn and concatenation overhead.
- **SQLite CSV virtual table extensions** (`sqlite-xsv` npm package, `sqlean vsv` at `external/sqlean-linux-x64/vsv.so`): both allow SQLite to read the CSV directly with no intermediate INSERT step. Neither significantly outperforms the Node-reads+INSERT pattern — the bottleneck is vtable row-crossing overhead regardless. LIKE wins over `substr()` because SQLite has a prefix short-circuit that exits early on non-matches. The `sqlite-xsv` `xsv_reader` table-valued function panics in v0.2.1-alpha.13; only the virtual table module is usable.
- **CSV-aware CLI tools:** `xan search`, `xsv search`, and `qsv search` normalize output to comma-delimited regardless of input delimiter — not directly usable for our `;`-delimited format without post-processing. `xan grep` and `grep` are row-level scanners that preserve the original delimiter and are directly usable. `xsv` (BurntSushi) is the original; its maintainer now recommends `qsv` (dathere) and `xan` (medialab). `cargo install qsv` fails on Rust 1.95.0; installed from prebuilt binary.
- **SQLite adds overhead for the one-shot filter use case** because every approach pays both a read/parse cost and an INSERT cost. SQLite becomes the right choice for the [Listfile fast index](plan/backlog.md#listfile-fast-index-in-process--post-rustydemon-era) use case: store the 169K rows once, then do sub-millisecond point lookups by FileDataID. That is a completely different access pattern.
- **`@libsql/client` (Turso)** is designed for the cloud product; its async batch API has significant overhead for local in-memory bulk operations. Not competitive for this workload.
- **Decision:** for the short-term `rustydemon-cli` era, use `grep -F` spawned from `ensureListfile()`. When the in-process CASC reader lands and only `atlas-gen.ts` consumes the listfile, 1BRC-style stream+bytes is the in-process alternative with no subprocess dependency.

---

### Q2: Is it worth extracting all Blizzard addon data upfront?

**Answer: Yes for the text files (XML/Lua/TOC) — but the one-time CASC overhead (~5 s extraction + ~30 s listfile parsing) means it should be done lazily at first preview and cached, not at every activation.**

**Measured (2026-05-27):** Full `Interface/AddOns` extraction — all Blizzard\_\* addons (315 folders, 9,103 files matched, 3,650 extracted — the rest are Classic/TBC/Wrath files not installed on the retail CASC):

| Phase                           | Time      | Note                                      |
| ------------------------------- | --------- | ----------------------------------------- |
| `rustydemon-cli` internal (j=8) | **5.2 s** | Parallel extraction; includes CASC mount  |
| Listfile load (first call)      | ~32.7 s   | CPU-bound CSV parse; one-time per process |
| Total wall clock                | ~43.9 s   | Dominated by listfile, not extraction     |
| Disk space (all 3,650 files)    | **41 MB** | Mostly Lua/XML/TOC; trivial               |

**Separate numbers for Blizzard_SharedXML + Blizzard_FrameXML only:**

|           | SharedXML | FrameXML | Combined |
| --------- | --------- | -------- | -------- |
| Files     | 228       | 130      | 358      |
| Disk size | 2.1 MB    | 1.7 MB   | 3.8 MB   |

The extraction itself (5.2 s) is acceptable as a one-time cost at first preview. The listfile overhead (25–33 s) makes repeated invocations expensive (see Q1). Strategy: extract once, write a completion marker, and skip on subsequent activations.

---

### Q3: Where should we preload, and how aggressively?

**Answer: Small textures (< ~50 KB) — eager-preload freely. Large background textures (> ~100 KB) — decode in a background worker or on-demand with a progress indicator.**

Per Q5, the bottleneck is BLP DXT decode in `js-blp`. The cliff is stark:

- 9 button textures (3–7 KB each): ~30 ms total — preload the entire button corpus at activation
- `ui-background-marble.blp` (44 KB): 85 ms — acceptable for eager preload if in background
- `ui-background-rock.blp` (513 KB): **4 000 ms** — blocking preload is unacceptable; must be background/deferred

**Proposed preload tiers (derived from benchmark):**

| Tier      | Condition                             | Strategy                                                |
| --------- | ------------------------------------- | ------------------------------------------------------- |
| Instant   | File in `.wow-cache/` already decoded | Serve immediately (< 2 ms, Q4 confirmed)                |
| Eager     | BLP file < 50 KB                      | Decode at activation in background thread               |
| Deferred  | BLP file 50–200 KB                    | Decode when first referenced in an open XML file        |
| On-demand | BLP file > 200 KB                     | Decode only when the webview requests it, show progress |

**Note:** These thresholds are based on the current `js-blp` decode performance. If the decoder is replaced with a faster WASM implementation (see Q5 optimization options), all tiers would shift toward "eager" as cost drops.

---

### Q4: Is the cache-hit path effectively free?

**Answer: Yes — confirmed by `measureCacheHit` benchmark.**

Cache-hit cost: ~2 ms for all 11 available BLP files simultaneously (stat + file read). Single-file cache-hit is sub-millisecond. Preloading is definitively "pay once at first open, then instant on every subsequent render."

**Implication:** The workspace startup preload (see [Backlog: Preload Workspace Textures](plan/backlog.md#preload-workspace-textures-at-startup)) is the right call. Pay the BLP decode cost once at activation, cache to `.wow-cache/`, and every subsequent preview renders instantly. The only question remaining is whether to decode on-demand (lazy) or in-background (eager). The benchmark confirms that once in cache, there is no reason to re-decode.

---

### Q5: Which step in the decode pipeline is the bottleneck — DXT decompress, PNG compress, or disk write?

**Answer: BLP DXT decompression (`js-blp` `getPixels`) — confirmed by `texture-split` benchmark.**

The initial planning assumption was wrong. Per the split timers:

| Step                | Rock (513 KB) | Marble (44 KB) | Button (3–7 KB) |
| ------------------- | ------------- | -------------- | --------------- |
| `fs.readFileSync`   | 0.1 ms        | 0.0 ms         | 0.0 ms          |
| `BLPFile.getPixels` | **3 908 ms**  | **79 ms**      | **0.2–2.3 ms**  |
| `PNG.sync.write`    | 88 ms         | 6 ms           | 0.2–1.5 ms      |
| `fs.writeFileSync`  | 1.3 ms        | 0.2 ms         | 0.1 ms          |

For the rock background, `getPixels` is 44× more expensive than `PNG.sync.write`. Lowering zlib level would save only 2% of total cost.

**Likely cause:** `ui-background-rock.blp` may be an uncompressed BLP variant (BLP type 1 raw RGBA, not DXT), causing `js-blp` to copy ~4 MB of pixel data through JavaScript in a tight loop rather than using the more optimized DXT block-decode path. The 513 KB compressed → slow decode suggests the file is not DXT-compressed at all. Confirmation requires inspecting the BLP header type byte.

**The optimization lever is:** a faster BLP decoder. Options:

1. **Inspect the BLP type byte:** if rock is raw RGBA (not DXT), the `js-blp` codepath for that type may be particularly unoptimized. A direct `Buffer.copy` from the raw data would be far faster.
2. **WebAssembly BLP decoder:** port the DXT decompression to a WASM module (or find one) — WASM SIMD can decompress DXT blocks ~10–100× faster than JavaScript.
3. **Skip PNG entirely for the cache:** write raw RGBA to `.wow-cache/` and have the webview accept a `data:image/raw` or `image/webp` (encode RGBA→WebP in Node, which has native bindings). This removes both the `PNG.sync.write` step and the cost scales only with the BLP decode.
4. **Use Node Worker Threads for BLP decode:** the current `Promise.all` over `blpToPng` serializes all decodes (JS is single-threaded). A Worker thread pool would parallelize across cores, letting N=11 files (including rock) run simultaneously rather than sequentially.

---

### Q6: Does path resolution overhead matter at scale?

**Answer: No — confirmed by `measureResolution` benchmark. Cold ~0.01–0.02 ms/path; warm < 0.001 ms/path.**

Cold (memo cleared): 0.14–0.16 ms for 11 paths = ~0.014 ms/path. For 4 000 paths (200 XML files × 20 textures): ~56 ms cold. After the first resolution pass, all subsequent lookups hit the memo and take essentially 0 ms. Resolution overhead is negligible and the memoization is 14–90× faster than the cold path.

**Implication:** Walking the workspace at startup to pre-resolve texture paths costs ~56 ms in the worst case (4 000 unique paths) and is thereafter free. This is not a bottleneck — proceed with workspace-scan preload strategy without concern.

---

### Q7: Is there write contention in the cache dir under concurrent decode?

**Answer: Unmeasured — pending `measureWriteContention` benchmark.**

The `writeCached` implementation calls `fs.mkdirSync(cacheDir, { recursive: true })` on every write. Under a `Promise.all` of 50 concurrent decodes, all 50 call `mkdirSync` synchronously (JS is single-threaded but the calls still serialize). Separately, if two concurrent decodes produce the same cache key (same file decoded twice), both write to the same path. The `measureWriteContention` scenario varies batch size and checks for unexpected slowdown under synthetic contention.

---

## 4. The Benchmark Suite

### `dev/bench.ts` (run via `pnpm bench`)

Builds `dev/bench.ts` into `dist/bench.js` via `dev/bench.build.mjs` and runs it. All measurements use `performance.now()`. No vscode dependency — imports only `src/assets/blp.ts`, `cache.ts`, and `resolver.ts` directly.

**Scenarios:**

| Scenario           | What it measures                                                               | Question answered                         |
| ------------------ | ------------------------------------------------------------------------------ | ----------------------------------------- |
| `texture`          | BLP decode + cache write for N paths (`Promise.all`)                           | Throughput ceiling of the decode pipeline |
| `texture-split`    | Same, but reports `t_read / t_decode / t_encode / t_write` per file separately | Q5: which step dominates                  |
| `addon`            | `fs.readFile` for N XML/Lua/TOC files                                          | Confirms file I/O is not a bottleneck     |
| `combined`         | Mix of texture + addon                                                         | Combined throughput                       |
| `cache-hit`        | `getCachedPath` (stat) + `readFile` for N pre-decoded PNGs                     | Q4: is cache-hit effectively free         |
| `resolution`       | `resolveTexturePath` cold (memo cleared) and warm (memo intact)                | Q6: resolution overhead at scale          |
| `write-contention` | Concurrent cache writes with deliberately colliding keys                       | Q7: write contention safety               |

**Output:** a table to stdout + `dev/bench-results.json`. Results include per-scenario stats (min/median/p95/max/CV) and per-file timing for `texture-split`.

**Corpus note:** N is clamped to available fixtures. With the current minimal corpus (11 BLP, 228 addon files), high-N values will be capped. Run `dev/extract.sh retail --type all` for a full corpus that lets N=100 run uncapped.

### `dev/bench-diff.mjs` (baseline comparison)

```bash
node dev/bench-diff.mjs dev/bench-baseline.json dev/bench-results.json
```

Compares two result files. Refuses to diff mismatched corpus hashes, CPU models, or Node major versions (cross-config comparisons are invalid). Reports per-scenario median delta with a regression flag when change exceeds `max(10%, 2 × CV_baseline)`. Exits non-zero on any regression so it can later gate a hook or CI step.

### `dev/bench-listfile-filter.mjs` (listfile filter approaches)

Standalone `.mjs` — no build step. Measures the cost of filtering `listfile.csv` to `interface/` entries using several Node.js approaches, all timed from within a running Node.js process (including subprocess spawn cost for shell tools).

```bash
node dev/bench-listfile-filter.mjs \
  ~/.vscode-server/data/User/globalStorage/vertex-wow.wow-scryer/downloads/listfile.csv
```

**Approaches covered:** `grep -F`, `grep`, `node stream+bytes (1BRC-style)`, `node readFileSync+split`, `node readline`.

The `nodeStreamBytes` function in this script is also the reference implementation for the future in-process filter path (see [Listfile pre-filter backlog entry](plan/backlog.md#listfile-pre-filter-rustydemon-era)).

**One-off explorations (not committed as permanent fixtures):**

A separate benchmark session tested SQLite virtual table extensions (`sqlite-xsv` npm package, `sqlean vsv`), plain INSERT+SELECT approaches (`node:sqlite`, `better-sqlite3`, `@libsql/client`), the `sqlite3` CLI, and CSV-aware CLI tools (`xan`, `xsv`, `qsv`). Results are in Q1b above. The `nodeStreamBytes` implementation from those sessions is preserved as `dev/bench-listfile-filter.mjs` (the committed benchmark script above). The `node:sqlite` built-in (`DatabaseSync`) requires Node ≥ 22.5. None of the tested packages include the SQLite CSV virtual table; it requires a custom build from `ext/misc/csv.c`.

### `dev/bench-casc-comparison.mjs` (CASC tool head-to-head)

Standalone `.mjs` — no build step. Benchmarks `casc-extractor` vs `rustydemon-cli` head-to-head from within a running Node.js process (subprocess spawn cost included).

```bash
node dev/bench-casc-comparison.mjs [runs] [warmup]
# defaults: 3 runs, 1 warmup
```

Config reads from `dev/settings.local.json` (`scryer.installDir`, `scryer.cascToolPath`) or env vars `CE_PATH`, `RD_PATH`, `WOW_DIR`, `LISTFILE`.

**Scenarios:** CASC open (list/dry-run, no writes), bulk Interface/AddOns extraction (8 threads), per-file extraction by path.

---

### `hyperfine` (shell-based extraction)

For benchmarking `rustydemon-cli` / `dev/extract.sh` — whole-process invocations that cannot be timed from inside Node.

```bash
# Install (if not present — already installed on this machine)
# sudo apt install hyperfine

# Run the CASC open-vs-extract benchmark
hyperfine \
  --warmup 2 --runs 10 \
  --prepare 'rm -rf /tmp/bench-wow-extract' \
  --export-json dev/bench-casc-results.json \
  './dev/extract.sh retail --paths-file /tmp/paths-1.txt' \
  './dev/extract.sh retail --paths-file /tmp/paths-10.txt' \
  './dev/extract.sh retail --type interface'
```

Output goes to `dev/bench-casc-results.json` (gitignored alongside `dev/bench-results.json`).

---

## 5. Running Reproducibly

### Environment checklist (for this machine: AMD Ryzen 5 3600X, WSL2)

Run through this before capturing a baseline or running a pre/post-commit comparison. Order is by impact-to-effort.

**Do every time:**

1. **Pin to a fixed core set.** Scheduling noise is the biggest source of variance on a shared machine. Use `taskset` to confine the bench to 4 logical cores on the same physical CCX:

   ```bash
   taskset -c 0,1,2,3 pnpm bench
   ```

   For single-core reproducibility of the BLP decode sub-timer (CPU-bound), use `taskset -c 2` with `nice -n -5`.

2. **Close VS Code extension host, browsers, Docker, and any file watchers.** In particular, stop `pnpm watch` (esbuild --watch) if running. These generate background I/O and scheduler load.

3. **Do not extract while benchmarking.** Running `dev/extract.sh` concurrently pollutes `.wow-cache/` and contaminates all I/O measurements.

4. **Warm-up is built in.** `dev/bench.ts` discards one warm-up iteration before timing. For `hyperfine`, `--warmup 2` is sufficient.

**Check before a baseline capture:**

5. **Verify corpus hash matches.** If you've run `dev/extract.sh` since the last baseline, the corpus has changed. The diff script will refuse to compare mismatched hashes — you need to re-capture the baseline.

6. **Check Node version.** `node --version` should match the version recorded in the baseline JSON (`meta.node`). If you've upgraded Node between baseline and current, the comparison is invalid.

7. **Record Windows power plan.** Set Windows to "High Performance" power plan before benchmarking. The WSL2 CPU governor is controlled by the Windows host, not by `/sys/...` — this is the closest equivalent to `scaling_governor=performance` available on WSL2.

### What we cannot control on WSL2 (and why)

The FOSDEM 2026 article documents that disabling SMT (Hyper-Threading) reduces CV by 100× for CPU-bound microbenchmarks. On WSL2, the following controls are **not available**:

- `/sys/devices/system/cpu/smt/control` — WSL2 kernel does not expose this interface
- `/sys/devices/system/cpu/intel_pstate/no_turbo` — AMD CPU, and WSL2 doesn't expose this anyway
- `scaling_governor=performance` — writable only on bare metal; on WSL2 it's locked to the Windows power plan

**Workaround:** `taskset -c 0,1,2,3` pins to a subset of cores, partially reducing scheduler contention. The built-in CV reporting in `bench-results.json` lets you judge run quality: if `CV > 5%` for a scenario, the run is noisy and should be discarded and repeated after closing more background processes.

If highly reproducible numbers are ever required (e.g. for a published ADR backing a major architectural decision), run on a bare-metal Linux machine or an AWS `m5.metal` instance where all controls are available.

### Sample sizes and statistical validity

- **`dev/bench.ts`:** `RUNS = 5` outer reruns per N value; cheap scenarios (cache-hit, resolution, addon) use `N_INNER = 30` inner samples per measurement so variance is meaningful at sub-millisecond granularity.
- **`hyperfine`:** `--runs 10` with `--warmup 2` by default. Use `--runs 20` for sub-100ms commands where noise dominates.
- **Rule of thumb from the article:** if `CV > 1%` for a microbenchmark, the results are too noisy for reliable comparison. If `CV > 5%` for a macrobenchmark, investigate and repeat.

---

## 6. Regression Detection — Pre/Post Commit

This is a **manual** workflow for performance-sensitive commits. It is not an automatic hook (yet — see §8).

### Capture a baseline

```bash
# 1. On the commit you want to use as baseline:
taskset -c 0,1,2,3 pnpm bench

# 2. Save the result as your baseline:
cp dev/bench-results.json dev/bench-baseline.json
```

`dev/bench-baseline.json` is gitignored (machine-specific). It lives alongside the results file until you replace it.

### Run the comparison

```bash
# 1. Make your change, build, switch commit, etc.
# 2. Run the bench again on the same machine:
taskset -c 0,1,2,3 pnpm bench

# 3. Diff against baseline:
node dev/bench-diff.mjs dev/bench-baseline.json dev/bench-results.json
```

### Interpreting the output

`bench-diff.mjs` prints a table with columns: `scenario | N | baseline_ms | current_ms | delta% | verdict`.

Verdicts:

- **`ok`** — change within noise band (`max(10%, 2 × CV_baseline)`).
- **`improved`** — statistically meaningful improvement beyond noise.
- **`REGRESSION`** — meaningful slowdown beyond noise. Investigate with `node --cpu-prof dist/bench.js` (see §7).

The script exits non-zero if any scenario shows `REGRESSION`, making it trivially promotable to a `pre-push` hook or CI step.

### What to do on a regression

1. Run `node --cpu-prof dist/bench.js` to generate a `.cpuprofile`.
2. Open in Chrome DevTools (or VS Code: _Debug: Open Loaded Scripts_, then the profile file) to see a flame graph.
3. The likely suspects are: `PNG.sync.write` (encode), `blpToPng` (decode), or a new call path added by the change.
4. Do not commit the change without either fixing the regression or explicitly documenting in the commit message that the performance trade-off is accepted.

### When to capture a new baseline

- After intentionally optimizing the decode or extraction pipeline.
- After upgrading `js-blp`, `pngjs`, or Node.
- After changing the corpus significantly (more BLP files via `dev/extract.sh`).

---

## 7. Tooling Inventory

### Adopted

| Tool                 | Purpose                                                                             | How to get                                                                                                                                                                                                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `performance.now()`  | Sub-millisecond in-process timing in `dev/bench.ts`                                 | Built into Node                                                                                                                                                                                                                                                                                                           |
| `hyperfine`          | Whole-process timing for `rustydemon-cli` / `extract.sh`                            | Already installed; `sudo apt install hyperfine`                                                                                                                                                                                                                                                                           |
| `taskset`            | CPU core pinning to reduce scheduling noise                                         | Already installed (part of `util-linux`)                                                                                                                                                                                                                                                                                  |
| `nice`               | Process priority elevation for single-core micro-timing                             | Built into Linux                                                                                                                                                                                                                                                                                                          |
| `node --cpu-prof`    | CPU flame graph for regression investigation                                        | Built into Node                                                                                                                                                                                                                                                                                                           |
| `node --heap-prof`   | Memory profiling                                                                    | Built into Node                                                                                                                                                                                                                                                                                                           |
| `perf`               | Linux kernel perf subsystem — sampling profiler, cache-miss counters, lock analysis | Installed on this machine (`perf stat`, `perf record`, `perf lock`). Note: WSL2 has limited hardware counter access (many CPU PMU events are blocked by the hypervisor), but software events and sampling work. Use `perf stat -e task-clock,cpu-migrations,page-faults node dist/bench.js` for a quick characterization. |
| `dev/bench-diff.mjs` | Baseline comparison with noise-aware regression detection                           | In this repo                                                                                                                                                                                                                                                                                                              |

### Considered and skipped

| Tool                                      | Why skipped                                                                                                                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `perflock`                                | Third-party CPU frequency locking tool — not installed. Note: `perf lock` (a built-in `perf` subcommand for kernel lock analysis) _is_ installed and is a different tool. |
| `bencher.dev` / `github-action-benchmark` | CI-oriented; overkill for single-dev pre/post-commit workflow. Revisit if benchmarks move to CI.                                                                          |
| `chronologer`                             | Go-specific. N/A.                                                                                                                                                         |
| `Apache Otava`                            | e-divisive change-point detection service for continuous benchmarking. Overkill for current scale.                                                                        |
| `k6` / `wrk2`                             | Load generators for servers maintaining constant request rate. No server here.                                                                                            |
| Welch's t-test (automated)                | Valuable for CI; for manual pre/post-commit the threshold-on-CV approach is sufficient.                                                                                   |

### Why not Jest for benchmarks?

Jest tests run in CI. Benchmark runs depend on `.wow-cache/` (gitignored corpus) and take up to several minutes. Mixing them would either break CI (missing corpus) or make CI unacceptably slow. Keeping benchmarks as standalone `dev/` scripts keeps the test suite fast and CI-clean.

---

## 8. Long-Term Roadmap

### In-process JS CASC reader vs external binaries

When the CASC Asset Service is built (see [M15 — CASC Asset Service](plan/015_casc_asset_service.md)), the comparison benchmark is:

```bash
# Compare JS reader against both external binaries:
node dev/bench-casc-comparison.mjs 5 2
```

`dev/bench-casc-comparison.mjs` already benchmarks casc-extractor vs rustydemon-cli head-to-head. Extend it with a JS reader scenario when ready. The result becomes the evidence in the ADR for "keep external binary vs. go in-process."

**Acceptable threshold:** if the JS reader is within 2× of `casc-extractor` (the current faster baseline at 15.7 s), the trade-off (no install, no listfile, no subprocess) is likely worth it. If it is > 3× slower than casc-extractor (> ~47 s), the binary may need to stay as a fallback.

**Updated reference baseline (from Q1c, 2026-05-31):**

| Tool                 | CASC open (warm) | Bulk extract (8 threads) |
| -------------------- | ---------------- | ------------------------ |
| casc-extractor 0.2.0 | 15.7 s           | 15.3 s                   |
| rustydemon-cli       | 28.9 s           | 32.7 s                   |
| JS reader (target)   | < 31 s (2×)      | —                        |

### BLP decode optimization

The split-timer benchmark confirmed that `js-blp` DXT decompression is the bottleneck, not PNG encoding. Potential improvements in priority order:

1. **Inspect the BLP type byte of slow files.** If `ui-background-rock.blp` is raw RGBA (BLP type 1) rather than DXT-compressed, the `js-blp` codepath for that variant may be doing an unnecessary copy through JavaScript. A direct `Buffer.copy` from the raw data would be nearly instant. Add a BLP type inspection step to the split benchmark to confirm.

2. **WASM BLP decoder.** WASM SIMD can decompress DXT blocks 10–100× faster than JavaScript. If a suitable WASM BLP decoder exists (or can be compiled from an existing C implementation), this would move the rock from 4 000 ms to < 100 ms and collapse all three preload tiers into "eager."

3. **Node Worker Threads for parallel decode.** The current `Promise.all` over `blpToPng` executes all decodes sequentially (JS is single-threaded). A worker pool with 4–6 threads (matching physical core count) would decode files in true parallel. For 11 files including rock, theoretical speedup: ~4× on 4 cores.

4. **Skip PNG for the local cache.** The webview could accept raw RGBA bytes (no `PNG.sync.write` at all), saving 88 ms on rock (2% of total) and < 2 ms on icons. Minor gain given the BLP decode dominance, but eliminates a pointless re-compression step for data that is already locally trusted.

Benchmark each option before/after with `pnpm bench` + `bench-diff.mjs`. A 10× speedup on the `t_decode` column of the `texture-split` scenario would be the target signal.

### CI integration

Trigger condition: when the team grows beyond a single developer, or when a performance regression reaches production. At that point, add `github-action-benchmark` to the CI pipeline using the `bench-diff.mjs` exit code as the gate. The baseline would be stored as a CI artifact from the last known-good build on main.

---

## 9. References

- FOSDEM 2026: [Measuring Software Performance](https://kakkoyun.me/posts/fosdem-2026-measuring-software-performance/) — statistical methods, tooling, environment controls
- [ADR 002: Asset Pipeline](decisions/002_asset_pipeline.md) — architecture context for BLP decode and cache
- [Backlog: Extraction Benchmarks](plan/backlog.md#extraction-benchmarks) — original task, initial findings, implementation notes
- [Backlog: Preload Workspace Textures](plan/backlog.md#preload-workspace-textures-at-startup) — preload decision this benchmark informs
- [M15: CASC Asset Service](plan/015_casc_asset_service.md) — long-term head-to-head target
