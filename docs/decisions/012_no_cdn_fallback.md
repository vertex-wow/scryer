# ADR 012 — No CDN fallback; only locally-present game files

**Status:** Decided (2026-06-09)

## Context

The scryer-asset-server reads WoW game files from the user's local CASC archives (`Data/data/data.NNN`). During development it was observed that approximately 55% of Blizzard interface files (229 of 418 matched) fail extraction with:

```
Invalid magic: expected BLTE, found <garbage bytes>
```

The cause is that WoW's Battle.net streaming client tracks file metadata (EKey entries) in the local `.idx` index files even for content that has not been downloaded yet. When those entries are read, the data at the archive offset is not valid BLTE — it is either a CDN placeholder stub or leftover bytes from an adjacent entry. These are called "CDN-only" files.

The previous extraction tool (rustydemon-cli) silently fetched CDN-only files over HTTP using the CDN URLs embedded in `.build.info` (`cdn_hosts`, `cdn_path`). This masked the problem: previews appeared to work but relied on outbound network access that Scryer's design doc (see `docs/decisions/004_license.md` and security model in `README.md`) does not budget for.

## Options considered

**Option A — CDN fallback**  
When local BLTE decode fails, construct the CDN URL from the EKey and download the file over HTTPS. `reqwest` (blocking) is already a dependency of `casc-lib`. The CDN URL format is:

```
https://<cdn_host>/<cdn_path>/data/<ekey[0:2]>/<ekey[2:4]>/<full_ekey_hex>
```

Pro: transparent, matches rustydemon-cli behavior, fixes missing files automatically.  
Con: outbound network dependency; introduces latency on on-demand asset requests (1–5 s per file); Blizzard CDN terms of use are unclear for tooling; makes extraction depend on internet connectivity and CDN availability; creates a silent data-freshness risk if CDN content diverges from the build hash.

**Option B — Local files only; degrade gracefully**  
Only extract from files physically present in the user's CASC archives. Files that fail BLTE decode are logged as `skipped:cdn-only` (or `errors`, as currently) and are absent from the output directory. The extension shows placeholder textures for anything it cannot extract.

**Option C — Fetch Lua/XML sources from a GitHub mirror (e.g. wowdev/wow-ui-source)**  
Download missing Blizzard interface files (Lua, XML) from a public WoW UI source mirror at extension install or build time. Since these are plain text files, no BLTE decoding is needed, and the download could be done from TypeScript rather than `casc-lib`.

Pro: fixes missing Lua/XML files without touching the CDN; source is publicly available.  
Con: still requires outbound network access; introduces a dependency on a third-party GitHub mirror that Scryer does not control and that could go stale, be renamed, or disappear; establishes a precedent that Scryer fetches game data from external sources; Blizzard's copyright applies to these files regardless of hosting.

**Option D — Hardcode known templates (e.g. `NineSlicePanelTemplate`) in the extension**  
Embed a minimal hand-written definition of critical Blizzard templates directly in Scryer's source, allowing template inheritance to work even when the source files are absent.

Pro: zero network dependency; always available.  
Con: embedding Blizzard's copyrighted code in Scryer's source would complicate the license. Even a "minimal stub" is a derived work of WoW's UI layer. Maintenance burden: any Blizzard update that changes the template signature would silently break the stub. Scope creep: once one template is hardcoded, the list grows.

## Decision

**Option B.** Scryer only extracts from files the user has actually downloaded. No CDN fallback, no outbound asset fetching, no fetching from GitHub mirrors, and no hardcoded Blizzard resources.

## Rationale

- **Respect the user's storage choices.** Battle.net allows selective downloading — users can choose a minimal install footprint. Scryer should not silently override that choice by fetching files the user chose not to download.

- **No network dependency.** Scryer is an offline-capable developer tool. Asset extraction must work without internet access. Introducing any remote fetch (CDN, GitHub mirror, or otherwise) creates a dependency on external availability, connectivity, and DNS — all of which can fail silently.

- **No external mirrors.** Fetching from `wowdev/wow-ui-source` or any other GitHub mirror of Blizzard's interface files is not materially different from fetching from Blizzard's CDN: it still requires outbound network access, depends on a resource Scryer does not control, and carries the same copyright. The fact that the payload is plain text rather than BLTE-encoded binary does not change the analysis.

- **No hardcoded Blizzard resources.** Embedding copies or stubs of Blizzard's copyrighted Lua/XML in Scryer's source introduces license complexity and a maintenance burden. Any Blizzard update that changes a hardcoded definition silently breaks the stub, and the list of "necessary" hardcoded files grows without bound. The right fix is always for the user to have a complete WoW installation.

- **Transparency over magic.** When a file is missing, the correct behavior is to tell the user (placeholder texture, log entry) rather than to fetch it automatically. The user can fix the root cause by opening the Battle.net launcher and completing the WoW download.

- **Security model.** Scryer's sandbox design (see `docs/decisions/004_license.md`) assumes no outbound network requests from the asset pipeline. Any remote fetch would violate this.

- **Scope.** `casc-lib` is a local CASC reader, not a CASC+CDN client. Adding any remote-fetch capability would significantly expand its scope and maintenance surface.

## Consequences

- Files not locally cached by Battle.net will not be extractable. This includes, on a minimal WoW install, many Blizzard interface XML/Lua files and Western fonts (`FRIZQT__.TTF`, `ARIALN.TTF`, etc.).
- Previews that depend on those files (e.g. `NineSlicePanelTemplate` templates, `TooltipDefaultLayout` layouts) will degrade to placeholder/unstyled frames until the user runs a full WoW download.
- The `scryer-asset-server` should distinguish CDN-only misses from genuine extraction errors — reporting them as `skipped:cdn-only` rather than `errors`, so the stats remain meaningful and the log is not alarming.
- A future "install completeness check" (telling the user which content categories are missing and prompting them to run the Battle.net launcher) is the recommended user-facing improvement, not automatic CDN fetching.
