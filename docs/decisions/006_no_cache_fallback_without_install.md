# ADR 006 — No cache-only fallback when game files are unavailable

**Status:** Decided (2026-05-27)

## Context

Scryer's asset pipeline writes decoded textures and Blizzard template files to a persistent cache under `<cacheRoot>/<flavor>/`. Once fully warmed, this cache contains everything needed to render previews without touching the WoW install. This raised the question: should Scryer continue to work from cache alone when `scryer.installDir` points to a directory that no longer contains game files?

The motivating scenario is an addon developer who uninstalls or temporarily moves their WoW installation — their dev environment would keep rendering correctly from the warm cache rather than immediately breaking.

## Options considered

**Option A — Require game files; fail hard when absent**
The current behavior. If `installDir` is set but the game files are gone, extraction fails silently and textures that aren't already in cache show as placeholders.

**Option B — Fall back to cache when game files are absent**
If `installDir` is set but the game's `.build.info` is unreadable, treat the existing cache as authoritative and proceed. The cache-only path would be available at any of three warmth levels: no cache (failure, same as A), partial cache, or full cache.

## Decision

**Option A.** We do not implement a cache-only fallback.

## Rationale

The edge-case failure mode of Option B is worse than its happy path is useful:

- **Silent staleness.** If a user moves their game installation and forgets to update `scryer.installDir`, Option B would silently serve an increasingly out-of-date cache. With a slow-moving game (infrequent patches), this can go unnoticed for weeks. The user sees "working" previews that no longer match live game data, introducing subtle rendering bugs that are very hard to diagnose.

- **Communication is intractable.** Communicating the fallback state reliably to the user is hard. A status bar item could show "cache mode" but is easy to miss. A one-time popup on activation would need to fire on every startup when the install is gone, which becomes noise. An inline webview warning still leaves the user wondering whether the preview is trustworthy. No single mechanism cleanly conveys "your previews are from a cache that was last warmed N days ago against build X."

- **Scope is narrow.** The developers most likely to warm a full cache (`all-templates-textures`) are also the developers most likely to maintain a WoW install. Uninstalling WoW while actively doing UI addon work is uncommon enough that optimizing for it introduces more complexity than it saves.

## Consequences

- A user whose `installDir` path is broken gets placeholder textures for anything not in cache, which is the same degraded experience as today.
- If the game is uninstalled, the user must either restore it or clear `scryer.installDir` and accept placeholder-only mode.
- A future "game-less mode" where `installDir` is intentionally absent (rather than broken) remains open — the distinction between "never set" and "set but missing" is already in the code and the no-op paths are clean.
