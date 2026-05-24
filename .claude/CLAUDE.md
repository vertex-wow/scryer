# Scryer

World of Warcraft Addon Preview — Preview the result of XML frame definitions and Lua code.

## Directory rules

- `_live/` and `_reference/` — **read-only reference**. Never edit or write to these directories. They exist for reading/diffing only.
- `.plan/` — gitignored ephemeral scratchpad. Use for short-term task tracking only. Nothing here is permanent.
- `docs/` — checked-in permanent documentation. Always keep this up to date as decisions are made or the plan evolves.

## Documentation conventions

### `docs/plan/`
Implementation roadmap. One file per milestone (`000_overview.md`, `001_xml_parser.md`, etc.). Update these when scope, approach, or effort changes — they are the source of truth for what we're building and why.

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

## Commit discipline

- Commit between each milestone completion.
- Include `docs/` updates in the same commit as the code they describe.
- Never commit implementation without updating the relevant plan file if the approach changed.
