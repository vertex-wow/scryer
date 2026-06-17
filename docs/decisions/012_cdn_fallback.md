# ADR 012 — CDN fallback policy for game asset extraction

**Status:** Revised (2026-06-10) — original decision (local-only) replaced by CDN-with-consent

## Original decision (2026-06-09): local files only

During initial development it was observed that approximately 55% of Blizzard interface
files (229 of 418 matched) failed extraction because Battle.net tracks file metadata in
the local `.idx` index even for content it hasn't downloaded yet. These "CDN-only stubs"
cause BLTE decode to fail with `InvalidMagic`. The previous extraction tool
(rustydemon-cli) silently fetched these files from Blizzard's CDN.

The original decision was **Option B — local files only**: only extract files physically
present in the local CASC archives, report stubs as `skipped:cdn-only`, and tell the user
to run Battle.net → Scan & Repair.

**Original rationale (preserved):**

- Respect user storage choices (Battle.net allows selective/minimal installs)
- Keep `casc-lib` as a local CASC reader, not a CASC+CDN client
- No outbound network dependency for an offline-capable developer tool
- Transparency: missing file → placeholder + log, not a silent download
- The "correct fix" was assumed to be completing the WoW download

## Why the decision was revised

Testing confirmed that **Scan & Repair does not fill CDN-only stubs**. They remain stubs
after a full repair. On a default Battle.net installation the 229 unavailable files are
unrecoverable by any local action the user can take. The recommended user action in the
original decision simply does not work.

More critically: the files affected are not cosmetic. They are Blizzard's own interface
templates — the XML and Lua that defines `NineSlicePanelTemplate`, `UIPanelButtonTemplate`,
`TooltipDefaultLayout`, and the `SharedXML`/`Blizzard_FrameXML` Lua environment. Without
them Scryer cannot:

- Resolve template inheritance (`inherits="NineSlicePanelTemplate"` renders unstyled)
- Trace addon callsites (no definition of what `CreateFrame(... "UIPanelButtonTemplate")`
  produces)
- Load the Blizzard Lua environment that virtually every WoW addon depends on

This is not a degraded state — it is the normal state for most users on default installs,
and it breaks the tool's central purpose.

## Revised decision (2026-06-10): CDN fallback with user consent

Implement CDN fallback for Battle.net installs, gated behind an explicit user consent
preference (`scryer.cdnFallback`: `"ask"` / `"cdn"` / `"none"`, default `"ask"`).

- **`"ask"`** — Show a one-time modal dialog on first encounter. Store the user's answer
  permanently; never ask again.
- **`"cdn"`** — Fetch CDN-only stubs automatically.
- **`"none"`** — Never fetch from CDN; report stubs as unavailable.

Dialog text (factual, does not minimise the nature of the request):

> One or more game files for previews can be found in your WoW installation's index but
> have not been downloaded by Battle.net. Scryer can fetch them directly from
> Blizzard's CDN.
>
> Do you want to download missing files from Blizzard's CDN?
>
> [Yes, do that from now on] [No, use placeholders]

## What makes this defensible

Several factors constrain the CDN fetch tightly enough that it differs meaningfully from a
general game-file downloader:

1. **Local-install-gated.** The CDN client is only created after a local CASC archive is
   successfully opened (root manifest, encoding table, and IDX files all present). There is
   no path to CDN content without a valid local install.

2. **CDN coordinates come from Blizzard.** The host list and path prefix are read from
   `.build.info`, a file Battle.net itself writes into the install directory. Scryer is
   following Blizzard's own signposting.

3. **Battle.net installs only.** Steam installs do not include `CDN Hosts` / `CDN Path` in
   `.build.info`. If those fields are absent, the CDN client is not created and no outbound
   fetch ever occurs — enforced by the data, not by policy logic.

4. **Scoped to the local encoding table.** Only blobs whose encoding key (EKey) already
   appears in the local CASC encoding table can be fetched. Scryer cannot enumerate or
   download arbitrary game content.

5. **Ecosystem precedent and game accessibility.** rustydemon-cli implements the same
   fallback. wow.export goes further: it offers CDN fetching from the first screen with no
   local install required at all. WoW is distributed as a free trial with no purchase
   required. The files in question are interface templates, not premium content.

## ToS / terms of use

This is a grey area and we do not claim otherwise. The WoW EULA broadly prohibits
"unauthorized third-party programs" accessing Blizzard services, and "services" could
plausibly be read to include the CDN. The game client performs these same fetches, but as
licensed software acting as Blizzard's agent — that permission does not automatically
extend to third-party tools.

At the same time, Blizzard's CDN serves content-addressed blobs over plain HTTP with no
authentication. The use case here — a developer tool fetching interface templates to
preview an addon the user is writing — is far removed from the harms the EULA targets
(botting, competitive automation, circumvention of purchase).

We are being as conservative as the use case allows:

- Requires a valid local install
- Uses only Blizzard-provided CDN coordinates
- Fetches only files referenced in the local encoding table
- Requires explicit user consent
- Does not apply to Steam installs

Because we prompt the user, we owe them honesty about the ambiguity. The dialog must not
misrepresent what is happening. Scryer surfaces the question; the user makes the call.

## What does not change

- Community-maintained 3rd-party resources (file-system manifests, game database exports)
  are fetched automatically using user-configurable URLs — see ADR 013 for the full
  rationale and transparency model. These are not Blizzard game content and are not
  covered by this ADR.
- Files absent from the local encoding table entirely are still reported as unavailable.
- CDN blobs are cached locally, content-addressed, so each file is fetched at most once.
- `casc-lib` gains a CDN client component but remains scoped to EKey-addressed blob fetch —
  it is not a general HTTP client.
