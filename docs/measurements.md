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
10. [Jest Test Suite Timing](#10-jest-test-suite-timing)
11. [Vitest vs Jest — `test:unit` timing comparison](#11-vitest-vs-jest--testunit-timing-comparison)

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
- Scope: this covers _only_ the template corpus. A full-addon manifest (all 315 Blizzard addons) would require a proper parser-backed manifest generator — see [todo: Blizzard texture manifest builder](plan/todo.md).

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
| TGAs (37 files)                 | ~50–100 ms est.  | Measured (Q8): p50 ~2 ms, 684 KB max ~18 ms     |

**Key findings:**

- A heavily-loaded 153-addon workspace has only **~180 texture refs** — workspace scan is smaller than expected.
- The **per-addon average is ~1.2 textures**; a typical 1–5 addon developer workspace has ~5–30 refs.
- At ~5–30 refs and p50 ~3 KB each: total workspace preload is **< 100 ms** in the common case — effectively free.
- The only significant cost is outlier backgrounds (> 200 KB). One such file adds ~2–4 s.
- TGA textures (37 of 65 addon-bundled = 57%) are now decoded (see Q8). Estimated total ~50–100 ms for all 37 — well within the eager-preload budget.
- The 29 unavailable textures are locale-specific variants or from addons not installed locally — these will always be a small miss rate for any given machine.

### TGA decode measurements (2026-06-16)

**Context:** 37 of 65 addon-bundled textures in the workspace corpus are TGA files (see above). Prior to this measurement the extension returned a placeholder for all TGA paths. This section records the cost of the new TGA decode pipeline and the pre-impl baseline.

**Method:** `dev/bench-tga-decoder.ts` — run with `node dist/bench-tga.js [--runs N]`. Imports `tgaToRgba` (`src/assets/tga-decode.ts`) and times read / decode / encode separately. Best-of-11, 1 warmup, `taskset -c 0,1,2,3`. AMD Ryzen 5 3600X, Node v24.16.0, WSL2.

**Pre-impl baseline:** The stub code returned `null` without reading the file — ~0 ms decode cost, but the texture was never served (placeholder shown instead).

**Post-impl split timers (best-of-11, ms):**

| Fixture                                  | File KB | WxH     | bpp | type | t_read | t_decode | t_encode | total |
| ---------------------------------------- | ------- | ------- | --- | ---- | ------ | -------- | -------- | ----- |
| synthetic 64×64 24bpp uncompressed       | 12.0    | 64×64   | 24  | unc  | —      | 0.026    | 0.424    | 0.45  |
| synthetic 256×256 24bpp uncompressed     | 192.0   | 256×256 | 24  | unc  | —      | 0.326    | 3.846    | 4.17  |
| synthetic 256×512 32bpp RLE (worst-case) | 513.0   | 256×512 | 32  | rle  | —      | 0.744    | 8.179    | 8.92  |
| vertex-icon (512×512 24bpp uncompressed) | 768.0   | 512×512 | 24  | unc  | 0.556  | 1.361    | 15.682   | 17.60 |

**Key observations:**

- **TGA decode (`tgaToRgba`) is very fast:** < 2 ms for 512×512 uncompressed. The channel-swap loop (BGR→RGBA) is straightforward typed-array work — no DXT or palette lookup involved.
- **PNG encode dominates total cost:** 15.7 of 17.6 ms for vertex-icon. Same bottleneck as the BLP pipeline. The decode step contributes < 10% of total time.
- **RLE (type 10) worst-case:** Alternating pixels (no runs) forces raw-packet mode throughout. Decode cost for 256×512 is 0.74 ms — about 2× uncompressed decode at the same pixel count, which is the expected overhead for packet-header reads.
- **vs BLP DXT1 at similar file sizes:** TGA 512×512 24bpp (~17.6 ms total) vs BLP rock.blp 513 KB DXT1 (Q5, ~100 ms total). TGA is ~6× faster end-to-end, because BGR→RGBA is O(N) with no lookup tables, while DXT decompression involves block arithmetic.
- **Extrapolated for the 37 addon TGAs** (p50 ~6 KB → ~60×60, p95 ~90 KB → ~200×200, max 684 KB → ~512×512): estimated ~50–100 ms total, all eager-preloadable. Cache-hittable on subsequent opens.

**Decision: TGA decode is cheap enough for eager preload at all sizes.** No lazy tier needed. All 37 addon-bundled TGAs in the sample workspace can be decoded at activation alongside the button/icon BLPs without exceeding the < 500 ms budget for that tier.

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
- **SQLite adds overhead for the one-shot filter use case** because every approach pays both a read/parse cost and an INSERT cost. SQLite becomes the right choice for the [Listfile fast index](plan/todo.md#listfile-fast-index-in-process--post-rustydemon-era) use case: store the 169K rows once, then do sub-millisecond point lookups by FileDataID. That is a completely different access pattern.
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

**Implication:** The workspace startup preload (see [Todo: Preload Workspace Textures](plan/todo.md#preload-workspace-textures-at-startup)) is the right call. Pay the BLP decode cost once at activation, cache to `.wow-cache/`, and every subsequent preview renders instantly. The only question remaining is whether to decode on-demand (lazy) or in-background (eager). The benchmark confirms that once in cache, there is no reason to re-decode.

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

### Q5b: Does fast-png encode faster than pngjs for our BLP corpus? {#q5b-fast-png-vs-pngjs}

**Answer: No — parity across the board. fast-png offers no meaningful improvement for this workload.**

**Measured (2026-06-16, AMD Ryzen 5 3600X 12-core, 16 GB RAM, Node v24.16.0, WSL2, 7 timed runs per file + 1 warmup)**

**Script:** `dev/bench-encoder-comparison.mjs` — run with `node dev/bench-encoder-comparison.mjs [--runs N]`.

**Corpus:** 112 BLP fixtures extracted from CASC via `pnpm extract` (retail flavor, Interface/ tree).

**Summary:**

| Metric                             | Value              |
| ---------------------------------- | ------------------ |
| Files benchmarked                  | 112                |
| Median speedup (unweighted)        | 1.0×               |
| Weighted speedup (by BLP size)     | 1.0×               |
| Largest pngjs encode (max file)    | 193 ms (2048×1024) |
| Largest fast-png encode (max file) | 182 ms (2048×1024) |

**Representative per-file results (median ms, 7 runs):**

| File                                            | BLP size | Resolution | pngjs   | fast-png | Speedup  |
| ----------------------------------------------- | -------- | ---------- | ------- | -------- | -------- |
| glues/characterselect/glueannouncementpopup     | 2049 KB  | 2048×1024  | 193 ms  | 182 ms   | 1.1×     |
| helpframe/newplayerexperienceparts              | 2049 KB  | 2048×1024  | 184 ms  | 171 ms   | 1.1×     |
| shop/catalogshop                                | 8193 KB  | 2048×1024  | 175 ms  | 169 ms   | 1.0×     |
| store/perks                                     | 8193 KB  | 1024×2048  | 172 ms  | 176 ms   | 1.0×     |
| radialwheel/uiradialwheel                       | 4097 KB  | 1024×1024  | 82 ms   | 67 ms    | 1.2×     |
| auctionframe/auctionhouse                       | 1025 KB  | 1024×1024  | 79 ms   | 99 ms    | **0.8×** |
| common/commonbuttons                            | 1025 KB  | 1024×1024  | 78 ms   | 82 ms    | 1.0×     |
| collections/uicampcollection                    | 2049 KB  | 512×1024   | 76 ms   | 113 ms   | **0.7×** |
| covenantrenown/covenantrenownui                 | 2049 KB  | 1024×512   | 36 ms   | 32 ms    | 1.1×     |
| guildframe/communities                          | 513 KB   | 1024×512   | 51 ms   | 49 ms    | 1.0×     |
| framegeneral/ui-background-rock                 | 513 KB   | 1024×1024  | 92 ms   | 95 ms    | 1.0×     |
| framegeneral/ui-background-marble               | 44 KB    | 256×256    | 6.8 ms  | 6.4 ms   | 1.1×     |
| collections/collections                         | 257 KB   | 512×512    | 23 ms   | 27 ms    | **0.8×** |
| buttons/redbuttons                              | 9 KB     | 128×64     | 0.92 ms | 1.2 ms   | **0.7×** |
| buttons/ui-silver-button-up                     | 7 KB     | 128×32     | 0.45 ms | 0.54 ms  | **0.8×** |
| achievementframe/ui-achievement-progress-border | 12 KB    | 256×32     | 0.85 ms | 2.0 ms   | **0.4×** |
| buttons/ui-checkbox-down                        | 3 KB     | 32×32      | 0.26 ms | 0.23 ms  | 1.1×     |
| common/shadowoverlay-top                        | 2 KB     | 8×64       | 0.75 ms | 0.10 ms  | 7.4×     |

**Key observations:**

- **Large textures (> 500 KB / > 512×512):** encode costs are nearly identical for both libraries, within ±15% across runs. Neither has a meaningful advantage. pngjs wins slightly more often.
- **Medium textures (10–500 KB):** results are mixed; neither library dominates.
- **Small textures (< 10 KB):** both are sub-millisecond and results are entirely within measurement noise. Individual anomalies (e.g. `shadowoverlay-top` at 7.4×, `achievementframe-progress-border` at 0.4×) reflect timing noise at sub-millisecond granularity, not stable algorithmic differences.
- **Worst-case fast-png regressions:** `uicampcollection.blp` (512×1024): fast-png 113 ms vs pngjs 76 ms (1.5× slower). `auctionhouse.blp` (1024×1024): 99 ms vs 79 ms (1.3× slower). These are consistent across 7 runs.

**Why predictions were wrong:**

The hypothesis that "fast-png is 10–20× faster" was based on general benchmarks of pngjs vs fast-png for large natural images under zlib compression. Our corpus is predominantly small textures (p50 BLP size ~3–7 KB) where both libraries spend most time in JS overhead, not zlib. For the large textures where zlib actually runs, both libraries perform comparably — consistent with both using similar zlib implementations (pngjs wraps Node's built-in `zlib.deflateSync`; fast-png does the same). The earlier claim that pngjs uses "pure-JS zlib" was incorrect: pngjs delegates to Node's built-in `zlib` (native C), not a JS implementation.

**Decision: keep pngjs. Do not replace it with fast-png.**

fast-png adds a dependency with no performance gain for this corpus. The encode step is not the bottleneck and fast-png does not improve it. The optimization opportunity remains in the BLP decode (`js-blp` `getPixels`), which is 10–44× more expensive than the encode step. See Q5 and [todo: Replace pngjs with fast-png](plan/todo.md) — this item should be cancelled.

---

### Q5c: How much faster is the typed-array BLP decoder vs js-blp? {#q5c-typed-array-decoder}

**Answer: ~49× on the test fixture (vertex-icon.blp); expected 30–60× for DXT textures, ~10× for rawBGRA.**

**Method:** `dev/bench-blp-decoder.ts` — runs both decoders on each BLP file under `test/`, reports best-of-3.

**Result (2026-06-16, vertex-icon.blp, 256×256 DXT1):**

| Decoder            | Min time (ms) | Speedup |
| ------------------ | ------------- | ------- |
| js-blp getPixels() | 154.0         | 1×      |
| blpToRgba (fast)   | 3.1           | **49×** |

**Root cause of js-blp slowness (confirmed from source):**

- `readUInt8(N)` in Bufo accumulates all mip bytes into a plain JS `Array` (not `Uint8Array`), forcing V8 to use dictionary-mode array storage.
- `_getCompressed()` (DXT path): `let data = []` and `let target = []` — plain arrays for all 4 MB of decoded RGBA output, each element written as an array-indexed store.
- `_marshalBGRA()` (rawBGRA path): `buf.writeUInt8([r,g,b,a])` — allocates a 4-element array literal per pixel (1M allocations for 1024×1024).

**Our fix (`src/assets/blp-decode.ts`):**

- `Buffer.allocUnsafe` for output (typed, contiguous memory).
- Per-block color table via `Uint8Array(16)` — allocated once, reused every block.
- DXT5 alpha indices pre-decoded into `Uint8Array(16)` per block via 24-bit group reads.
- Raw BGRA: single typed-array loop, no per-pixel allocation.
- Falls back to js-blp for encoding=1 (palette), which is rare in retail Interface/.

**Impact on preload tiers (from Q5):**

| Tier                              | Before (js-blp) | After (fast decoder)  |
| --------------------------------- | --------------- | --------------------- |
| Small textures (< 50 KB)          | < 10 ms         | < 1 ms                |
| Medium textures (50–500 KB)       | 10–300 ms       | < 20 ms               |
| rock.blp (513 KB, DXT1 1024×1024) | ~4 000 ms       | ~80 ms (extrapolated) |

The "eager vs lazy" tier boundary shifts dramatically: rock.blp was the sole file that forced a lazy tier; at 80 ms it comfortably fits eager. Worker threads are now optional rather than required.

---

### Q5d: Is a Rust BLP decoder via asset server IPC faster than JS typed-array decode? {#q5d-rust-blp-via-ipc}

**Answer: No — JS wins at every encoding type and every size. Rust+IPC is 1–35× slower depending on texture size.**

**Method:** `dev/bench-rust-blp-decoder.ts` — generates synthetic BLP fixtures for each encoding type (DXT1/DXT3/DXT5/rawBGRA) at four resolutions (64–1024px), plus real fixtures from `test/`. Measures best-of-7 for both `blpToRgba` (in-process JS typed-array decoder) and `client.decodeBlpRgba()` (full JS→IPC→Rust→IPC→JS round-trip via asset server).

The Rust column includes the complete IPC cost:

- JS: `buf.toString("base64")` → `JSON.stringify` → pipe write
- Rust: pipe read → JSON parse → base64 decode → BLP decode → base64 encode → JSON write
- JS: pipe read → JSON parse → `Buffer.from(…, "base64")`

**Three paths benchmarked (2026-06-16, Ryzen 5 3600X, Node v24, WSL2):**

- **JS** — `blpToRgba()` in-process (no IPC)
- **Data-IPC** — `decodeBlpRgba()`: JS sends BLP bytes → Rust decodes → RGBA response (base64 paid twice: in + out)
- **CASC-IPC** — `readCascBlpRgba()`: JS sends path string → server reads BLP from CASC + decodes → RGBA response (base64 paid once: out only)

**Synthetic fixtures — all types × all resolutions:**

| Fixture           | File KB | JS (ms) | Data-IPC (ms) | CASC-IPC | Winner   |
| ----------------- | ------- | ------- | ------------- | -------- | -------- |
| DXT1 64×64        | 2 KB    | 0.2     | 0.2           | n/a      | JS 1.2×  |
| DXT3 64×64        | 4 KB    | 0.2     | 0.2           | n/a      | JS 1.2×  |
| DXT5 64×64        | 4 KB    | 0.1     | 0.2           | n/a      | JS 2.5×  |
| rawBGRA 64×64     | 16 KB   | 0.3     | 0.2           | n/a      | ~tie     |
| DXT1 256×256      | 32 KB   | 1.1     | 2.1           | n/a      | JS 1.9×  |
| DXT3 256×256      | 64 KB   | 0.4     | 2.2           | n/a      | JS 5.0×  |
| DXT5 256×256      | 64 KB   | 0.7     | 2.0           | n/a      | JS 2.9×  |
| rawBGRA 256×256   | 256 KB  | 0.1     | 3.9           | n/a      | JS 33.4× |
| DXT1 512×512      | 128 KB  | 1.6     | 8.1           | n/a      | JS 5.0×  |
| DXT3 512×512      | 256 KB  | 2.4     | 8.3           | n/a      | JS 3.5×  |
| DXT5 512×512      | 256 KB  | 3.5     | 8.3           | n/a      | JS 2.3×  |
| rawBGRA 512×512   | 1024 KB | 0.5     | 14.6          | n/a      | JS 30.9× |
| DXT1 1024×1024    | 512 KB  | 9.6     | 29.2          | n/a      | JS 3.1×  |
| DXT3 1024×1024    | 1024 KB | 13.2    | 38.3          | n/a      | JS 2.9×  |
| DXT5 1024×1024    | 1024 KB | 10.5    | 33.3          | n/a      | JS 3.2×  |
| rawBGRA 1024×1024 | 4096 KB | 2.0     | 55.2          | n/a      | JS 27.3× |

**Real CASC corpus — selected large textures (all three paths):**

| Texture (CASC path)                    | KB   | enc  | JS (ms) | Data-IPC (ms) | CASC-IPC (ms) | Winner   |
| -------------------------------------- | ---- | ---- | ------- | ------------- | ------------- | -------- |
| glues/…/glueannouncementpopup.blp      | 2049 | dxt5 | 28.1    | 86.7          | **53.8**      | JS 1.9×  |
| helpframe/newplayerexperienceparts.blp | 2049 | dxt5 | 22.8    | 57.7          | (miss)        | JS 2.5×  |
| shop/catalogshop.blp                   | 8193 | bgra | 4.4     | 121.0         | (miss)        | JS 27.7× |
| store/perks.blp                        | 8193 | bgra | 4.8     | 116.8         | **58.0**      | JS 12.0× |
| auctionframe/auctionhouse.blp          | 1025 | dxt5 | 11.0    | 28.8          | **24.1**      | JS 2.2×  |
| common/commonbuttons.blp               | 1025 | dxt5 | 10.8    | 29.1          | (miss)        | JS 2.7×  |
| framegeneral/ui-background-rock.blp    | 513  | dxt1 | 7.1     | 26.5          | (miss)        | JS 3.7×  |
| radialwheel/uiradialwheel.blp          | 4097 | bgra | 2.0     | 48.8          | (miss)        | JS 24.6× |
| collections/uicampcollection.blp       | 2049 | bgra | 0.9     | 23.5          | (miss)        | JS 24.8× |
| guildframe/communities.blp             | 513  | dxt5 | 5.3     | 15.4          | **12.3**      | JS 2.3×  |
| questframe/questlogframe.blp           | 1025 | bgra | 0.6     | 12.8          | **7.7**       | JS 12.7× |
| hud/uipendingspinnera.blp              | 513  | bgra | 0.2     | 6.4           | **3.3**       | JS 14.3× |
| buttons/ui-silver-button-up.blp        | 7    | dxt5 | 0.0     | 0.2           | (miss)        | JS 5.5×  |

CASC-IPC "(miss)" = CASC resolver returned null for that path (not in the current index snapshot).

**Why JS always wins:**

The fundamental constraint is that any IPC path must move RGBA bytes across a pipe. RGBA is always `4 × width × height` bytes, regardless of how fast Rust decodes. For a 1024×1024 texture that's 4 MB, which at pipe+base64 overhead costs ~15–25 ms before Rust does any work. Our JS typed-array decoder handles the same texture in 7–28 ms in-process.

- **Data-IPC** pays base64 + pipe twice (BLP bytes in, RGBA out). For rawBGRA textures where `file_size ≈ RGBA_size`, this costs 14–30× JS's time.
- **CASC-IPC** skips the upload — only RGBA crosses the pipe. For large DXT textures it's ~2× faster than Data-IPC. But RGBA is still large and still gets base64-encoded, so it still loses to JS by 2–4× on DXT and 12–27× on rawBGRA.

There is no crossover point. JS wins at every encoding type, every texture size, and in both IPC variants.

**Would a faster IPC transport help?**

The natural follow-up question is whether our IPC method is the bottleneck rather than Rust decode quality. Current protocol: line-delimited JSON with all binary payloads base64-encoded. Alternatives considered:

| Approach                                       | What it changes                                          | Estimated gain                                                                                                                                                     |
| ---------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Binary framing** (4-byte length + raw bytes) | Eliminates base64 (~33% less data, no encode/decode CPU) | ~25% wall-clock reduction for CASC-IPC on large DXT textures. Could bring CASC-IPC to ~18–20ms vs JS ~28ms for 2MB DXT5 — a narrow win. rawBGRA still loses badly. |
| **gRPC / protobuf**                            | `bytes` field = length-prefixed binary under the hood    | Same as binary framing; HTTP/2 framing adds overhead. No advantage.                                                                                                |
| **Unix domain socket**                         | Faster kernel path, same serialization                   | Marginal. Serialization dominates, not transport.                                                                                                                  |
| **Shared memory**                              | Zero-copy: JS and Rust share a segment                   | Could eliminate transfer overhead entirely. Complex with Node.js; no built-in support.                                                                             |
| **WASM**                                       | Compile Rust to `.wasm`, run in-process (no IPC at all)  | JS decoder already exists and is fast; WASM has startup + JIT overhead.                                                                                            |
| **N-API native addon**                         | Rust as a Node `.node` binary, zero-copy in-process      | Fastest possible. But per-platform binaries and complex packaging.                                                                                                 |

**Analysis (not tried):** Binary framing is the only IPC improvement worth attempting — it could make CASC-IPC marginally competitive for the very largest DXT textures. But:

1. Even in the optimistic case (18ms CASC-IPC vs 28ms JS for 2MB DXT5), the win is narrow and only appears for a handful of large textures that are already fast enough with the JS decoder.
2. rawBGRA textures would still lose 4–12× because they pay RGBA response cost with no compression offset.
3. CASC-IPC only applies when the texture is in the CASC archive, not for addon-bundled BLPs.
4. Binary framing requires rewriting the full IPC protocol on both sides (Rust + JS), adding complexity for a marginal win on an already-fast path.

**Estimate: not worth it.** The RGBA transfer cost is structural — any IPC variant pays it. JS in-process decode is the right architecture for this workload.

**Decision: Keep JS typed-array decoder (`src/assets/blp-decode.ts`). Do not route `decodeBlp` or `readAndDecodeBlp` through the asset server.** The full Rust implementation (blp_decode.rs, DecodeBlp/ReadAndDecodeBlp server methods, client wrappers, and bench-rust-blp-decoder.ts) was committed as a reference at `e328d60` and then reverted.

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

### Q8: How fast is atlas manifest generation, and is reading from CASC DB2 files faster than the current wago.tools CSV approach? {#q8-atlas-manifest-gen}

**Answer (baseline only — 2026-06-16, retail build 12.0.7.68182, Ryzen 5 3600X, Node v24, WSL2):**

**Scenario A — CSV download + parse + listfile join (current method):**

| Stat    | Value        |
| ------- | ------------ |
| Runs    | 3 (1 warmup) |
| Mean    | **3391 ms**  |
| Stddev  | ±229 ms      |
| CV      | 6.7%         |
| Min     | 3091 ms      |
| Max     | 3646 ms      |
| Entries | 16,461       |

CSV is cached on disk after the first download; this measures parse + listfile join only (no network).

**Scenario B — CASC DB2 read + WDC4 parse + listfile join (DB2 method):**

**BLOCKED.** Both `UiTextureAtlas.db2` and `UiTextureAtlasMember.db2` in retail build 12.0.7.68182 require a community resource entry (`0x0599D267A15C719F`) not yet published to wowdev/TACTKeys. The BLTE stream infrastructure (Salsa20/SIGMA_16, block-index IV XOR, community resource auto-download) is implemented and correct — the comparison will be possible once this entry is added to TACTKeys by the community.

**Infrastructure changes made during this benchmark run:**

- Fixed BLTE stream header parsing (removed bogus `key_count` byte, fixed `iv_size` to u8)
- Fixed Salsa20 to use "expand 16-byte k" (SIGMA_16) instead of the RustCrypto crate's hardcoded SIGMA_32
- Corrected a 3rd-party resource manifest entry value that was misread during initial implementation
- Implemented block-index IV XOR (matches wow.export/TACTLib spec)
- Auto-download community resource manifest (~19,600 entries) into `.casc-meta/tact-keys.txt`, refreshed weekly when CDN is enabled

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

The `nodeStreamBytes` function in this script is also the reference implementation for the future in-process filter path (see [Listfile pre-filter todo entry](plan/todo.md#listfile-pre-filter-rustydemon-era)).

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

## 10. Jest Test Suite Timing

**Measured (2026-06-13, AMD Ryzen 5 3600X 12-core, 16 GB RAM, Node v24.16.0, WSL2)**

10 consecutive runs of each Jest suite (`pnpm test:unit`, `pnpm test:casc`, `pnpm test:net`) with `--silent`. Playwright suites (`test:webview`, `test:xml`, `test:toc`, and their `-casc` variants) excluded — these are reported separately.

### Raw timings (wall clock, `time` bash builtin)

**`pnpm test:unit`** (`test/unit/**/*.test.ts`)

| Run | Wall clock |
| --- | ---------- |
| 1   | 24.661 s   |
| 2   | 27.129 s   |
| 3   | 25.666 s   |
| 4   | 25.499 s   |
| 5   | 28.334 s   |
| 6   | 24.704 s   |
| 7   | 27.752 s   |
| 8   | 26.280 s   |
| 9   | 25.721 s   |
| 10  | 25.946 s   |

**`pnpm test:casc`** (`test/unit-casc/**/*.test.ts`)

| Run | Wall clock |
| --- | ---------- |
| 1   | 3.520 s    |
| 2   | 3.291 s    |
| 3   | 3.148 s    |
| 4   | 3.313 s    |
| 5   | 3.320 s    |
| 6   | 3.450 s    |
| 7   | 3.244 s    |
| 8   | 3.503 s    |
| 9   | 3.222 s    |
| 10  | 3.338 s    |

**`pnpm test:net`** (`test/net/**/*.test.ts`)

| Run | Wall clock |
| --- | ---------- |
| 1   | 15.653 s   |
| 2   | 15.257 s   |
| 3   | 18.688 s   |
| 4   | 14.660 s   |
| 5   | 15.559 s   |
| 6   | 18.313 s   |
| 7   | 14.500 s   |
| 8   | 13.286 s   |
| 9   | 13.659 s   |
| 10  | 13.109 s   |

### Summary statistics

| Suite       | Runner         | Mean    | Median  | Min     | Max     | Stddev | CV    |
| ----------- | -------------- | ------- | ------- | ------- | ------- | ------ | ----- |
| `test:unit` | Jest (removed) | 26.17 s | 25.83 s | 24.66 s | 28.33 s | 1.16 s | 4.4%  |
| `test:casc` | Jest           | 3.34 s  | 3.32 s  | 3.15 s  | 3.52 s  | 0.12 s | 3.5%  |
| `test:net`  | Jest           | 15.27 s | 14.96 s | 13.11 s | 18.69 s | 1.83 s | 11.9% |

### Notes

- `test:unit` CV of 4.4% is within acceptable range for a suite that spawns Jest with ts-jest transforms and a `vscode` mock. Dominated by Jest startup + ts-jest transpilation, not test logic.
- `test:casc` is the fastest and tightest (CV 3.5%). It runs a single BLP-decode test against a pre-extracted local fixture — no subprocess, no network.
- `test:net` has the highest variance (CV 11.9%, max spread 5.6 s). Runs 3 and 6 spike to ~18 s while the bottom three cluster around 13–14 s. The suite spawns the `scryer-asset-server` binary and performs real CDN/CASC network calls; OS scheduler noise and WSL2 TCP jitter both contribute. This CV exceeds the 5% macro-benchmark caution threshold — treat net timings as order-of-magnitude guidance only.
- Combined Jest wall clock (all three suites sequential): ~44 s mean.

---

## 11. Vitest vs Jest — `test:unit` timing comparison

**Measured (2026-06-13, same machine and conditions as §10)**

`test:unit` was migrated from Jest + ts-jest to Vitest (`vitest run --config vitest.unit.config.ts`). All 412 tests pass under both runners. 10 runs each, stdout suppressed (`1>/dev/null`), wall clock via bash `time`.

**Vitest `test:unit` (10 runs):**

| Run | Wall clock |
| --- | ---------- |
| 1   | 14.816 s   |
| 2   | 15.760 s   |
| 3   | 16.317 s   |
| 4   | 15.639 s   |
| 5   | 15.948 s   |
| 6   | 16.077 s   |
| 7   | 15.279 s   |
| 8   | 17.279 s   |
| 9   | 15.072 s   |
| 10  | 15.148 s   |

| Runner | Mean    | Median  | Min     | Max     | Stddev | CV   | vs Jest   |
| ------ | ------- | ------- | ------- | ------- | ------ | ---- | --------- |
| Jest   | 26.17 s | 25.83 s | 24.66 s | 28.33 s | 1.16 s | 4.4% | —         |
| Vitest | 15.73 s | 15.70 s | 14.82 s | 17.28 s | 0.69 s | 4.4% | **1.66×** |

**Speedup: ~1.7×.**

### Why Vitest is faster

- **esbuild vs ts-jest.** Vite uses esbuild for TypeScript transpilation, which is significantly faster than ts-jest's TypeScript compiler. The `node_modules/.vite` cache only stores a 16 KB `results.json` (test outcome metadata) — compiled source is **not** cached between `vitest run` invocations. Every run re-transpiles from source, so the speedup is purely compiler throughput.
- **Jest's 26 s is essentially all runner overhead**, not test logic. The 412 tests themselves complete in milliseconds; the wall clock is dominated by Jest startup, ts-jest transpilation, and module loading.

### Notes

- Both runners show CV ≈ 4.4%, indicating similar run-to-run stability.
- **`test:casc` and `test:net` are not ported to Vitest.** Those suites spawn native binaries (the asset server); the dominant cost is binary startup and I/O, not the JS runner. Switching would not yield a meaningful improvement there.

---

## 9. References

- FOSDEM 2026: [Measuring Software Performance](https://kakkoyun.me/posts/fosdem-2026-measuring-software-performance/) — statistical methods, tooling, environment controls
- [ADR 002: Asset Pipeline](decisions/002_asset_pipeline.md) — architecture context for BLP decode and cache
- [Todo: Extraction Benchmarks](plan/todo.md#extraction-benchmarks) — original task, initial findings, implementation notes
- [Todo: Preload Workspace Textures](plan/todo.md#preload-workspace-textures-at-startup) — preload decision this benchmark informs
- [M15: CASC Asset Service](plan/015_casc_asset_service.md) — long-term head-to-head target
