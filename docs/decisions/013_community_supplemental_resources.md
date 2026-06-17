# ADR 013 — Retrieval of community-maintained supplemental resources

**Status:** Accepted — 2026-06-16

## Context

WoW's asset format and game database require supplemental data that Blizzard does not
distribute with the game client. The WoW modding ecosystem has — over a decade or more —
built and publicly maintained a set of resources that fill this gap. These are produced
independently of Scryer, and independently of Blizzard, by community contributors who
work on CASC tooling as a whole.

Concretely, Scryer relies on two categories of 3rd-party produced resources:

1. **File-system manifests.** The CASC format identifies files by numeric ID; the community
   maintains public mappings of those IDs to human-readable paths. Without them, extracted
   files land on disk as unnamed blobs.

2. **Game database resources.** Certain game tables (atlas layout data, UI texture
   coordinates) are consumed directly by Scryer. The community publishes machine-readable
   exports of these tables that Scryer can use when local binary data is unavailable.

The question is not _whether_ to use these resources — the tool is not useful without them —
but _how_ to fetch, cache, and expose them to users.

## Community precedent

Automatically fetching community-maintained supplemental resources is a well-established
practice across the WoW modding tool ecosystem. The following established tools all do this:

| Tool                          | Role in the ecosystem                                                              | Est. first release |
| ----------------------------- | ---------------------------------------------------------------------------------- | ------------------ |
| **sereniaBLPLib** (Warpten)   | Reference BLP decoder library                                                      | 2012               |
| **CascLib** (ladislav-zezula) | Reference C library for CASC — the foundation most other tools build on            | 2014               |
| **TACTLib**                   | C# CASC/TACT implementation                                                        | 2018               |
| **wow.export** (wowdev)       | Asset export tool; reference implementation for much of Scryer's extraction design | 2019               |
| **casc-extractor**            | CLI CASC extraction tooling                                                        | 2019               |
| **rustydemon**                | CLI CASC extraction, predecessor tool Scryer replaced                              | 2022               |

The WoW modding community wiki has published format documentation (CASC, BLTE, TACT, DB2)
since at least 2013, reflecting that these formats and the tooling patterns around them have
been publicly understood and documented for over a decade.

wow.export — from which Scryer has drawn design guidance — fetches community-produced
supplemental resources on every startup with no TTL and no user notification beyond the
startup log. Its user base spans a significant portion of the active WoW addon-development
community.

## Decision

Scryer fetches community-maintained 3rd-party resources at startup, subject to the
following constraints:

**1. All endpoints are user-configurable.** Every URL is a VS Code setting:
`scryer.tactKeysUrls` and `scryer.atlasCsvUrls`. Users can inspect, override, add
fallbacks, or point at private mirrors without modifying any code. An empty list disables
the corresponding fetch. Defaults are documented in `docs/configuration.md`.

**2. Multiple URLs tried in order.** Settings accept an array; Scryer tries each in
sequence and uses the first successful response. This lets users add mirrors without
losing the primary source.

**3. Cached with build-version invalidation.** Fetched resources are written to
`.casc-meta/` alongside other local extraction state. Cached copies are reused across
sessions and only re-fetched when the WoW build version changes or a rolling expiry
window elapses. No redundant network requests between sessions on the same build.

**4. Local data is preferred where available.** Where a locally-installed binary source
produces equivalent results (e.g. reading game databases directly from the user's CASC
archive), Scryer uses it. Community-provided exports are a fallback, not the primary path.

**5. Graceful failure, not silent failure.** When a community resource is temporarily
unavailable, Scryer falls back to a cached copy if one exists. When cached copies are
absent and all URLs fail, Scryer surfaces the condition as a user-visible notification
rather than silently degrading. The user can then act (check connectivity, configure an
alternate URL, or wait for the resource to come back online).

## Transparency model

Scryer is explicit about its outbound activity:

- **Game file CDN fetches** (Blizzard's servers, battle.net installs only) require
  explicit user consent at runtime — see ADR 012.
- **Community supplemental resources** (3rd-party infrastructure, not Blizzard) are
  fetched automatically using URLs that are fully documented, user-configurable, and
  disclosed in `docs/configuration.md`. User control is provided through settings rather
  than a blocking prompt, consistent with how comparable developer tools operate.

This is the same model used by package managers, language servers, and other developer
tooling that fetches index data or manifests at startup: the behavior is documented, the
endpoints are configurable, and the user can disable or redirect the fetches at will.

## Alternatives considered

**Bundle resources statically.** Include a snapshot with the extension. Rejected: game
patches cause snapshots to become stale within days, producing silent failures for users
on current builds. The community resources exist precisely because a maintained, live
source is more useful than any static snapshot.

**Require manual user configuration.** Ask users to provide their own copies on first
use. Rejected: new-user experience degrades significantly; no comparable tool in the
ecosystem imposes this.

**Prompt before every download.** A consent gate for community resource fetches. Rejected:
this is not standard practice for developer tools fetching supplemental metadata (contrast
with CDN game-content fetches in ADR 012, where the user is being asked to authorize
outbound access to Blizzard's servers using coordinates from the game install). Community
resource endpoints are 3rd-party public infrastructure; the appropriate transparency
mechanism is documentation and URL configurability, not a blocking modal.

## What this does not cover

- CDN fetches of game content from Blizzard's servers: see ADR 012.
- The community listfile (file ID → path mappings): fetched by the Rust CASC server as
  part of extraction setup, governed by the same principles as this ADR.
