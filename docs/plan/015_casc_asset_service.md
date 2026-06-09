# Milestone 15 — CASC Asset Service

**Status: ⬜ Pending**

## Goal

Replace the current `rustydemon-cli` subprocess-per-invocation architecture with a **standalone long-lived CASC extraction server** that the extension starts, queries over stdio, and restarts if it crashes. End result: install the extension, point `scryer.installDir` at your WoW folder, textures load — no user-installed tools, no manual setup.

The server is a separate Rust binary (forked from [`casc-extractor`](https://github.com/Xerrion/casc-extractor), MIT) bundled with the extension. It communicates over stdin/stdout using newline-delimited JSON, keeps CASC lookup tables resident in memory between requests, and self-terminates after an idle timeout.

**Language decision:** Rust (primary), with Go as a fallback if the AI-assisted Rust development proves too difficult to troubleshoot. The architecture (standalone binary + stdio JSON protocol + TypeScript client) is language-agnostic — a Go rewrite of the server would be a drop-in replacement with no extension-side changes.

**Relationship to prior backlog item:** This milestone supersedes the backlog entry "[In-process JavaScript CASC reader (replace extract.sh + rustydemon-cli)](backlog.md#casc-asset-service-replace-extractsh--rustydemon-cli)." The scope evolved from an in-process JS library to a standalone server after analysis showed that process isolation, clean memory lifecycle, and the availability of `casc-extractor` (MIT Rust implementation) make a separate-process architecture superior. See [`docs/reference/casc_asset_service_analysis.md`] for the full decision record.

## Architecture

```
┌───────────────────────────┐       stdio/JSON       ┌──────────────────────────┐
│  Scryer Extension Host    │  ───── request ──────▶  │  scryer-asset-server (Rust)      │
│  (Node.js / TypeScript)   │  ◀──── response ─────   │                          │
│                           │                         │  Lifecycle:              │
│  CascClient class:        │                         │    started by extension  │
│    .extractFile(path)     │                         │    stays alive           │
│    .extractFiles(paths)   │                         │    self-exits on idle    │
│    .status()              │                         │                          │
│                           │                         │  On first request:       │
│  Lifecycle management:    │                         │    load listfile/indices │
│    start on first need    │                         │    build lookup tables   │
│    detect crash → restart │                         │                          │
│    detect idle → let exit │                         │  On subsequent requests: │
│                           │                         │    hash lookup + extract │
└───────────────────────────┘                         └──────────────────────────┘
```

## MVP Scope (this milestone)

The MVP achieves **functional parity** with the current `rustydemon-cli` approach — same extraction capability, same file output, same consumer API — but with bundled distribution and proper lifecycle management. Performance optimizations are deferred sub-items.

### 1. Rust server binary (`scryer-asset-server`)

Fork `casc-extractor` and add a stdio server mode. The server:

- Accepts newline-delimited JSON requests on stdin, writes JSON responses on stdout.
- On startup, accepts `--wow-dir`, `--listfile`, `--out-dir`, and `--idle-timeout` arguments.
- Loads CASC tables (listfile + archive indices) on the first extraction request (lazy init).
- Extracts requested files to `--out-dir`, mirroring the directory structure.
- Resets an idle timer on every request. Self-exits cleanly after the timeout (default 20 s).
- Logs diagnostic output to stderr (not stdout — stdout is the protocol channel).

**Wire protocol (MVP):**

```jsonc
// Request: extract files to disk
→  {"id":1,"method":"extract","paths":["interface/buttons/ui-checkbox-check.blp"]}
←  {"id":1,"ok":true,"extracted":1,"skipped":0,"errors":0}

// Request: extract with glob pattern
→  {"id":2,"method":"extract","paths":["interface/buttons/**"]}
←  {"id":2,"ok":true,"extracted":42,"skipped":0,"errors":0}

// Request: server status / health check
→  {"id":3,"method":"status"}
←  {"id":3,"ok":true,"ready":true,"buildHash":"abc123","idleTimeoutMs":20000}

// Request: graceful shutdown
→  {"id":4,"method":"shutdown"}
←  {"id":4,"ok":true}
// (server exits)

// Error response
←  {"id":1,"ok":false,"error":"CASC archive not found at /path/to/wow"}
```

**Wire protocol decision:** Newline-delimited JSON over stdio — the same transport pattern used by every LSP server in VS Code. Zero dependencies on either side (`serde_json` in Rust, `JSON.parse` in Node are already present), no ports or sockets to manage, human-readable for debugging (`echo '{"method":"status"}' | ./scryer-asset-server`), and stdio pipes are the fastest available IPC mechanism (kernel-buffered, no TCP overhead).

The main limitation is binary data: file bytes must be base64-encoded inside JSON (~33% size overhead). This is irrelevant for the MVP (files are written to disk, not sent over the wire) but becomes a consideration for the "Direct byte streaming" sub-item. If binary throughput becomes a bottleneck, alternative protocols to evaluate:

- **Length-prefixed binary framing** — keep JSON for control messages, use a `[4-byte length][raw bytes]` frame for file content. Minimal change, no new dependencies.
- **MessagePack** (`rmp-serde` in Rust, `@msgpack/msgpack` in Node) — binary-compatible JSON alternative with native `bytes` type. Drop-in replacement for JSON serialization; ~50 lines of change per side.
- **Cap'n Proto / FlatBuffers** — zero-copy serialization for maximum throughput. Only justified if extracting hundreds of files per second over the wire.
- **gRPC** (`tonic` in Rust, `@grpc/grpc-js` in Node) — schema-first RPC with built-in streaming. Heavy dependency chain and TCP port management; only justified if the protocol grows to many methods or needs cross-machine communication.

None of these require rearchitecting the transport — the stdio pipe stays; only the serialization format changes.

**Key constraint:** The MVP server still uses the community listfile for path→hash resolution, exactly like `rustydemon-cli` today. This means the first request still pays the ~15–29 s listfile parse cost. The difference from the current approach is that this cost is paid **once** per server lifetime, not on every extraction call.

### 2. TypeScript client (`CascClient`)

A new class in `src/assets/casc-client.ts` that manages the server lifecycle and provides a typed API:

```typescript
class CascClient {
  /** Start the server if not running. Reuse if already alive. */
  private ensureRunning(): Promise<void>;

  /** Extract specific file paths to the cache directory. */
  extractFiles(paths: string[]): Promise<ExtractionResult>;

  /** Check if the server is alive and ready. */
  status(): Promise<CascStatus>;

  /** Request graceful shutdown. */
  shutdown(): Promise<void>;
}
```

Lifecycle rules:

- **Start on first need:** The server is not started at extension activation. It starts when `extractFiles()` is first called.
- **Crash detection:** If the server process exits unexpectedly (non-zero exit, signal kill, unresponsive to a `status` ping), the client logs a warning, nulls the process handle, and starts a fresh server on the next request.
- **Idle shutdown:** The server self-exits after the configured idle timeout. The client detects the `close` event and treats it the same as a crash — next request starts a new server.
- **Extension deactivation:** The extension's `deactivate()` function sends a `shutdown` request to allow graceful exit.

### 3. Integration with `AssetService`

`AssetService.extractMissing(paths)` in [`src/assets/extractor.ts`](file:///home/goldilocks/code/wow-scryer/src/assets/extractor.ts) is reimplemented to use `CascClient` instead of spawning `rustydemon-cli` directly. The function signature is unchanged — this is the boundary the M3 design anticipated.

For retail: `CascClient.extractFiles(paths)` replaces `spawnRustydemon(...)`.
For classic: unchanged — still copies loose files from the install directory.

### 4. Binary distribution

The Rust binary is bundled with the extension using VS Code's [platform-specific extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#platformspecific-extensions). Separate `.vsix` packages are built for each target:

| Platform     | Target triple              | Binary name               |
| ------------ | -------------------------- | ------------------------- |
| linux-x64    | `x86_64-unknown-linux-gnu` | `scryer-asset-server`     |
| darwin-x64   | `x86_64-apple-darwin`      | `scryer-asset-server`     |
| darwin-arm64 | `aarch64-apple-darwin`     | `scryer-asset-server`     |
| win32-x64    | `x86_64-pc-windows-msvc`   | `scryer-asset-server.exe` |

Binary lives at `<extensionPath>/bin/scryer-asset-server[.exe]`. The TypeScript client resolves this path via `context.extensionPath`.

Cross-compilation uses [`cross`](https://github.com/cross-rs/cross) or [`cargo-zigbuild`](https://github.com/rust-cross/cargo-zigbuild) in CI.

### 5. Configuration changes

| Setting                         | Change                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `scryer.assetServerPath`        | Repurposed: points to `scryer-asset-server` binary if user wants to override the bundled one. Empty = use bundled. |
| `scryer.assetServerIdleTimeout` | New (optional): idle timeout in seconds before the server self-exits. Default: 20.                                 |

`scryer.extractScriptPath` (if it exists) becomes fully obsolete.

## What Does NOT Change (MVP)

- **BLP→PNG pipeline** — unchanged. The server extracts raw BLP files to disk; the existing `js-blp` + `pngjs` pipeline in `blp.ts` converts them.
- **Cache structure** — unchanged. Files land in `<cacheRoot>/<flavor>/source/` exactly as before.
- **Classic extraction** — unchanged. Still copies loose files; no CASC involvement.
- **`dev/extract.sh`** — remains as contributor/dev tooling. Can optionally be updated to use `scryer-asset-server` instead of `rustydemon-cli`.
- **Community listfile** — still downloaded and parsed by the server for path→hash resolution (MVP).

## Deferred Sub-Items (Post-MVP Optimizations)

These are ordered by expected impact, not by implementation difficulty.

### ↳ Eliminate listfile dependency (use TVFS/root directly)

**Status:** 📋 Pending

The single largest performance win. The TVFS manifest (retail, since patch 8.2) and flat root file (classic) contain path→content-hash mappings for all locally installed files. Parsing these binary formats directly eliminates the 15–29 s community listfile parse.

Expected cold-start improvement: **25–29 s → ~200 ms**.

Requires implementing: `.build.info` parser, build/CDN config reader, encoding table parser, TVFS manifest parser (retail), flat root parser (classic), archive index parser, BLTE block reader/decompressor.

Reference: `_reference/casc-extractor/` (Rust), `_reference/wow.export/` (JS), wowdev.wiki.

**Effort:** L — this is the bulk of the format implementation work.

---

### ↳ Disk-cached lookup tables

**Status:** 📋 Pending

**Prerequisite:** Eliminate listfile dependency (above) — caching the listfile parse doesn't help much; caching the TVFS/encoding parse is where the win is.

Serialize the parsed lookup tables (path→hash map, encoding table, archive indices) to a binary cache file after first parse. On subsequent server starts, load from cache instead of re-parsing the raw CASC files. Invalidate when `.build.info` hash changes (game patch).

Expected cold-start improvement (after TVFS is implemented): **~200 ms → ~50 ms**.

**Effort:** S — serialization of hash maps to/from a flat binary format.

---

### ↳ Direct byte streaming over stdio

**Status:** 📋 Pending

Instead of writing extracted files to disk and returning a path, return raw file bytes over the stdio channel (base64-encoded in JSON, or a binary framing protocol). This allows the extension to pipe CASC file contents directly into the BLP decoder without intermediate disk I/O.

Useful for on-demand single-file extraction (e.g., a texture referenced in XML that isn't in the cache yet). Less useful for bulk extraction where disk output is the goal.

**Effort:** S

---

### ↳ DB2 file reading support

**Status:** 📋 Pending

Expose a `readFile` method that returns raw bytes from CASC by virtual path (not just extracts to disk). This unblocks the [Atlas manifest from DB2](backlog.md#atlas-manifest-from-db2-replace-wagotools) backlog item — `casc.readFile("dbfilesclient/uitextureatlas.db2")` returns a `Buffer` that the TypeScript DB2 parser consumes.

**Prerequisite:** Eliminate listfile dependency (TVFS gives path→hash for any file, not just Interface/ paths).

**Effort:** S — the `readFile` method is a subset of `extract`; it skips the disk write.

---

### ↳ Multi-platform CI build pipeline

**Status:** 📋 Pending

GitHub Actions workflow that cross-compiles `scryer-asset-server` for all four target triples, packages platform-specific `.vsix` files, and publishes to the marketplace. Required before the extension can be distributed to end users.

**Effort:** S–M — `cross` or `cargo-zigbuild` + `vsce package --target <platform>`.

---

### ↳ Performance benchmarking (server vs rustydemon-cli)

**Status:** 📋 Pending

Extend `dev/bench-casc-comparison.mjs` to benchmark `scryer-asset-server` alongside `rustydemon-cli` and `casc-extractor`. Measure cold start, warm request latency, and batch extraction throughput. The result becomes the evidence in the ADR for the migration.

**Effort:** XS

## Dependencies

**M3** (Asset Pipeline — the `AssetService` and `extractMissing` boundary this integrates with).

No dependency on other pending milestones. This milestone unblocks:

- [Atlas manifest from DB2](backlog.md#atlas-manifest-from-db2-replace-wagotools) (via the `readFile` sub-item)
- [Listfile fast index](backlog.md#listfile-fast-index-in-process--post-rustydemon-era) (becomes less relevant once TVFS eliminates the listfile)

## Verification Plan

### Automated Tests

- **Rust unit tests:** CASC server protocol parsing, request/response serialization, idle timeout logic.
- **TypeScript integration tests:** `CascClient` lifecycle — start, extract, crash recovery, idle shutdown, graceful deactivation.
- **End-to-end:** extract a known set of BLP files via the server, verify output matches `rustydemon-cli` output byte-for-byte.

### Manual Verification

- Extension activation with `scryer.installDir` configured → first preview triggers server start → textures load.
- Kill the server process externally (`kill -9`) → next texture request restarts it automatically.
- Leave the extension idle for >20 s → verify server exits (check process list).
- Extension deactivation (close VS Code window) → verify server exits gracefully.

## Effort

**M–L** (MVP server fork + TypeScript client + lifecycle management + basic CI for one platform). The sub-items add an additional L in aggregate but are independently schedulable.
