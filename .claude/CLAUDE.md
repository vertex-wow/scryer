# Scryer

World of Warcraft Addon Preview — Preview the result of XML frame definitions and Lua code.

## Directory rules

- `_live/` and `_reference/` — **read-only reference**. Never edit or write to these directories. They exist for reading/diffing only.
- `.plan/` — gitignored ephemeral scratchpad. Use for short-term task tracking only. Nothing here is permanent.
- `docs/` — checked-in permanent documentation. Always keep this up to date as decisions are made or the plan evolves.
- `dev/` — **developer tooling only** (not shipped with the extension). Contains thin CLI shims that call into `src/` libraries. Scripts here are TypeScript files (compiled via `dev/bench.build.mjs`). Any real logic that the extension needs must live in `src/`, not here. The `dev/` scripts exist for developer convenience (benchmarking, manual extraction runs, asset pipeline inspection) and assume Node is installed. Config is read from `dev/config.local.json` (gitignored; copy from `dev/config.json.example`).

## Documentation conventions

### `docs/plan/`
Implementation roadmap. One file per milestone (`000_overview.md`, `001_xml_parser.md`, etc.). Update these when scope, approach, or effort changes — they are the source of truth for what we're building and why.

When updating the milestone table in `000_overview.md`, maintain this invariant: **all completed `↳` rows must appear before the first pending milestone row, in chronological order.** A `↳` row marked ✅ Done that sits under a pending milestone is always wrong.

- **Adding a new pending backlog item:** Attach it under the pending milestone it relates to.
- **Adding a completed backlog item:** Insert it immediately before the first pending milestone, after the last completed row. **Always include a date:** use `✅ Done (YYYY-MM-DD)`.
- **Completing a backlog item:** Change its status to `✅ Done (YYYY-MM-DD)` and move it to immediately before the first pending milestone row.
- **After any table edit:** scan the full table and confirm no `✅ Done` row appears below any pending milestone row before closing the file.

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
When something is noticed during a task but is deemed out of scope — a bug, a useful enhancement, a follow-up refactor — record it before moving on:

1. Add a `↳` backlog row in the milestone table in `docs/plan/000_overview.md`, placed after the last completed milestone row (per the ordering rule above).
2. Add a full entry in `docs/plan/backlog.md` with a short description, the problem it solves, a rough plan, and an effort estimate.

Do not silently discard deferred items. They belong in `docs/` so they are visible and prioritizable rather than lost in conversation history.

## File editing rules

- **Prefer Edit or Write over `sed`/`awk` for file edits.** These tools are error-prone and can silently leave files in a broken state.
- Before running any `sed` or `awk` command that modifies a file, use `AskUserQuestion` to show the exact command and get approval first.
- `sed` and `awk` are fine for read-only operations (grepping, inspecting) without asking.

## Tooling

- **Package manager: `pnpm` only.** Never use `npm install` or `yarn` — they bypass the `onlyBuiltDependencies` allowlist and `minimum-release-age` security settings.
- **Building: `pnpm build` (esbuild).** Never use `tsc` to emit JS — it is typecheck-only (`pnpm typecheck` / `tsc --noEmit`).
- **Tests live in `test/`** (singular). The jest config, tsconfig.test.json, and vscode mock all assume this path.
- **vscode mock:** Any extension code that imports `vscode` is redirected to `test/__mocks__/vscode.ts` during tests. Expand stubs there as new APIs are needed — do not import the real `vscode` module in unit tests.
- **Always run `pnpm build` before handing off to the user for testing.** When a task is complete and the user is expected to test it, run `pnpm build` as the final step so they receive a ready-to-run artifact.

## Commit discipline

- Commit between each milestone completion.
- Include `docs/` updates in the same commit as the code they describe.
- Never commit implementation without updating the relevant plan file if the approach changed.
- **When ready to commit:** issue a single Bash tool call that chains `git add <files> && git commit -m "..."` — the tool permission prompt is the user's approval mechanism. Do not stage and commit in separate steps.
