# Scryer

World of Warcraft Addon Preview — Preview the result of XML frame definitions and Lua code.

## Directory rules

- `_live/` and `_reference/` — **read-only reference**. Never edit or write to these directories. They exist for reading/diffing only.
- `.plan/` — gitignored ephemeral scratchpad. Use for short-term task tracking only. Nothing here is permanent.
- `docs/` — checked-in permanent documentation. Always keep this up to date as decisions are made or the plan evolves.

## Documentation conventions

### `docs/plan/`
Implementation roadmap. One file per milestone (`000_overview.md`, `001_xml_parser.md`, etc.). Update these when scope, approach, or effort changes — they are the source of truth for what we're building and why.

When updating the milestone table in `000_overview.md`: backlog items (`↳` rows) are placed **after the last milestone completed before the work was done**, not after the milestone they were originally deferred from or assigned to. A backlog item sniped ahead of schedule must be moved (or inserted) before the next pending milestone — keeping all completed rows in chronological order above the pending ones.

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

## Tooling

- **Package manager: `pnpm` only.** Never use `npm install` or `yarn` — they bypass the `onlyBuiltDependencies` allowlist and `minimum-release-age` security settings.
- **Building: `pnpm build` (esbuild).** Never use `tsc` to emit JS — it is typecheck-only (`pnpm typecheck` / `tsc --noEmit`).
- **Tests live in `test/`** (singular). The jest config, tsconfig.test.json, and vscode mock all assume this path.
- **vscode mock:** Any extension code that imports `vscode` is redirected to `test/__mocks__/vscode.ts` during tests. Expand stubs there as new APIs are needed — do not import the real `vscode` module in unit tests.

## Commit discipline

- Commit between each milestone completion.
- Include `docs/` updates in the same commit as the code they describe.
- Never commit implementation without updating the relevant plan file if the approach changed.
- **When ready to commit:** present the proposed message and issue the `git add` + `git commit` as a single tool call so the user sees and approves it as one permission prompt. Do not stage and commit in separate steps.
