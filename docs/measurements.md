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
- Is the cache-hit path (serving already-decoded PNG from `.scryer-cache/`) effectively free?
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

| Stage                  | Module                                | Cost driver                             | Bottleneck?                                 | Notes                                                                                      |
| ---------------------- | ------------------------------------- | --------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **CASC open**          | `rustydemon-cli` (subprocess)         | **CPU: listfile parse (2.17M entries)** | **Yes for per-file use — batch everything** | First call: ~32.7 s. Warm page cache: ~25.3 s. Per-file approach for 102 textures = 47 min |
| CASC per-file extract  | `rustydemon-cli`                      | BLTE decompress + disk write            | No — fast once open                         | 3,650 files in 5.2 s with j=8 (0.001 s/file); 2,982 texture files in 6.1 s                 |
| Addon file read        | `fs.promises.readFile`                | Pure I/O                                | No                                          | Confirmed: 0–18 ms for N=100 files                                                         |
| **BLP DXT decompress** | **`js-blp` `getPixels(0)`**           | **CPU: DXT block decode**               | **Yes — dominant for large textures**       | Rock (513 KB): 3 908 ms. Marble (44 KB): 79 ms. Buttons: 0.2–2.3 ms.                       |
| PNG zlib compress      | `pngjs` `PNG.sync.write`              | CPU: zlib at default level              | Secondary                                   | Rock: 88 ms (2% of total). Marble: 6 ms. Buttons: < 1.5 ms.                                |
| Cache write            | `writeCached`, `fs.writeFileSync`     | I/O                                     | No                                          | Rock: 1.3 ms. Trivial.                                                                     |
| Cache hit              | `getCachedPath`, `fs.accessSync`      | I/O: single stat                        | No                                          | Confirmed: ~2 ms for 11 cached files; effectively free.                                    |
| Path resolution        | `resolveTexturePath`, `fs.accessSync` | I/O: probes × candidates                | No                                          | Confirmed: 0.07–0.16 ms for 11 paths cold; 0.00–0.01 ms warm (14–90× memoization speedup). |

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

**Cache-hit (serve pre-decoded PNG from `.scryer-cache`):**

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

The listfile CSV has **2,172,924 entries** (`dev/listfile.csv`). Even with the file fully in OS page cache, the text parsing + in-memory hashing takes ~25 s CPU. This cost is paid on every `rustydemon-cli` process launch.

**Consequence:** Per-file extraction for 102 textures ≈ 102 × 28 s ≈ **47 minutes** of overhead alone — completely impractical. All extraction must be done in a single batched call per CASC open. The `dev/extract.sh --paths-file` loop (which spawns one process per path) must be replaced with a batch strategy.

**The fix:** Use `rustydemon-cli -p "{dir1,dir2,...}/**"` brace-glob syntax to extract multiple directories in a single CASC open. The tool supports brace expansion in the `-p` argument (confirmed); it does not support multiple `-p` flags or a `--paths-file` option.

**Implication for architecture:** Any extraction feature (on-demand or batch) must batch all its paths into a single `rustydemon-cli` call. An in-process CASC reader (see [backlog](plan/backlog.md#in-process-javascript-casc-reader-replace-extractsh--rustydemon-cli)) would eliminate this listfile-parse overhead entirely.

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

| Tier      | Condition                                | Strategy                                                |
| --------- | ---------------------------------------- | ------------------------------------------------------- |
| Instant   | File in `.scryer-cache/` already decoded | Serve immediately (< 2 ms, Q4 confirmed)                |
| Eager     | BLP file < 50 KB                         | Decode at activation in background thread               |
| Deferred  | BLP file 50–200 KB                       | Decode when first referenced in an open XML file        |
| On-demand | BLP file > 200 KB                        | Decode only when the webview requests it, show progress |

**Note:** These thresholds are based on the current `js-blp` decode performance. If the decoder is replaced with a faster WASM implementation (see Q5 optimization options), all tiers would shift toward "eager" as cost drops.

---

### Q4: Is the cache-hit path effectively free?

**Answer: Yes — confirmed by `measureCacheHit` benchmark.**

Cache-hit cost: ~2 ms for all 11 available BLP files simultaneously (stat + file read). Single-file cache-hit is sub-millisecond. Preloading is definitively "pay once at first open, then instant on every subsequent render."

**Implication:** The workspace startup preload (see [Backlog: Preload Workspace Textures](plan/backlog.md#preload-workspace-textures-at-startup)) is the right call. Pay the BLP decode cost once at activation, cache to `.scryer-cache/`, and every subsequent preview renders instantly. The only question remaining is whether to decode on-demand (lazy) or in-background (eager). The benchmark confirms that once in cache, there is no reason to re-decode.

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
3. **Skip PNG entirely for the cache:** write raw RGBA to `.scryer-cache/` and have the webview accept a `data:image/raw` or `image/webp` (encode RGBA→WebP in Node, which has native bindings). This removes both the `PNG.sync.write` step and the cost scales only with the BLP decode.
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

3. **Do not extract while benchmarking.** Running `dev/extract.sh` concurrently pollutes `.wow-assets/` and contaminates all I/O measurements.

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

Jest tests run in CI. Benchmark runs depend on `.wow-assets/` (gitignored corpus) and take up to several minutes. Mixing them would either break CI (missing corpus) or make CI unacceptably slow. Keeping benchmarks as standalone `dev/` scripts keeps the test suite fast and CI-clean.

---

## 8. Long-Term Roadmap

### In-process JS CASC reader vs `rustydemon-cli`

When the in-process CASC reader is built (see [backlog: In-process JavaScript CASC reader](plan/backlog.md#in-process-javascript-casc-reader-replace-extractsh--rustydemon-cli)), the comparison benchmark is:

```bash
# Replace extract.sh with the JS reader, then run hyperfine head-to-head:
hyperfine \
  --warmup 2 --runs 10 \
  --export-json dev/bench-casc-comparison.json \
  'node dist/bench-casc.js --paths-file /tmp/paths-50.txt'        \  # JS reader
  './dev/extract.sh retail --paths-file /tmp/paths-50.txt'           # rustydemon-cli
```

The result file becomes the evidence in the ADR for "keep external binary vs. go in-process." The ADR should cite the specific commit SHA and `corpusHash` from the benchmark metadata.

**Acceptable threshold:** if the JS reader is within 2× of `rustydemon-cli`, the trade-off (no install, no listfile, no subprocess) is likely worth it. If it is > 3× slower, the binary may need to stay as a fallback.

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
- [Backlog: In-process CASC Reader](plan/backlog.md#in-process-javascript-casc-reader-replace-extractsh--rustydemon-cli) — long-term head-to-head target
