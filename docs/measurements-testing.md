# Scryer Benchmark Infrastructure

## Table of Contents

1. [The Benchmark Suite](#1-the-benchmark-suite)
2. [Running Reproducibly](#2-running-reproducibly)
3. [Regression Detection — Pre/Post Commit](#3-regression-detection--prepost-commit)
4. [Tooling Inventory](#4-tooling-inventory)
5. [Long-Term Roadmap](#5-long-term-roadmap)
6. [Jest Test Suite Timing](#6-jest-test-suite-timing)
7. [Vitest vs Jest — `test:unit` timing comparison](#7-vitest-vs-jest--testunit-timing-comparison)

---

## 1. The Benchmark Suite

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

Standalone `.mjs` — no build step. Measures the cost of filtering `listfile.csv` to `interface/` entries. See [docs/measurements-sql.md](measurements-sql.md) for full results and run instructions.

### `dev/bench-listfile-index.mjs` (SQLite index build + lookup)

Standalone `.mjs` — no build step. Measures write-once index build cost and point lookup speed across all SQLite libraries and CSV extension approaches. See [docs/measurements-sql.md](measurements-sql.md) for full results, tool inventory, and run instructions.

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

## 2. Running Reproducibly

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

## 3. Regression Detection — Pre/Post Commit

This is a **manual** workflow for performance-sensitive commits. It is not an automatic hook (yet — see §5).

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
- **`REGRESSION`** — meaningful slowdown beyond noise. Investigate with `node --cpu-prof dist/bench.js` (see §4).

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

## 4. Tooling Inventory

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

## 5. Long-Term Roadmap

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

## 6. Jest Test Suite Timing

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

## 7. Vitest vs Jest — `test:unit` timing comparison

**Measured (2026-06-13, same machine and conditions as §6)**

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
