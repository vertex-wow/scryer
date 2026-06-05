# Scryer

World of Warcraft Addon Preview — Preview the result of XML frame definitions and Lua code.

## Session start

Invoke `/caveman` at start of every conversation. If user turns it off during chat, leave it off — don't re-enable.

## Directory rules

- `_live/` and `_reference/` — **read-only reference**. Never edit or write to these directories. They exist for reading/diffing only.
- `.plan/` — gitignored ephemeral scratchpad. Use for short-term task tracking only. Nothing here is permanent.
- `docs/` — checked-in permanent documentation. Always keep this up to date as decisions are made or the plan evolves.
- `dev/` — **developer tooling only** (not shipped with the extension). Contains thin CLI shims that call into `src/` libraries. Scripts here are TypeScript files (compiled via `dev/bench.build.mjs`). Any real logic that the extension needs must live in `src/`, not here. The `dev/` scripts exist for developer convenience (benchmarking, manual extraction runs, asset pipeline inspection) and assume Node is installed. Config is read from `dev/settings.local.json` (gitignored; copy from `dev/settings.json.example`).

## Documentation conventions

### `docs/plan/`
Implementation roadmap. One file per milestone (`000_overview.md`, `001_xml_parser.md`, etc.). Update these when scope, approach, or effort changes — they are the source of truth for what we're building and why.

`000_overview.md` uses **one HTML `<table>` per milestone**, each under a `###` subheading. The table structure is:

- **Milestone row** — 6 columns (`#`, `Name`, `Status`, `Description`, `Effort`, `Depends on`), name in `<strong>`.
- **Completed ↳ row** — a single row with `↳` in col 1 and `colspan="5"` on col 2, containing a ✅ prefix followed by comma-separated `<a>` links to **backlog-archive.md** anchors. All completed backlog items for a milestone collapse into one row — no dates or descriptions in the table.
- **Pending ↳ rows** — full 6-column rows, one per item, with status emoji, description, effort, and depends-on filled in.
- **No ↳ milestones** — table contains only the milestone row.

**Editing rules:**

- **Adding a pending ↳:** Add a full 6-column `<tr>` below any completed ↳ row, under the milestone that enables or most naturally precedes it.
- **Completing a ↳:** Remove the full pending row. Add a link to it in the completed ↳ row's `colspan="5"` cell (create that row if it doesn't exist yet). No date needed in the table — dates live in backlog-archive.md. Move the full entry from backlog.md to backlog-archive.md.
- **After any table edit:** confirm no pending ↳ `<tr>` appears above the completed ↳ `<tr>` within the same `<tbody>`.

### `docs/decisions/`
Architecture Decision Records (ADRs). One file per significant decision (`001_language_stack.md`, etc.). Write an ADR whenever a non-obvious technical or architectural choice is made, especially when alternatives were seriously considered. Include: context, options considered, decision, rationale, and consequences. Do not delete old ADRs — mark them superseded if overturned.

### `docs/reference/`
Technical reference material derived from inspecting `_reference/` or `_live/`. Examples: WoW XML schema summary, API surface notes, format documentation. Update when new findings are made.

## Working on tasks — dual-track documentation

When actively implementing a milestone or working through a multi-step task, maintain **two layers** simultaneously:

### `.plan/` — transient running state (write often, disposable)
Keep a scratch file (e.g. `.plan/active.md` or `.plan/milestone_N.md`) updated as you go:
- What has been done so far in this session
- What step is currently in progress
- What is blocked or uncertain
- What comes next

Update this after every meaningful action (file written, test passed, decision made). This is working memory — if context is lost or the session ends mid-task, this file is how work resumes without starting over. It is **not** a permanent record; it gets discarded or overwritten when the task is done.

### `docs/` — permanent record (write when things are settled)
Update `docs/` when something is decided or completed:
- New finding about `_reference/` or `_live/` → `docs/reference/`
- Architecture or approach decision made → `docs/decisions/` ADR
- Milestone scope or approach changed → update `docs/plan/<milestone>.md`
- Milestone complete → verify the plan file matches what was built

**Never let a session end with discoveries or decisions only in conversation context.** If it matters beyond this task, it belongs in `docs/`.

### Deferring out-of-scope work
Any time future work is identified — during implementation, writing reference docs, code review, ADR drafting, or anything else — record it before moving on. This includes bugs, enhancements, refactors, hardening concerns, missing features, and risks.

**Signal to watch for:** if you write the words "future", "later", "eventually", "TODO", "not yet", or "out of scope" anywhere in a document or comment, stop and ask: does this belong in the backlog instead?

**Both steps below are required. Do not do step 2 without step 1.**

To record a deferred item:
1. **`docs/plan/000_overview.md` first** — add a pending `↳` row to the milestone table under the milestone that most naturally enables or precedes the work. This is the visibility step; skipping it means the item is invisible to anyone scanning the roadmap.
2. **`docs/plan/backlog.md` second** — add a full entry with a short description, the problem it solves, a rough plan, and an effort estimate. The overview row links here. When an item is completed, move its entry to `docs/plan/backlog-archive.md` and update the overview link to point at the archive.

Do not silently discard deferred items or bury them in reference doc prose. They belong in `docs/plan/` so they are visible and prioritizable rather than lost in a document someone may never re-read.

## defaults.json philosophy

All magic values used in the preview — WoW environment constants, rendering calibration values, and visual appearance of the preview chrome — live in `src/flavors/defaults.json`. Nothing is hardcoded in the source. This keeps every tunable value auditable in one place and makes it easy for contributors to submit patches that only touch defaults, or for advanced users to override the whole set via `scryer.flavorConfigPath`.

When adding new behaviour that involves a constant or threshold, always ask: does this belong in `defaults.json`? If it appears in the preview window (or directly affects it), the answer is almost certainly yes.

### User-facing documentation tiers

Configuration documentation is split across three files so users see only what is relevant to their use case:

- **`README.md`** — "batteries included" overview. A brief table of the key WoW display defaults that work out of the box. No tuning required.
- **`docs/configuration.md`** — Settings a typical addon developer might want to change: VS Code settings (`scryer.*`), the `flavorConfigPath` mechanism, and WoW-environment fields (screen resolution, font, text color, scale, rendering calibration).
- **`docs/advancedConfiguration.md`** — Minute details for extension contributors and anyone wanting to theme or visually tweak the preview chrome: viewport background, ruler appearance, status bar colors, placeholder tile style, layout solver parameters.

**When adding or changing any `defaults.json` field or `scryer.*` VS Code setting, update the correct documentation tier in the same change.** Do not ship a new setting without documenting it. Use this rule to pick the right file:

- Affects WoW environment or rendering fidelity → `docs/configuration.md`
- Affects preview chrome aesthetics (colors, sizes, layout solver) → `docs/advancedConfiguration.md`
- Worth a one-line mention for first-time users → also update the table in `README.md`

## File editing rules

- **Prefer your built-in edit/write tools over `sed`/`awk` for file edits.** Command-line tools are error-prone and can silently leave files in a broken state.
- Always use the workspace absolute path when accessing files.
- `sed` and `awk` are fine for read-only operations (grepping, inspecting) if needed.

## WoW API stub philosophy

Only stub things that do not exist in any Blizzard Lua file we load. See `docs/decisions/011_blizzard_lua_load_philosophy.md` for the full decision.

**Legitimate stubs** (C-layer only — no Blizzard Lua file defines these):
- `C_*` namespaces, `Mixin`, `CreateFromMixins`, `issecure`, `wipe`/`table.wipe`, `table.count`, `string.trim`/`strtrim`, `strsplit`, `strjoin`, `GenerateClosure`, `nop`
- Game state queries: `GetTime`, `GetLocale`, `UnitRace`, `UnitSex`, `IsAddOnLoaded`, etc.
- Globally C-populated tables: `Enum`, `Constants`
- Error/callstack internals: `SetErrorCallstackHeight`, `GetCallstackHeight`, etc.

**Not stubbed** — anything provided by a Blizzard Lua file we load (SharedXMLBase, Blizzard_Colors, SharedXML). If a Blizzard file fails, that is a hard error — not a reason to add a stub. Fix the missing C stub or fix the load order instead.

**Load order:** SharedXMLBase → Blizzard_Colors → SharedXML. If a file in our load list calls something from an addon we don't load, the fix is to add that addon to our preload list, not to shadow its exports.

## Tooling

- **Package manager: `pnpm` only.** Never use `npm install` or `yarn` — they bypass the `onlyBuiltDependencies` allowlist and `minimum-release-age` security settings.
- **Building: `pnpm build` (esbuild).** Never use `tsc` to emit JS — it is typecheck-only (`pnpm typecheck` / `tsc --noEmit`).
- **Tests live in `test/`** (singular). See `docs/testing.md` for the full picture. Two Playwright pipeline layers: `test/xml/` (XML Preview — static parse, no Lua) and `test/toc/` (Live View — full Lua execution). Unit tests catch root causes; webview protocol tests cover message mechanics.
- **Primary debugging loop:** When a rendering bug appears, create a minimal fixture → drop it in `test/xml/` (static XML, no Lua) or `test/toc/` (requires Lua execution) → add assertions for what correct output looks like → fix until green. The fixture IS the reproduction case. This is the fastest path from "something looks wrong" to "I know it's fixed."
- **XML preview fixtures** live in `test/xml/` alongside their spec. TOC live view fixtures use addon directories under `test/fixtures/`. `test/manual/` is for hand-checked fixtures only — never reference it from automated specs. When a manual fixture gets automated coverage, move it to `test/xml/` or `test/toc/` (whichever applies) in the same change that adds the spec.
- **`render.spec.ts` is protocol-only.** Only add tests there for webview message behaviors (ready, reload, requestAsset/assetResolved mechanics, z-index formulas) that have no XML equivalent. CSS output assertions (color, size, position, text alignment) belong in the `test/xml/` or `test/toc/` test for the fixture that defines them.
- **vscode mock:** Extension code that imports `vscode` is redirected to `test/unit/__mocks__/vscode.ts` during Jest tests. Expand stubs there when new APIs are needed — never import the real `vscode` module in unit tests.
- **Always run `pnpm build` before handing off to the user for testing.** When a task is complete and the user is expected to test it, run `pnpm build` as the final step so they receive a ready-to-run artifact.
- **`pnpm typecheck` must pass before any commit.** The pre-push hook enforces this — a failing typecheck blocks push. Run `pnpm typecheck` and fix all errors before staging.

## Commit discipline

- Commit between each milestone completion.
- Include `docs/` updates in the same commit as the code they describe.
- Never commit implementation without updating the relevant plan file if the approach changed.
- **When ready to commit:** wait for the user to explicitly say "commit" (or equivalent). Do not invoke `caveman-commit` or run any `git add`/`git commit` command proactively. When the user does ask: invoke the `caveman-commit` skill to generate the commit message, show it, then immediately issue a single terminal command that chains `git add <files> && git commit -m "..."` — the tool permission prompt is the user's approval mechanism. Do not stage and commit in separate steps. Do not ask "Proceed?" or seek any additional confirmation; "commit" is already the approval.
